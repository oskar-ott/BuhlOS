# J11 — Admin task-status read cutover

Part of the Blob→Postgres migration (#152). J9 made task status a live Postgres
mirror (dual-write); J10 let the **field/Phil** task-status read be served from
that mirror behind a dark flag. J11 does the same for the **admin/office** read.
Read-only; **Blob stays authoritative**; no write-path / mirror / schema /
identity changes, and **no change to the Phil path** (the field cutover is left
exactly as shipped).

## Why admin after Phil

The field path is the harder, higher-stakes case (a worker who loses task
visibility can't work). It is now proven safe end-to-end (J10). The office read is
lower operational risk and, crucially, runs on the **same parity engine** — so J11
is almost entirely "point the admin tier at the existing overlay behind its own
flag."

## One engine, two audiences

`api/_lib/task-read.js` exposes one parity engine, `readTaskStatusOverlay`, and
two thin wrappers that differ **only by feature flag**:

- `readPhilTaskStatus` → `supabase_read_phil_tasks` (J10, field/leading-hand)
- `readAdminTaskStatus` → `supabase_read_admin_tasks` (J11, admin/office)

The wrappers **pin** the flag (a caller can't pass `flagKey` to spoof the
audience). The module is audience-blind; **which tier reaches which wrapper, and
clients always reading pure Blob, is decided at the call site** (`api/data.js`):

```
field / leading-hand → readPhilTaskStatus  (J10)
admin / office       → readAdminTaskStatus  (J11)
client (+ any other) → pure Blob (untouched)
```

Reader isolation is the existing `requireAuth({ jobId })` gate (unchanged) — the
overlay only ever touches the single requested job.

## The parity gate (inherited from J10, unchanged)

For one job: build the Blob side with the ONE expansion engine
(`buildTaskProjection`) — **no new identity**, the existing
`(jobId,areaId,stage,taskId)→tasks.id` bridge — query the job's PG task statuses
(read-only `getDb({mode:'read'})`), and serve PG **only** when every Blob task
resolves to a PG task with the SAME status (no mismatch, no orphan PG task, no
unresolved instance, hashes equal). PASS → source the existing dwelling statuses
from PG (== Blob). FAIL or any error → **Blob fallback** (recorded).

Output is **byte-identical to Blob** (the office can never see a stale status; a
not-yet-mirrored change fails parity and is served from Blob). **Best-effort** —
never throws.

## Flag + diagnostics

- `supabase_read_admin_tasks` — default OFF, unset in prod, runtime-readable;
  global flag, admin-tier restriction enforced at the call site (`isAdminRole`).
- A separate process-local counter
  (`api/_lib/admin-task-read-diagnostics.js`, same shape as the J10 module) so the
  office and field cutovers are observed **independently** and the proven Phil
  diagnostics are left untouched. `/jobs-read-status` gains an **Admin
  task-status read** card (flag, reads served, PG-served vs Blob, fallbacks,
  parity mismatches, last source/time). No live probe (per-job/reader-scoped).

## Dev validation

flag OFF → Blob (unchanged) · flag ON + parity → Postgres, states identical ·
toggle not-yet-mirrored → parity FAIL → Blob (office sees the fresh status) ·
after mirror → parity PASS → Postgres · PG failure → Blob fallback (no error) ·
audience separation: with the Phil flag ON and the admin flag OFF the admin read
stays on Blob, and vice-versa · clients always read pure Blob. Fully reverted.

## Scope / honest notes

- **Output == Blob** (parity-gated equality, the J6/J7/J10 model): J11 exercises +
  proves the PG admin task read and measures parity; it does not change what the
  office sees. Making PG the served source-of-truth is a later rung.
- Deliberate small duplication: the admin diagnostics module mirrors the J10 one
  rather than refactoring the field module to dual-bucket, to keep the proven Phil
  path byte-for-byte untouched.
- Out of scope: task writes, mirror changes, the Phil path, proof/evidence,
  schema, Blob retirement, production rollout.
