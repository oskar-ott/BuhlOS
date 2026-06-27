# Supabase read-enablement — operator runbook

> **Audience:** an operator with Supabase org access **and** Vercel project access.
> This is the ordered, gated checklist to take the **already-merged, all-dark**
> Supabase read estate from "prod-inert" to "serving reads from Postgres, one tier
> at a time, with instant rollback." The **repo side is done** — every read overlay,
> probe, flag and diagnostic is on `main` and default-OFF; every remaining step is an
> **operator/cloud action** that cannot be a code PR and must not be faked.
>
> **Picks up where [supabase-foundation-runbook.md](../supabase-foundation-runbook.md)
> (#532) ends.** That runbook stands up *connectivity* (CLI link, hardening
> migration, dev project, per-env Vercel wiring, Pro upgrade). Do **not** start here
> until its Gates 1–5 are green. The variable contract + fail-closed guard are
> authoritative in [supabase-environment.md](../supabase-environment.md). Sequence
> rationale: [supabase-migration-roadmap.md](supabase-migration-roadmap.md).
> Part of [#152].

## Where we are (repo state — already on `main`, do NOT redo)

The whole **read estate is merged and dark.** Each overlay keeps **Blob
authoritative** and serves Postgres only when it is **byte-faithful to Blob for
that job** (else Blob fallback) — so every flag below is **safe to enable and
safe to leave off**; flipping one on can only ever (a) serve identical bytes from
PG where parity holds, or (b) fall back to Blob. Nothing here makes Postgres the
source of truth (that is a separate, later ADR — see "Out of scope").

| Domain | Dual-write (keeps PG fresh) | Read flags (admin-first) | Live readiness probe on `/jobs-read-status` |
|---|---|---|---|
| Jobs structure | `supabase_dual_write_jobs` (J8) | `supabase_read_jobs` (J6, admin) · `supabase_read_phil_jobs` (J7, field) | admin jobs probe (parity / faithful counts) |
| Task status | `supabase_dual_write_tasks` (J9, cron every 10 min) | `supabase_read_admin_tasks` (J11) · `supabase_read_phil_tasks` (J10) | task-status probe (`readyForPromotion`) |
| Evidence metadata | **import-only — no PG mirror yet** (see caveat) | `supabase_read_admin_evidence` · `supabase_read_phil_evidence` | evidence probe (`readyForOverlay`) |
| Hours | `supabase_dual_write` (hours pilot) | `supabase_read_hours` | hours parity (`scripts/importers/hours-parity.js`) |
| Connectivity | — | `supabase_read_health` (gates `GET /api/supabase-health`) | the health endpoint itself |

All flags resolve **env `FLAG_<UPPER>` > `flags.json` blob override > default(false)**
([feature-flags.md](../feature-flags.md)). **Rollback for any read flag is
instant and deploy-free:** set it OFF (flags.json override or remove the env), and
the next read is pure Blob again.

> **Reality check:** production Postgres (`wetctlrhsycfwhuxlarv`) currently holds
> the schema with **zero rows**. A read flag enabled against empty PG is harmless
> (every job parity-fails → Blob) but **pointless** — it serves nothing from PG.
> The value only appears once prod PG is **populated and kept fresh** (Phase 2),
> so the phases below are strictly ordered: prove connectivity → populate + dual-write
> → only then flip read flags.

## Prerequisite — rotate the production DB password (do this FIRST)

The production database password was exposed in chat earlier in this project.
**Rotate it before wiring `SUPABASE_DB_URL` into any Vercel scope.** In the
Supabase dashboard: Project `wetctlrhsycfwhuxlarv` → Database → reset the database
password → rebuild the **transaction-pooler (6543)** connection string from the new
password → that string is what goes into the Vercel **Production** `SUPABASE_DB_URL`
(Phase 1). Never paste the URL anywhere it could be logged.

- **Gate 0:** old password no longer authenticates; the new pooler URL is held only
  in Vercel's encrypted env store (Production scope). Foundation runbook Gates 1–5
  green (link, hardening migration, dev project, per-env wiring, **Pro plan**).

## Phase 1 — prove read-only connectivity in production (no data needed)

Goal: confirm the guard → pooler → client path works in the real Production
runtime, while PG is still empty and **no write opt-in exists**.

1. Confirm Production env: `SUPABASE_ENV=production`,
   `SUPABASE_PROJECT_REF=wetctlrhsycfwhuxlarv`, `SUPABASE_DB_URL=<new prod pooler URL>`,
   and **`SUPABASE_ALLOW_PRODUCTION_WRITES` UNSET** (reads only for now).
2. Enable `supabase_read_health` (Production scope) and call `GET /api/supabase-health`.
3. **Gate 1:** the health endpoint returns OK (guard passed, pooler reachable,
   read query ran). Supabase **advisors** show no new security warnings. If it
   throws `PROD_REF_IN_NON_PROD_RUNTIME` or a guard error, STOP — the env wiring is
   wrong; fix before proceeding.
4. Leave `supabase_read_health` on (or turn it back off — it serves only the probe).

## Phase 2 — populate prod PG and keep it fresh (writes — needs the opt-in)

Read overlays only serve PG where PG matches Blob, so PG must first be backfilled
from the authoritative Blob and then kept in lockstep by the dual-writers.

> Writes to production PG require **`SUPABASE_ALLOW_PRODUCTION_WRITES=true`**
> (exact lowercase) in the Production scope (and in any operator shell that runs an
> importer). This is the one and only place that opt-in is set. **Do not set it
> until this phase; keep it set thereafter only because the dual-writers need it.**

### 2a. Backfill (operator import session, in dependency order)

Run the importers against production **in this order** (each builds on the prior;
each has a sync-check that must read **IN SYNC** before moving on):

```
structure-import.js   → structure-sync-check.js   # jobs / area-groups / areas / templates
tasks-import.js       → structure-sync-check.js   # task instances + status events
evidence-import.js    → structure-sync-check.js   # evidence_files + evidence_links (metadata only; bytes stay in Blob)
hours-import.js + allocations-import.js → hours-sync-check.js
```

- **Dry-run before every real import** and read the report first:
  `structure-dry-run.js` and `hours-dry-run.js` are dry-run twins of their imports;
  `tasks-import.js` / `evidence-import.js` dry-run by **omitting `--write`** (they
  apply only with `--write`). `task-projection-dry-run.js` is a separate, earlier
  task-expansion validation (it checks the template→instance projection is clean),
  not the dry-run of `tasks-import.js`.
- **Gate 2a:** every sync-check reports **IN SYNC** (zero `only_in_blob` /
  `only_in_pg` / `mismatched`); advisors clean; row counts match the dry-run.

### 2b. Turn on the dual-writers (so PG stays fresh as Blob is written)

Enable, in Production: `supabase_dual_write_jobs`, `supabase_dual_write_tasks`
(its reconcile cron drains every 10 min, off the request path), and the hours
`supabase_dual_write`. These are best-effort and **never fail a Blob save**; a PG
write error just leaves that record to the next sync/drift pass.

> **Evidence has no PG dual-write yet.** `api/evidence.js` writes evidence only to
> Blob; nothing mirrors a new capture into `evidence_files`. So after the 2a
> backfill, **evidence PG coverage decays** as the field captures more — those jobs
> simply parity-fail and Blob-serve (safe, never stale). The evidence read overlay
> is therefore "PG-served for un-changed jobs, Blob for the rest" until either an
> evidence dual-write is built or `evidence-import.js` is re-run periodically. Treat
> evidence's `readyForOverlay` as a point-in-time snapshot, not a standing guarantee.

- **Gate 2b:** make a small real edit in the office (e.g. rename a job / toggle a
  task / log an hour), wait for the mirror, re-run the relevant sync-check → still
  **IN SYNC**. The drift-check shows zero. Leave the dual-writers on.

## Phase 3 — flip the READ flags, tier-by-tier, under the probes

Now PG is populated and self-freshening, the read overlays will actually serve
PG where parity holds. Enable **one flag at a time**, **Preview first** (dev
project), then **Production**, **admin tier before field tier** within each domain
(the office is the lower-stakes audience; the field path is proven last).

**Recommended order** (each domain only after the previous is healthy):
`supabase_read_jobs` → `supabase_read_phil_jobs` →
`supabase_read_admin_tasks` → `supabase_read_phil_tasks` →
`supabase_read_admin_evidence` → `supabase_read_phil_evidence` →
`supabase_read_hours`.

For **each** flag:

1. **Pre-flip gate:** open `/jobs-read-status` (admin) and read that domain's live
   probe. Flip only when it is green: jobs → *faithful == matched, 0 drifted*;
   task-status → *`readyForPromotion` / 0 drifted / 0 unavailable*; evidence →
   *`readyForOverlay` / 0 drifted*; hours → `hours-parity.js` clean. A red probe
   means PG isn't byte-faithful yet — fix the drift (usually a missed dual-write or
   a legacy-shape job) before flipping; **do not flip on red.**
