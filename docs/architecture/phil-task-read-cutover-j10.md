# J10 — Phil task-status read cutover

Part of the Blob→Postgres migration (#152). J9 made task status a live Postgres
mirror (dual-write). J10 lets the **field/Phil** task-status read be served from
that mirror behind a dark flag, with Blob fallback. Read-only; **Blob stays
authoritative**; no write-path / ownership / identity changes.

## Mirror cadence (the J9 freshness follow-up)

J9's mirror cron ran daily. **Daily is insufficient for meaningful PG coverage of
worker-facing reads** (a worker's recent toggles would Blob-fall-back for ~24h),
so the cron is bumped to **every 10 minutes** (`vercel.json`).

But the deeper guarantee is the **parity gate**: the read serves PG **only when
PG is byte-faithful to Blob for the whole job**, else Blob. So **correctness is
cadence-independent** — a not-yet-mirrored toggle simply fails parity and is
served from Blob (the worker sees their fresh status instantly), and PG takes
over once the mirror catches up. The cadence only affects PG *coverage*, not
correctness, so the exact frequency is a coverage/cost knob (10 min is a balance;
tune at enable-time). Dev-proven: toggle → Blob-fresh read → mirror → PG read.

## The read overlay (`api/_lib/task-read.js`)

At the `/api/data` seam, for the **field/leading-hand** tier, when
`supabase_read_phil_tasks` is ON:

1. Reconstruct the job's task statuses from Postgres (read-only `getDb({mode:'read'})`).
2. Build the Blob side with the ONE expansion engine (`buildTaskProjection`) —
   **no new identity**; the existing `(jobId,areaId,stage,taskId)→tasks.id` bridge.
3. **Whole-job parity gate:** every blob task must resolve to a PG task with the
   SAME status — no mismatch, no orphan PG task, no unresolved instance, hashes
   equal. PASS → source the existing dwelling statuses from PG (== Blob); FAIL or
   any error → **Blob fallback** (recorded).

Output is **byte-identical to Blob** (a worker can never lose visibility or see a
stale status). **Best-effort** — never throws; admin/client reads are untouched
(admin task reads are J11). **Worker isolation** is the existing
`requireAuth({jobId})` gate (unchanged) — the overlay only ever touches the
single requested job, so there is no cross-worker leakage.

## Flag + diagnostics

- `supabase_read_phil_tasks` — default OFF, unset in prod, runtime-readable.
- `/jobs-read-status` gains a **Phil task-status read** card: flag state, reads
  served, PG-served (parity PASS) vs Blob, fallbacks, parity mismatches, last
  source/time. Process-local counters (`api/_lib/task-read-diagnostics.js`); no
  live probe (the overlay is per-job/worker-scoped and the admin page has no such
  context).

## Dev validation

flag OFF → Blob (unchanged) · flag ON + parity → Postgres, states identical
(162/162 matched) · **toggle not-yet-mirrored → parity FAIL → Blob, worker sees
FRESH** · after mirror → parity PASS → Postgres serves the toggle · PG failure →
Blob fallback (no error) · per-job isolation. Fully reverted (data.json + PG
statuses + test events). Output identical to Blob throughout.

## Scope / honest notes

- **Output == Blob** (parity-gated equality, the J6/J7 model): J10 exercises +
  proves the PG task read and measures parity; it does not change what the worker
  sees. Making PG the served source-of-truth is a later rung.
- **Net-transition mirror** (from J9): PG reflects net status per drain; combined
  with the parity gate, a mid-drain flap just keeps the job on Blob until settled.
- Out of scope: task writes, mirror changes (beyond cadence), admin task reads
  (J11), proof/evidence, schema, Blob retirement, production rollout.
