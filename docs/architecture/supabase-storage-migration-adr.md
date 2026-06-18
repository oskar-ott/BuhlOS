# ADR — Supabase Postgres as the operational store (strangler migration)

**Status:** Accepted — 2026-06-18
**Deciders:** Oskar (owner) · platform
**Relates to:** Epic [#150] (Platform Infrastructure), [#152] (importers + dual-write),
[#153] (RLS), [#532] (connectivity — the gate), [#533] (proving slice).
**Extends:** [task-led-jobs-adr.md](task-led-jobs-adr.md),
[00-rebuild-non-negotiables.md](00-rebuild-non-negotiables.md),
[../supabase-environment.md](../supabase-environment.md),
[data-ownership-map.md](data-ownership-map.md),
[supabase-migration-roadmap.md](supabase-migration-roadmap.md).

## Context

BuhlOS (office) and Phil (field) store **all** operational data as whole-document
JSON in **Vercel Blob**, through one seam (`api/_lib/blob.js`), across ~101
`api/*.js` routes. Auth is custom **bcrypt + a signed `buhl_session` cookie**.
There is **no Google Sheets and no SQL in the serving path** (verified by grep).

The Blob model has no compare-and-swap (CAS), no referential integrity, and
rewrites grow-collections whole: `jobs/<jobId>/data.json` holds the area-owned
task/snag/note arrays and is **replaced on every POST** (last-write-wins). The
area-id uniqueness invariant had to be hand-guarded across every write path;
`blob-guards.js` `__rev` only *narrows* the lost-update window because Blob has
no CAS. This is the standing data-integrity ceiling and the reason to migrate.

## Decision

Adopt **Supabase Postgres as the operational store via an expand-and-contract
strangler**, primarily as the **integrity engine the Blob store never had**
(FKs, `CHECK`/`UNIQUE`, row-version CAS, audit triggers) — **not** as an
Auth / Realtime / Edge platform in the near term.

1. **Per-domain, dark behind the `supabase_dual_write` flag.** Ladder per domain:
   `blob → dual-write → pg-read/blob-fallback → pg-only`, keyed on `legacy_id`.
2. **Hours first** (tables exist; the approver-queue fan-out is the worst-scaling
   read; no task-identity entanglement), then **jobs/tasks** (the `data.json`
   integrity win), then the remaining domains.
3. **Server-only, service-role, over the Supavisor transaction pooler (`:6543`)**
   via `api/_lib/supabase-db.js`. No browser/edge DB client (the env guard blocks
   browser context). RLS **enabled with zero policies** during the server-only
   phase (anon → 0 rows; service-role bypasses).
4. **Auth stays bcrypt + cookie** — Supabase Auth is **not** adopted. Real RLS
   policies wait for a Third-Party-Auth JWT bridge ([#153]); authoring them before
   that bridge is inert because every server call uses the service-role.
5. **Binary bytes (photos/PDFs) stay in Vercel Blob.** Only metadata + Blob refs
   live in Postgres (`evidence_files`, `documents`). Moving bytes to Supabase
   Storage is a later, separate decision (resumable uploads / image transforms).
6. **Task-led law preserved.** `public.tasks` is the spine; area/stage/proof/
   blocker/QA/material/RFI/drawing are FK facets. **The importer MUST key task
   identity off the canonical index (`ct_<hash>` / `task-ref-compat`), never a
   third ad-hoc mapping** (see data-ownership-map.md).

## Substrate status (2026-06-18)

Dev (`frovgpywsopbeuekijmo`) and prod (`wetctlrhsycfwhuxlarv`) both hold
**Phase 1 (31 tables) + Phase 2a (7 registries) = 38 tables**, RLS-on / zero-policy,
security advisors clean, **0 rows**. Guarded client `api/_lib/supabase-db.js` +
env guard `api/_lib/supabase-env.js` are on `main`. One dark read caller:
`GET /api/supabase-health` (behind `supabase_read_health`, off by default). No
data is imported; **every domain is still blob-backed at runtime.** [#532]
(connectivity: per-env Vercel wiring + Pro plan) is the gate before any importer.

## Consequences

- **Positive:** referential integrity + row-version CAS retire the top risk;
  set-based reads replace whole-blob fan-outs; audit and outbox become tables.
- **P7 obligation (binding acceptance criteria, not nice-to-haves):** dual-write
  MUST carry a **drift alarm** and an **honest "didn't save" path** — a write that
  lands in one store but not the other is exactly the silent failure P7 forbids.
- **P0 operational gate:** the prod project must be **Pro (daily backups) + PITR
  before any real data lands** — Free tier has no backups and auto-pauses, which
  is unacceptable for payroll-grade data.
- **Backwards-compat:** old Blob keys remain readable during the strangler;
  `legacy_id` is the import join key.

## Constitution gate

Per **Phil Constitution P15**, a storage-substrate swap is a **fact-tier** change,
not a behavioural-philosophy claim → **no constitutional amendment required.** It
*serves* **P2** (work lives somewhere — FKs make it structural, not convention),
**P7** (truth over theatre — via the drift alarm) and **P8** (honest degradation).
It **follows** the task-led ADR (the applied schema realises the task-first target
shape better than the current `dwellings[area][stage].tasks` Blob shape) and
**fulfils** the "no full-document writes for grow-collections" engineering
non-negotiable. This ADR is the decision record the task-led ADR's
"a task-storage move needs its own ADR" clause requires; merging it clears the gate.

## Alternatives considered

- **Stay on Blob with harder guards** — rejected: no CAS is unfixable on Blob.
- **Supabase Auth now** — rejected/deferred: high blast radius (sessions, roles,
  client portal, push-subscription ownership), gates everything on an auth rewrite.
- **Bytes into Postgres** — rejected: object storage is the right home; only
  metadata migrates.
- **Edge Functions / Realtime now** — rejected: a second runtime / persistent
  connection overlapping the working Vercel-serverless app + push-only PWA, for no
  current product requirement.