2. **Enable on Preview** (dev project) → exercise the surface (office job list /
   Phil My Day / evidence) → confirm it looks identical and the counters show
   `pgServedReads` climbing with `fallbackReads` + `parityMismatches` at **0**.
3. **Enable on Production** → watch `/jobs-read-status` for 15–30 min: served
   reads climb, **zero** fallback storm / parity mismatch, no latency regression,
   no guard errors in logs.
4. **Per-flip rollback (instant, no deploy):** set the flag OFF → that tier reads
   pure Blob again immediately. The dual-writers can stay on (harmless).

- **Gate 3:** each enabled tier serves a steady share from PG with zero parity
  mismatches over the watch window, and the rendered surface is unchanged
  (output is parity-gated to be byte-identical to Blob).

## Rollback & abort

- **One tier misbehaving:** flip its read flag OFF (instant). Pure Blob returns.
- **Full abort:** turn **all** `supabase_read_*` flags OFF → the entire app is back
  to today's behaviour (pure Blob), no deploy required. Dual-writers may stay on
  (they only mirror; they never affect what users see).
- **Stop the mirror too (rare):** turn the `supabase_dual_write_*` flags OFF; PG
  goes stale but, because reads are parity-gated, stale PG simply fails parity →
  Blob. Nothing breaks.
