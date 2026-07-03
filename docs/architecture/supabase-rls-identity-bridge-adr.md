# ADR — the RLS identity bridge (server-minted, per-request, fresh-record JWTs)

**Status:** Proposed — 2026-07-03 → Accepted on merge
**Deciders:** Oskar (owner) · platform
**Relates to:** [#153] (RLS policies), [#152] (import), [#155], [#160].
**Extends:** [supabase-storage-migration-adr.md](supabase-storage-migration-adr.md),
[supabase-migration-roadmap.md](supabase-migration-roadmap.md),
[../supabase-environment.md](../supabase-environment.md).
**Consumed by:** [supabase-rls-access-matrix.md](supabase-rls-access-matrix.md)
and the policy migration
[20260703230000_phase1_rls_policies.sql](../../supabase/migrations/20260703230000_phase1_rls_policies.sql).

## Context

RLS policies need an identity in the request JWT. BuhlOS/Phil auth is NOT
Supabase Auth: it is bcryptjs + an HMAC-signed cookie holding
`{ userId, role }` (api/_lib/auth.js), and — critically — **the cookie's role
is never trusted for authorization**. `requireAuth` → `getCurrentUser`
re-reads users.json on **every request**, so a demotion or a disabled account
takes effect on the very next request, mid-session.

A naive bridge (mint a long-lived Supabase JWT at login, echo the cookie's
role into it) would silently make RLS-gated reads **weaker than today's API
layer** for up to the token lifetime. That downgrade is the failure mode this
ADR exists to forbid.

## Decision

When a server code path queries Postgres **as the user** (PostgREST or a
non-service connection), it mints a JWT **per request**, inside the handler,
**after** `getCurrentUser()` has resolved the fresh users.json record:

- **Mint from the FRESH record, never the cookie.** Claims derive from the
  users.json row read in the same request (the record `requireAuth` already
  fetched — no extra read). The cookie contributes only the userId lookup
  key, exactly as today.
- **Claims:** `sub` = `user_profiles.id` (the PG uuid mapped from the legacy
  user id — the issue's `user_id`); `tenant_id`; `tier` ∈
  `admin | leading_hand | field | client`, computed by the canonical
  api/_lib/auth.js tier sets via `normaliseRole` (the issue's `role(tier)` —
  the literal `role` claim is reserved by PostgREST for the database role and
  is always `authenticated`); `iat`/`exp`.
- **TTL ≤ 60 seconds, no refresh, no storage.** The token lives for one
  request, is never set as a cookie, never sent to the browser, never cached.
  If a future browser-direct read path ever ships, it re-mints per fetch from
  a server endpoint under the same rule — short-TTL from the fresh record.
- **Signing:** HS256 with the project JWT secret (dev secret for dev), held
  server-side only, alongside the existing `SUPABASE_*` env contract in
  docs/supabase-environment.md.
- **Disabled/archived users get no token** — `getCurrentUser` already returns
  null for them, so the mint point is unreachable.
- **The owner sentinel (`__owner__`) and service jobs don't use the bridge**:
  synthetic/platform paths stay on the service-role connection (RLS bypass),
  as all API traffic does today.

## The freshness invariant (the property, stated once)

> Every claim in a minted JWT is derived from the users.json record read in
> the same request that uses the token. RLS therefore reflects a role change,
> disable, or archive with exactly the same latency as the API layer today:
> the next request.

Clock skew: with ≤60 s TTL, minting and querying happen in the same process
within milliseconds; PostgREST default leeway absorbs residual skew. Do not
"fix" skew by lengthening TTL — that trades the invariant away.

## Consequences

- Per-request minting is CPU-trivial (one HMAC) and adds no I/O — the fresh
  read already happens in `requireAuth`.
- Nothing adopts Supabase Auth; users.json remains the credential store
  (Phase 1 schema deliberately holds no hashes).
- Policies can key on `tier` without re-implementing role normalisation in
  SQL — the tier sets stay single-sourced in api/_lib/auth.js/roles.ts.
- The allow/deny suite (`scripts/rls-policy-tests.js`) mints its own
  short-TTL JWTs the same way, so tests exercise the exact claim shape.
- Nothing in this ADR turns on a client read path; it only fixes the identity
  contract any future path must use (per-domain cutovers are separate
  decisions, sibling of #152).
