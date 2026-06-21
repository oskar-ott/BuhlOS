# Proof & evidence — Supabase read-cutover audit (decision record)

> **Status:** pre-code audit of `main` after the task-status read cutover
> (J10 Phil read, J11 admin read, J12 readiness probe). Decides the **safest first
> Supabase read-overlay slice for proof/evidence** without changing Phil behaviour,
> admin proof approval, task identity, or source-of-truth semantics. **This slice is
> docs-only.** Part of [#152]; reads against
> [supabase-migration-roadmap.md](supabase-migration-roadmap.md),
> [supabase-storage-migration-adr.md](supabase-storage-migration-adr.md),
> [data-ownership-map.md](data-ownership-map.md), and
> [proof-review-model.md](proof-review-model.md).

## The one finding that governs everything: two domains, opposite readiness

"Proof/evidence" is **two separate stores** in this repo, and they are at opposite
ends of migration readiness. Conflating them is the central hazard.

| Domain | Blob home | Postgres home | Read-overlay feasible? |
|---|---|---|---|
| **Evidence metadata** (captured photos/notes) | `jobs/{jobId}/data.json.evidence[]` | **Yes** — `evidence_files` + `evidence_links` (migration `20260611142758`), populated by **J4** (`#603`, `ad1999b`) | **Yes** — parity-gated overlay is feasible (below) |
| **Proof status** (the requirement→capture→link→met→review loop) | `jobs/{jobId}/job-control.json` (`workPackages` / `requiredEvidence` / `evidenceLinks` / `proofReviews`) | **No** — no PG table for the proof spine | **No** — blocked (below) |

Photo/PDF **bytes** stay in Vercel Blob in both cases (ADR §5); only **metadata**
is in Postgres. Evidence `evidence_files` carries metadata + a `blob_url`/photo ref.

## Evidence metadata — read-overlay is feasible (the green path)

- **PG has the data.** J4 imported every evidence item into `evidence_files`
  (idempotent `(tenant_id, legacy_id)` upsert) plus task/area links into
  `evidence_links` (`scripts/importers/lib/evidence-rows.js`,
  `scripts/importers/lib/proof-projection.js`).
- **The inverse projection already exists.** `api/_lib/job-read-projection.js`
  (`select … from public.evidence_files ef join public.jobs jb …`, ~L174–191)
  already reconstructs `data.json.evidence[]` from PG rows, field by field — exactly
  the J5 pattern that backs the J6/J7 and J10/J11 overlays.
- **Granularity is honest by construction.** `evidence_files.task_id` is set **only**
  when the full `(areaId, stage, taskId)` coordinate resolves; partial/unresolvable
  coordinates are quarantined, never fabricated (`evidence-rows.js` fail-closed). The
  identity bridge is the existing `legacy_id` + `job_id` + coordinate — **no new
  task identity**, no `taskInstanceId` (it exists nowhere in code).
- **Parity can be byte-identical** for the migrated metadata fields (`kind`,
  `blob_url`/ref, `note`, `site_area_id`, `task_id`, `captured_at`, `status`,
  `reviewed_at`, `rejection_reason`), using the same sorted-tuple hash gate as
  `api/_lib/task-read.js`. Anything not stored in PG (raw bytes; any Blob-only field)
  or any unresolved/quarantined row **forces Blob fallback** — Blob stays
  authoritative, exactly as J10–J12.

This means evidence can follow the proven strangler ladder. **It is deliberately
not implemented in this slice** (see Decision).

## Proof status — blocked, and why (the honest gap)

The proof loop (`requiredEvidence` / `evidenceLinks` / `proofReviews` /
`workPackages`) lives **only** in `job-control.json` (Blob). There is **no Postgres
table** for it, so a parity-gated read overlay is **not possible** without first:

1. designing a PG schema for the proof spine,
2. building a dual-write for `job-control.json`,
3. building an importer + sync-check (the J1–J4 equivalent), and
4. resolving the open **admin approve/reject surface** product call.

Two facts from [proof-review-model.md](proof-review-model.md) must **not** be
overclaimed by any future slice (verified against `main`):

- **Proof is area/package-granular in practice.** Per-task authoring (`taskRef` on
  `RequiredEvidence`/`EvidenceLink`, the `#502` arc) is **live, additive, opt-in** —
  but **no shipped job authors task-scoped requirements yet**. Default is
  package-level.
- **The admin approve/reject UI does not exist.** The `ProofReview` engine (`#544`)
  and the Phil submit surface (`#546`) are merged; the **office approval surface is
  NOT built** (reachable only via the server engine/API). `#503` is the open product
  decision; `#495` is parked/superseded.

A proof-status cutover therefore sits **after** evidence, and after that product
decision — it is not the next rung.

## Constitution Gate

- **Verdict: FOLLOWS + EXTENDS — `requires-doc-update` (this record), no amendment.**
  An evidence read overlay is the same strangler pattern the
  [storage-migration ADR](supabase-storage-migration-adr.md) ratified, applied to a
  new domain; it serves P7 (truth over theatre, via continuous parity) and P8
  (honest degradation, via Blob fallback). It is **not** a Phil-constitution change:
  no field-visible behaviour changes (output stays byte-identical to Blob, like J10).
- **Task-led architecture preserved.** Reuses the canonical `(areaId, stage, taskId)`
  bridge; does not deepen area-owned task arrays; invents no third identity.
- **Source-of-truth unchanged.** Blob remains authoritative; this audit proposes no
  promotion. (Task-status served-source promotion remains a **separate** track,
  independently gated on prod Supabase wiring + sustained drift-zero — see
  [task-status-read-readiness-j12.md](task-status-read-readiness-j12.md).)

## Decision

**This slice: docs-only.** Record the two-domain split, the evidence feasibility,
and the proof-status block — so no later slice overclaims per-task proof, admin
approval, or "proof is in Postgres." No code, no flag, no schema, no writes.

**Recommended next rungs (lowest-risk first; each its own slice, on user go):**

1. **Evidence read-only parity probe** — mirror `probeTaskReadParity` (J12): a
   bounded, read-only, best-effort `probeEvidenceReadParity` surfaced on
   `/jobs-read-status` (counts/booleans only — no URLs, no note bodies, no PII).
   Measures evidence PG↔Blob parity across sampled jobs. **No serving change, no
   flag.** This is the safe way to earn the readiness evidence.
2. **Dark evidence read overlay** — only if the probe shows parity holding: a
   parity-gated overlay behind a **new** dark flag `supabase_read_evidence`
   (default OFF, unset in prod), admin-first then Phil (the J6/J7 → J10/J11
   ordering), with automatic Blob fallback. Clients stay pure Blob. Output
   byte-identical to Blob.
3. **Proof-status cutover — deferred.** Requires a PG schema + dual-write + importer
   for the proof spine **and** the `#503` admin approve/reject product decision.
   Not scheduled by this audit.

## What this slice must not be read as claiming

- Not that per-task proof is authored/served in production (it is **opt-in,
  unshipped** — package-level by default).
- Not that an **admin approve/reject UI** exists (it does **not** on `main`).
- Not that the **proof spine** (`job-control.json`) is in Postgres (it is **Blob-only**).
- Not a new task identity or any `taskInstanceId` (a target term that exists nowhere
  in code).
- Not a source-of-truth promotion for evidence or anything else.

## Files — safe to touch (future slices) vs must not touch

- **Safe (when the evidence probe/overlay is built):** a new
  `api/_lib/evidence-read.js` + diagnostics module, `src/server/jobs-read-status.ts`
  (additive loader/summariser), `src/app/(admin)/jobs-read-status/page.tsx`
  (additive card), `api/_lib/feature-flags.js`/`.d.ts` + `docs/feature-flags.md`
  (only when a flag is actually introduced), reuse of the existing
  `api/_lib/job-read-projection.js` evidence reconstruction.
- **Must not touch:** `src/server/job-control/proof-review.ts` and its route (no
  admin UI without the schema/dual-write prerequisite + `#503` decision),
  `src/server/job-control/evidence-link.ts`, the proof spine schema
  (`src/domains/job-control/schema.ts`), `supabase/migrations/*` (no proof-spine
  migration here), `vercel.json`, `src/middleware.ts`, `docs/phil-constitution.md`
  and `docs/architecture/task-led-job-architecture.md` (amend only via governance),
  and the task-status read path (`api/data.js`, `api/_lib/task-read.js`).

## Rollback

Docs-only — revert the commit. Nothing in the served path changes; there is nothing
to flag-off.