- **Abort triggers:** sustained `parityMismatches > 0`, a fallback storm,
  probe/guard errors, or any latency regression on `/api/data` or `/api/jobs`.

## Out of scope (do NOT do as part of this runbook)

- **Served-source promotion** — making Postgres the *source of truth* (dropping the
  parity crutch / Blob-as-fallback-only). That is a separate ADR, gated on
  sustained prod drift-zero over a real window; until then every overlay stays
  parity-gated with Blob authoritative.
- **Proof-status cutover** — `job-control.json` (required-evidence / links /
  reviews) has **no PG table** and the admin approve/reject UI is **not built**
  (#503). Blocked; see
  [proof-evidence-read-cutover-audit.md](proof-evidence-read-cutover-audit.md).
- **Snags / observations / materials reads** — no PG home yet; each needs a full
  importer → dual-write → read ladder first.
- **Setting `SUPABASE_ALLOW_PRODUCTION_WRITES`** anywhere except the Production
  scope (and deliberate operator import shells), and never in Preview/Development.

## After this runbook

With one or more read tiers serving PG cleanly in production over a sustained
window with drift-zero, the migration has its first **real prod evidence** — the
prerequisite for the served-source promotion ADR. Sync the operating manual
(wiki) per the wiki-touch rule once this lands.
