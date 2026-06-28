# ADR — Promote task-status to Postgres-as-source (the first served-source cutover)

> **Status:** proposed. The first step of "data goes straight to Supabase" — making
> Postgres the **source of truth** for task STATUS, not just a parity-gated mirror.
> Part of [#152]. Builds on the dual-write + read-overlay rungs (J9/J10/J11) and the
> readiness model in [task-status-read-readiness-j12.md](task-status-read-readiness-j12.md).
> Scope is **task status only** — the template for the other domains, done one at a time.

## Context — where we are vs. where this goes

Today (all domains): **Blob is authoritative.** Writes go to Blob; Postgres is a
mirror; reads are a **parity-gated overlay** (PG served only when byte-identical to
Blob, else Blob). Output is identical to Blob — PG is *proven*, not *trusted*.

The actual integrity win the migration exists for is **per-row writes with optimistic
locking (CAS)** — fixing Blob's "whole-document, last-writer-wins" lost-update flaw.
The current `/api/task-toggle` reads the whole `data.json`, sets one task, writes it
back: two clients toggling **different** tasks can stomp each other. The `tasks` table
already has a **`revision`** column, so CAS is available.

This ADR promotes task-status so **writes land in Postgres directly (CAS-protected)
and reads come from Postgres**, with Blob kept current as a write-through mirror +
resilience floor during a bake-in, then retired for this domain.

## Decision — staged, flag-gated, reversible

A new flag **`supabase_source_tasks`** (default OFF). Staged, each its own deploy:

1. **Ship dark (this slice).** Build the synchronous **PG-CAS write** behind the flag
   (+ Blob write-through); the read stays parity-gated (Stage A above). Merging changes
   nothing in prod (flag off = today's behaviour exactly).
2. **Enable + bake the write.** Flip the flag in prod: task toggles now do a CAS'd
   per-row PG write at request time (fixing lost-updates) while Blob is written
   through (stays current). Reads still parity-gated → Blob-safe. Watch drift until
   **sustained drift-zero** + zero PG-write fallbacks.
3. **Promote the read (Stage B) + later retire Blob.** Only after (2) bakes clean:
   tighten the write to PG-required and flip the read to PG-authoritative; then, much
   later and separately, stop writing task status to Blob. Separate ADRs.

## Write design — `/api/task-toggle` when `supabase_source_tasks` is ON

1. **Validate unchanged** — structure (area/task existence, draft/archived/role gates)
   is still checked against `jobs.json` (job *structure* stays Blob-authoritative for
   now; only task *status* is promoted).
2. **Write Postgres first, with CAS** — resolve the task row via the existing bridge
   `(jobId→job_id, areaId+stage+taskId→tasks.id)` and:
   `UPDATE public.tasks SET status=$state, revision=revision+1, updated_at=now()
    WHERE tenant_id=$t AND id=$id AND status IS DISTINCT FROM $state RETURNING revision`,
   then append one `task_status_events` row for the real transition.
   Per-row update means **cross-task lost-updates are structurally impossible**; the
   `revision` bump + `IS DISTINCT FROM` guard make same-task concurrent toggles
   idempotent/ordered.
3. **Write Blob through** — apply the same `dwellings[...].tasks[taskId]=state` to
   `data.json` (so Blob stays a current mirror for the snags/notes/evidence envelope,
   offline cache, and instant rollback).
4. **Resilience (the key trade-off — see Open decisions):** during the bake, if the
   **PG write fails**, fall back to the Blob-only write and flag a reconcile (the cron
   mirror catches PG up) — so **field work never stops on a PG outage**. PG is the
   *preferred* source; Blob remains the *resilience floor* until the retire step. If
   the **Blob write fails** after PG succeeded, return the honest "didn't save" (502)
   and let the client retry — never leave the mirror silently behind.

## Read design — STAGED (corrected for soundness)

> **Soundness note:** a PG-authoritative read combined with a *best-effort* write is
> unsound — if a PG write is ever skipped/fails, the read would trust a **stale** PG
> value. So the read is promoted **only after** writes are strictly synchronous.

- **Stage A (this slice): keep the read parity-gated.** When `supabase_source_tasks`
  is ON we change the **write** (synchronous PG-CAS, below) but the read still serves
  PG only where byte-identical to Blob, else Blob (`supabase_read_*_tasks`). Because
  the write-through keeps Blob current, any PG lag simply falls back to current Blob —
  **never stale.** This already banks the integrity win (CAS per-row writes) with zero
  correctness risk.
- **Stage B (later sub-step): PG-authoritative read.** Flip the read to "PG wins
  unconditionally" **only once the write is strictly synchronous** (PG-required — the
  resilience decision tightened so PG can never silently lag). Then a PG read error
  still falls back to Blob for availability. Gated on a sustained drift-zero bake.

## CAS / concurrency

- **Lost-update fix:** per-row `UPDATE` replaces whole-document rewrite → two clients
  toggling different tasks can no longer stomp each other (the Blob flaw).
- **Same-task races:** `revision` + `status IS DISTINCT FROM` make a replayed/concurrent
  identical toggle a no-op (0 rows), and every real change bumps `revision` + appends
  an event — an auditable, ordered history.

## Rollback

Flip `supabase_source_tasks` **OFF** → instantly back to Blob-authoritative +
parity-gated reads. Safe with **zero data loss** because Blob was kept current via the
write-through. No deploy needed (runtime flag).

## Bake + retire criteria (gates for stages 2→3)

- Drift-check (`/api/internal/sync-checks/structure`) reports task sections **IN SYNC**
  for a sustained window (days, real field traffic), **zero** PG-write fallbacks, no
  CAS-conflict errors surfacing to users.
- Only then consider the **separate** retire-Blob-for-tasks ADR (stop the Blob
  write-through). Not before.

## Scope / non-goals

- **Task STATUS only.** Job *structure* (jobs/areas/templates), snags, notes,
  observations, materials, the job-control proof spine, hours, users/auth, quotes —
  **stay Blob-authoritative** (each gets its own promotion ADR later, same template).
- **Binaries always stay in Blob** (photos/files) — only metadata is ever in PG.
- No new task identity / no `taskInstanceId` (reuses the canonical
  `(jobId,areaId,stage,taskId)→tasks.id` bridge).
- Does **not** retire Blob for tasks (that's stage 3, a separate ADR).

## Open decisions (need an owner call)

1. **PG-write-failure resilience during the bake (recommended: PG-preferred,
   Blob-resilient).** The alternative — make PG strictly required (fail the toggle if
   PG is down) — is *more* correct as "source of truth" but **less resilient than today**
   (a PG/pooler outage would stop field task toggles). Recommendation: keep the Blob
   fallback for writes during the bake (this ADR's step 4); only remove it at the
   retire step, once PG has proven reliable. P7 ("honest degradation") favours
   never blocking the field on PG during the transition.
2. **Structure still Blob-authoritative** while task-status is PG-source. This is fine
   (status is a leaf value keyed off structure) but means the toggle still reads
   `jobs.json` to validate. Accepted.
