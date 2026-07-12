# ADR — integration-credential storage (where OAuth tokens live)

**Status:** Proposed — 2026-07-12 → Accepted on merge
**Deciders:** Oskar (owner) · platform
**Relates to:** [#892] (this decision), [#247] (Xero connect — blocked on this),
[#886] (Xero milestone 1), [#310] (Epic 17 integration framework), [#897] (human
env setup).
**Extends:** [payroll-boundary-adr.md](payroll-boundary-adr.md),
[data-ownership-map.md](data-ownership-map.md),
[supabase-storage-migration-adr.md](supabase-storage-migration-adr.md),
[supabase-rls-access-matrix.md](supabase-rls-access-matrix.md),
[../supabase-environment.md](../supabase-environment.md).

## Context

[#247] needs a server-side store for Xero OAuth state: an access token
(~30 min TTL) and a **single-use rotating refresh token** (60-day idle expiry —
every refresh mints a new one and invalidates the old). Losing a rotated
refresh token, or having two serverless instances race a rotation, bricks the
connection until a human re-consents.

No home for this exists. The repo has **no encryption-at-rest utility** (all
`crypto` usage is hashing/HMAC/token generation), no credential table, and no
doc naming a store. The two incumbent stores both fail the requirement:

- **Vercel Blob** (`api/_lib/blob.js`): a 5s TTL read cache plus optimistic
  `expectedRev` that "narrows but can't eliminate" races — Vercel Blob has no
  true compare-and-swap. A stale cached read of a rotated refresh token is not
  an edge case here; it is the normal shape of concurrent serverless refresh.
- **Env vars**: correct for *static* secrets (`XERO_CLIENT_ID`,
  `XERO_CLIENT_SECRET`) but structurally unable to hold values that change at
  runtime.

Meanwhile the Supabase path is already built for exactly this class of data:
server-only service-role SQL via `api/_lib/supabase-db.js` (Supavisor :6543,
`{max:1, prepare:false}`), the fail-closed `assertSupabaseAccess()` environment
guard, RLS-enabled-zero-policy tables, and reviewed migrations.

## Decision

1. **Integration credentials live in Postgres (Supabase)** — a new table
   **`integration_connections`**, provider-generic (first row: `provider =
   'xero'`), created by a reviewed migration in [#247]'s PR sequence. Epic 17
   ([#310]) reuses this table rather than building its own.
2. **Shape (schema intent — final DDL reviewed in the migration):** one row per
   `(tenant_id, provider)`: `tenant_id`, `provider`, `external_tenant_id` (the
   selected Xero organisation), `access_token_enc`, `refresh_token_enc`,
   `access_token_expires_at`, `granted_scopes`, `status`
   (`connected | degraded | refresh_failed | reconnect_required | disconnected`),
   `last_success_at`, `last_refresh_at`, **`refresh_version`** (monotonic
   integer — the rotation lock), `created_at`/`updated_at`, audit-friendly
   `connected_by`.
3. **Application-layer encryption, AES-256-GCM.** Token columns store
   ciphertext only (`*_enc`); the key is **`XERO_TOKEN_ENC_KEY`** (32 bytes,
   base64, per-environment, server-only, never `NEXT_PUBLIC_*`). A small shared
   utility (suggested seam: `api/_lib/secret-box.js` — encrypt/decrypt with
   versioned key id) ships with the migration; nothing else in the codebase may
   decrypt these columns. Plaintext tokens never appear in Postgres, logs,
   audit entries, sync records, or client bundles.
4. **Rotation concurrency = optimistic version CAS, persist-before-use.** A
   refresh does: read row → call Xero → `UPDATE … SET tokens, refresh_version =
   refresh_version + 1 WHERE id = … AND refresh_version = <read value>`. Zero
   rows updated means another instance already rotated — **re-read and use its
   tokens, do not retry the Xero call**. The new refresh token is persisted
   **before** the new access token is used (per [#247]'s audit comment), and
   `invalid_grant` gets one re-read-then-retry before declaring
   `reconnect_required`. No advisory locks, no cross-instance mutex — the CAS
   is the lock.
5. **Access class: service-role-only.** RLS enabled with **zero policies for
   `authenticated` — permanently**, not just Phase A: unlike `payroll_runs`
   (admin-or-nothing *reads*), no tier ever reads this table through RLS. All
   access is server-mediated; admin UI ([#247]'s health surface) sees derived
   status fields only, never token material.
6. **Disconnect = revoke + delete + audit.** Disconnecting revokes the grant at
   Xero where the API allows, deletes the row (no soft-delete — dead ciphertext
   is a liability, not history), and writes an audit entry recording actor and
   provider. Reconnect inserts a fresh row.
7. **The Pro/PITR gate does not block this table.** The Supabase ADR's P0 gate
   ("Pro + PITR before any real data lands") protects *irreplaceable business
   data*. Connection rows are **re-creatable secrets** — worst-case loss is one
   admin re-consenting — so [#247] may ship to the dev/preview Supabase project
   now. The gate still fully applies to `payroll_runs` rows ([#893]).
   **Prod enablement of [#247] does require prod `SUPABASE_DB_URL` wiring**
   (production Supabase is currently unplugged) — tracked on [#897].

### Environment-variable contract (extends `supabase-environment.md`)

| Variable | Required | Notes |
|---|---|---|
| `XERO_CLIENT_ID` | yes (per env) | From the Xero developer app. **Separate app per environment** — Xero requires exact registered redirect URIs, so preview and production cannot share an app. |
| `XERO_CLIENT_SECRET` | yes (per env) | Server-only. Set in Vercel per environment — never a single shared value. |
| `XERO_TOKEN_ENC_KEY` | yes (per env) | 32-byte base64. Per-environment keys — a preview leak must not open production ciphertext. Rotation: re-encrypt in place or force reconnect (documented as an operator note in [#247]). |

The existing defence-in-depth applies unchanged: per-environment Vercel
scoping, `assertSupabaseAccess()` cross-checks, and
`SUPABASE_ALLOW_PRODUCTION_WRITES` for prod writes.

## Implemented (#247)

The migration is `supabase/migrations/20260712100000_integration_connections.sql`
(table as decided; envelope-prefix CHECKs on the token columns). The utility is
`api/_lib/secret-box.js` (v1 envelopes, AAD `integration:xero:<access|refresh>`),
the store is `api/_lib/xero/token-store.js`, the shared client
`api/_lib/xero/client.js`, routes `api/xero/{connect,callback,status,organisations,disconnect}.js`,
flag `xero_connection`, admin surface `/settings/integrations/xero`.

## Consequences

- **Positive:** [#247] builds on a store with real CAS semantics; the
  rotation race is solved structurally, not by cache-TTL luck. One
  credential home serves every future integration ([#310]).
- **P7/P8 obligations carry over:** a failed refresh becomes a visible
  `degraded`/`reconnect_required` status with a reconnect path — never a
  silent retry loop, never a hidden dead integration.
- **Cost:** [#247] gains a hard dependency on Supabase connectivity in every
  environment it runs in (preview → dev project; prod → the [#897] wiring
  step). Given production Supabase is already the committed direction, this
  buys safety without adding a vendor.
- **Data minimisation:** the table holds connection state only — no Xero
  business data, no PII, no payroll figures.

## Constitution gate

Storage placement is an architecture/fact-tier decision under the existing
payroll-boundary ADR — **no Phil-constitution amendment required**; no field
surface changes. It serves P7 (honest connection state) and P8 (degradation
stated, not hidden) and follows the Supabase ADR (new canonical domains go
Postgres-first). Repo-docs PR first; **wiki sync after merge** (Decision Log,
per the wiki-touch rule).

## Alternatives considered

- **Vercel Blob (`xero/connection.json`)** — *rejected*: 5s read cache + no
  true CAS is exactly wrong for single-use rotating refresh tokens; the
  known-race would be load-bearing.
- **Env-vars only** — *rejected*: cannot store values that change at runtime;
  kept for the static client id/secret/key, which is their correct role.
- **External secret manager (Vault/Doppler/AWS SM)** — *rejected as
  speculative*: a new vendor, new failure domain and new ops surface for one
  small table the existing Postgres path handles with better transactional
  semantics.
- **Supabase Vault / pgsodium** — *deferred*: attractive (keys never touch app
  code) but adds a Supabase-specific extension dependency ahead of need;
  application-layer AES-GCM keeps the utility portable. Revisit if key
  handling grows beyond one key id.
- **Postgres advisory locks for rotation** — *rejected*: connection-scoped
  locks are awkward through a transaction pooler in `{max:1}` serverless
  clients; the `refresh_version` CAS achieves the same guarantee with plain
  SQL.

[#247]: https://github.com/oskar-ott/BuhlOS/issues/247
[#310]: https://github.com/oskar-ott/BuhlOS/issues/310
[#886]: https://github.com/oskar-ott/BuhlOS/issues/886
[#892]: https://github.com/oskar-ott/BuhlOS/issues/892
[#893]: https://github.com/oskar-ott/BuhlOS/issues/893
[#897]: https://github.com/oskar-ott/BuhlOS/issues/897
