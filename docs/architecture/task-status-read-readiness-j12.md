# J12 — Task-status read source-of-truth readiness (hardening)

Part of the Blob→Postgres migration (#152). J10/J11 let the **field** and
**admin** task-status reads be served from the Postgres mirror behind dark,
default-OFF flags, **parity-gated** so the output is byte-identical to Blob. J12
is the **readiness rung** before any served-source promotion: it **hardens** the
engine surface and adds a **live, read-only readiness probe** that measures how
byte-faithful the PG mirror is to Blob across the job population.

**J12 changes no read behaviour and adds no new flag.** Blob stays authoritative;
Postgres is **not** the source of truth yet. Promotion is a later rung (J13),
gated on the evidence this probe produces.

## Constitution Gate

This touches data ownership, migration strategy and source-of-truth semantics, so
it goes through the gate (`CLAUDE.md`, `docs/wiki-sync.md`).

- **Follows** the constitution: a parity-validated overlay with honest Blob
  fallback serves P7 (truth over theatre — continuous parity check) and P8
  (honest degradation — Blob fallback), and reuses the existing
  `(jobId,areaId,stage,taskId)→tasks.id` bridge with **no new identity**.
  `taskInstanceId` remains a **target-only** term (claimed nowhere in code/docs).
- **Extends** the strangler ADR (`docs/architecture/supabase-storage-migration-adr.md`)
  by recording *how* an overlay graduates toward source-of-truth: it does not, in
  J12 — this rung only measures readiness and writes nothing.
- **No amendment required** (storage-substrate detail, a fact-tier change). This
  doc is the durable record; **wiki sync follows the merge**.

## What J12 ships

1. **Engine guardrail.** The parity engine `readTaskStatusOverlay` is now
   **internal** (no longer exported); the only callers are the audience wrappers
   (`readPhilTaskStatus`, `readAdminTaskStatus`) and the probe — each pins its
   flag, so a caller can never serve PG under an unapproved flag.
2. **Live readiness probe** (`probeTaskReadParity`, `api/_lib/task-read.js`).
   Read-only, best-effort, never throws. It runs the **same parity engine** (flag
   forced ON so it measures even while serving is dark) across a **bounded,
   deterministic sample** of jobs (`PROBE_SAMPLE_LIMIT = 25`) and aggregates each
   job's own diag into counts only — **no job ids, statuses, or worker/user data**:
   - `pgFaithful` — clean parity PASS (PG byte-faithful to Blob)
   - `drifted` — real divergence (mismatch / orphan / unresolved / hash), with
     per-class totals
   - `errored` — PG unreachable for that job
   - `unavailable` — not yet in PG / projection unclean
   It reports `jobsSampled` vs `jobsTotal`, so any truncation is visible (no silent
   cap). This mirrors the J6 admin jobs probe pattern; it serves nothing.
3. **Diagnostics surface.** `/jobs-read-status` gains a **Task-status parity —
   live readiness probe (J12)** card: faithful / drifted / errored / unavailable
   counts, drift breakdown, latency, and a `readyForPromotion` flag (true only
   when **every** sampled job is PG-faithful). Parity is the same data for both
   tiers, so one probe covers field and office; serving is unchanged.
4. **Single-tenant note.** `tenantSlug` defaults to `'buhl'` (the only tenant, a
   rebuild non-negotiable); injectable for tests, never overridden in prod. A
   second tenant would simply miss the PG lookup and fall back to Blob — safe,
   never a cross-tenant leak. Now documented in code and here.
5. **Flag inventory fix.** `docs/feature-flags.md` was stale (4 of 10 flags); the
   six `supabase_*` read/dual-write flags (J5–J11) are added so the inventory
   matches the registry.

## Promotion criteria (the J13 gate — NOT done here)

A served-source promotion (serve PG as the source, with Blob as an *availability*
fallback only, drift recorded rather than gating each read) may be proposed for
one tier **only** when **all** hold, and it must ship behind its own explicit
dark, default-OFF flag with a documented rollback (flip the flag → revert to the
parity overlay):

1. The readiness probe shows **`drifted = 0`, `errored = 0`, `unavailable = 0`**
   (every sampled job PG-faithful) **sustained** over a meaningful window.
2. Production is actually wired to Supabase (today it is not — no `SUPABASE_*` in
   the Production scope).
3. A drift-detection signal exists for after the equality gate is relaxed
   (the probe is the seed of this).
4. Blob fallback is **retained** for availability; it is **not** removed in J13.

## Rollback

J12 itself is read-only and behind nothing to flip: turning off `supabase_read_*`
tasks flags (already OFF) leaves pure-Blob reads. The probe is diagnostic only; if
it errored it never affects a served read. There is nothing to roll back beyond a
normal revert.

## Scope / honest notes

- **No behaviour change, no new flag, no writes, no migrations, no auth/vercel.json
  changes, no Phil UI change.** Admin UI gains only the diagnostics card.
- The probe re-runs the full engine per sampled job (one `data.json` read + a few
  PG queries each), bounded to 25 jobs to stay cheap on the admin page; it only
  runs when Supabase is wired and an admin loads `/jobs-read-status`.
- Out of scope (J13+): served-source promotion, Blob retirement, proof/evidence
  read cutover, multi-tenant support.

See also: [phil-task-read-cutover-j10.md](phil-task-read-cutover-j10.md),
[admin-task-read-cutover-j11.md](admin-task-read-cutover-j11.md).
