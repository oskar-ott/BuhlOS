# Supabase served-source promotion — the master roadmap

> The plan to take each domain from **Blob-authoritative + parity-gated overlay**
> (where the migration is today) to **Postgres-as-source** ("data goes straight to
> Supabase"), one domain at a time, safely and reversibly. Part of [#152]. Sits
> above the per-domain ADRs (e.g.
> [task-status-pg-source-promotion-adr.md](task-status-pg-source-promotion-adr.md))
> and the enablement runbook
> ([supabase-read-enablement-runbook.md](supabase-read-enablement-runbook.md)).

## Where each domain is (today)

Every migrated domain currently runs the **strangler overlay**: writes hit Blob;
Postgres is mirrored (dual-write); reads are **parity-gated** (PG served only when
byte-identical to Blob, else Blob). Blob is authoritative and read on every request.

| Domain | Write today | Read today | PG-as-source status |
|---|---|---|---|
| Task status | Blob (`/api/task-toggle`); cron mirror → PG | parity-gated overlay | **Stage A built** (CAS write behind `supabase_source_tasks`, dark) |
| Hours | Blob (in-request, `__rev` CAS) + **synchronous** in-request PG upsert | parity-gated | **Stage A built** (existing mirror promoted under `supabase_source_hours`, dark) |
| Jobs structure | Blob (create/PUT/bulk/publish) + in-request PG mirror | parity-gated | later (tree writes, many sites — hardest) |
| Evidence metadata | Blob capture; cron mirror → PG **built but dark** (`supabase_dual_write_evidence` off, so `evidence_files` not yet populated) | parity-gated overlay (dark) | later |
| Snags / observations / materials | Blob only (**PG tables exist** from Phase-1, but **no importer / no dual-write** yet) | Blob | **blocked** — tables are empty; need importer→dual-write→read first |
| Proof-spine (job-control, #503) | Blob only (**no PG table yet**) | Blob | **blocked** — needs schema → importer → dual-write → read |

## The promotion ladder (per domain)

Each domain climbs the same rungs; **never skip a rung, never two domains at once**:

1. **Write-CAS (Stage A).** Promote the *write* to a synchronous per-row Postgres
   write with optimistic-locking (`revision` CAS) **at request time**, alongside the
   Blob write-through. This is the actual integrity win (kills Blob's whole-document
   lost-update flaw). **Read stays parity-gated** — so any PG lag falls back to
   *current* Blob and can never serve stale. Ship behind a dark `supabase_source_*`
   flag (default OFF).
2. **Bake the write.** Enable the flag in prod. Watch the drift-check + diagnostics
   until **sustained drift-zero** and **zero PG-write fallbacks** over real field
   traffic (days, not hours).
3. **Read-authoritative (Stage B).** Only after (2): tighten the write to PG-required
   (resolve the resilience trade-off) and flip the read to **PG wins unconditionally**
   (still Blob-fallback on a PG *error*, for availability).
4. **Retire Blob for the domain.** Much later, separately: stop writing the domain to
   Blob. Each retirement is its own ADR with its own bake + rollback.

### Stage-A's shape differs per domain (don't copy code blindly)

Rung 1 is a *posture* — "a synchronous per-row PG write at request time, behind a
dark `supabase_source_*` flag" — not one fixed implementation. How much new code it
needs depends on what the domain already has:

- **Task status (#738)** needed a NEW write file (`api/_lib/task-write.js`). Its only
  pre-existing mirror was the J9 *async cron* (`task-mirror.js`), off the request path,
  and `data.json` task state has **no Blob CAS** — so the synchronous PG `revision`
  CAS is a genuine *lost-update* fix.
- **Hours** needed **no new write file**. Its mirror (`api/_lib/hours-mirror.js`) was
  *already* synchronous + in-request, doing a per-row `on conflict … do update …
  where <distinct from>` upsert (revision bumped by trigger) with allocations
  reconciled in the same txn. Stage A here just **promotes** that write under
  `supabase_source_hours` (it runs when that OR `supabase_dual_write` is on) and
  reports `source` for the diagnostics. The hours Blob write also already has
  optimistic-lock CAS (`writeBlob` `expectedRev: entry.__rev`), so hours has **no
  lost-update flaw** — its PG win is **referential** (real job FKs, per-allocation
  rows, schema CHECKs) and it unlocks the Stage-B payroll read.

The invariants are constant regardless of shape: synchronous + at-request-time,
identity via the existing legacy bridge (never mint an id), Blob write-through always
(resilience), read stays parity-gated until Stage B.

## The soundness rule (why the order is fixed)

**A PG-authoritative read may only be enabled when writes are strictly synchronous.**
An authoritative read combined with a *best-effort* write would serve **stale** PG
whenever a write is skipped/fails. So the write is promoted (and proven) first, with
the read staying parity-gated until then. This is why Stage A keeps the read gated.

## Resilience trade-off (the recurring decision)

During each bake, the Stage-A write is **PG-preferred, Blob-resilient**: if the PG
write fails, fall back to the Blob write so **field work never stops** (P8 honest
degradation). PG becomes *strictly required* only at the Stage-B/retire step, once it
has proven reliable. This trade-off is re-decided per domain at promotion time.

## Gates before any of this runs in production

- The enablement runbook's Phase 1–2 complete (prod wired, PG populated + dual-writing
  + IN SYNC) — the overlay reads/writes proven.
- `CRON_SECRET` set so the mirror + drift-check crons actually run.
- A live **drift-check** (`/api/internal/sync-checks/structure`, hours) + the
  `/jobs-read-status` readiness probes are the standing evidence for "bake clean."

## Order of attack (recommendation)

1. **Task status** — Stage A built; bake next (smallest, leaf-value write).
2. **Hours** — Stage A built (the synchronous mirror promoted under
   `supabase_source_hours`); bake alongside/after tasks.
3. **Jobs structure** — hardest (tree, many write sites); only after tasks + hours bake.
4. **Evidence** — after structure (depends on area/task identity being PG-source).
5. **Snags / observations / materials** — PG tables exist but are empty; need the
   importer → dual-write → read ladder built before promotion.
6. **Proof-spine (job-control, #503)** — no PG table yet; needs schema first, then
   the full importer → dual-write → read ladder. Last.

## Non-goals / standing rules
- **Binaries always stay in Blob** (photos/files) — only metadata is ever in PG.
- **No new task identity / no `taskInstanceId`** — every domain reuses the canonical
  bridge.
- **One domain at a time**, each fully baked before the next is promoted.
- **Blob is retired per domain only at rung 4**, never as a big-bang.
