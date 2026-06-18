# Supabase migration roadmap

> Execution roadmap for the [storage-migration ADR](supabase-storage-migration-adr.md).
> Sequence, **not a calendar** — phase *order* survives contact with reality; dates do not.
> Domain→store contract: [data-ownership-map.md](data-ownership-map.md). Env/safety:
> [../supabase-environment.md](../supabase-environment.md).

## Capability priorities (what "fully utilising Supabase" means here)

Adopt Supabase as a **Postgres-of-record + integrity engine + scheduler + queue**.
Consciously **do not** migrate Auth/Realtime/Edge soon — that is where teams over-adopt.

- **P0 (now / go-live gate):** Postgres core + **FK/CHECK/UNIQUE + row-version CAS**
  (retires the top risk); **Migrations/CLI** as the delivery mechanism; **RLS
  enabled-no-policy** hygiene (done); **Pro plan + PITR before any real data** lands.
- **P1 (next wave):** **Storage** for evidence/plan *bytes* (resumable uploads +
  image transforms — the strongest non-DB fit for Phil's flaky signal); **DB
  triggers/functions** for audit + `updated_at` + invariant enforcement +
  `pg_jsonschema` import validation; **Advisor/Reports** observability.
- **P2 (when the trigger exists):** **Third-Party-Auth JWT bridge** (makes RLS real);
  **`pgmq` Queues** for the [#160] outbox; **`pg_cron`** for set-based jobs
  post-cutover; branching (optional).
- **P3 (avoid / much later):** Edge Functions, Realtime, pgvector, Log Drains, full
  Auth migration, self-hosting.

> Sharpest single recommendation: **treat Supabase first as the integrity layer the
> JSON-Blob store never had.** Everything else is secondary.

## Migration strategy (per-domain strangler)

Ladder, behind `supabase_dual_write`, keyed on `legacy_id`:
`blob → dual-write (PG transactional truth + outbox in same tx; Blob best-effort + drift alarm) → pg-read/blob-fallback → pg-only`,
using `READ_SOURCE_*` / `WRITE_TARGET_*` flags.

**P7 obligation:** the drift alarm + an honest "didn't save → worker knows, loses
nothing" path are **acceptance criteria**, not optional.

**Disposition:** `data.json` tasks + hours = **MIGRATE-NOW**; singleton lists
(jobs/observations/suppliers/job-types) = **MIGRATE-LATER** (after hours proves the
pattern); auth/`users.json` = **BRIDGE** (mirror `user_profiles`, keep bcrypt); photo
**bytes = KEEP in Blob** (migrate only metadata); backup cron = **KEEP until PITR**;
`sw.js` = **DO-NOT-TOUCH** (push URL is sacred).

## Phases (sequence)

- **Phase 0 — Governance (this doc + the ADR + ownership map).** Clears the
  Constitution Gate. No code. ✅ in progress.
- **Phase 1 — Foundation ([#532]/[#533]).** Per-env Vercel wiring; **Pro before data**;
  CLI `init`/`link`; reconcile migration history; land the read-only **hours proving
  slice** on a preview; merge the per-call env-guard fix before any write caller.
- **Phase 2 — Hours dual-write ([#152] pilot).** Single seam `api/_lib/time-entries.js`:
  dual-write → drift-check → read-cutover. First real "app uses Supabase."
- **Phase 3 — Per-domain strangler.** jobs/tasks (`data.json` — *the* integrity win),
  then snags/observations/materials/ITP, each behind the flag.
- **Phase 2b–5 — new clusters** (see data-ownership-map §4): Commercial (quotes/
  variations) → Field-ops (drawing revisions/markups/RFIs) → Workforce (licences/
  leave/temps) → Platform (push_subscriptions/access/invites) → Analytics.
- **Storage (P1, parallelizable):** evidence/plan metadata → Postgres; then evaluate
  moving *bytes* to Supabase Storage.
- **Last:** [#508] deprecate area-owned task arrays (`P3-horizon`).

## Risk register (top)

| Risk | Sev | Mitigation |
|---|---|---|
| Blob no-CAS → silent lost updates (`data.json`, hours) | High | Postgres row-version CAS; MIGRATE-NOW |
| **Prod on Free tier** = no backups + auto-pause | High | **Pro before any data**; PITR before payroll cutover |
| Importer forks task identity (3rd mapping) | High | Bind importer to canonical index; pinned in ownership map §0 |
| P7 silent partial-failure during dual-write | High | Drift alarm + honest no-save = acceptance criteria |
| RLS theatre (policies inert without a JWT) | Med | Keep RLS-on/no-policy; policies only after the JWT bridge |
| 4-digit PIN, no lockout | Med | Login throttle ([#514]) |
| Photo bytes `public`/unauthenticated | Med | Signed URLs when evidence metadata migrates |
| Over-adopting Edge/Realtime/Auth | Med | Conscious P3/avoid |

## Issue plan (Epic [#150])

- **Spine:** [#532] (connectivity — the gate) blocks [#152]/[#153]/[#533]; the per-call
  env-guard fix must merge before [#152]'s first write caller; the blob write-safety
  trio should precede the dual-write helper design.
- **Propose (not yet filed):** identity-bridge implementation; blob↔PG drift-check cron;
  import-order + `tenant_id` backfill runbook; evidence-bytes Blob-vs-Storage decision;
  read-cutover rollout tracker; "auth stays bcrypt" decision record (this ADR).
- **Labels:** add a `supabase`/`migration` label and a `blocked:supabase` label so the
  gate is visible at list level.

## Open decisions (owner)

1. Confirm prod project is **Pro** before any data import.
2. **Identity bridge** — mint a Postgres JWT from the cookie (unlocks RLS) or stay
   server-only/service-role indefinitely?
3. **Photo bytes** — Supabase Storage or keep Vercel Blob + Postgres metadata?
4. Confirm **auth stays bcrypt+cookie** (recorded in the ADR).
