# Admin required-proof authoring + compile path

> Status: **product-unblocking slice.** Makes the already-built field
> Capture-proof loop ([#470](job-control-capture-proof-ui.md)) reachable through
> the shipped producer chain. Code:
> [`src/server/job-control/reconciliation-producer.ts`](../../src/server/job-control/reconciliation-producer.ts)
> (L0 input + `normalisePatch`). No new UI; no compiler change.

## Why

The Capture-proof loop is built end to end — the compiler attaches a package's
`requiredEvidence`, Phil renders it, and a worker can capture proof that flips a
requirement needed → met ([L4 writer](job-control-evidence-writer.md), [#470 UI](job-control-capture-proof-ui.md)).
But **nothing could author the proof**: the L0 reconciliation input
(`ClauseClassificationInputSchema` / `normalisePatch`) accepted only
`classification` / `warningText` / `note` and **dropped** the two fields the
compiler needs to emit field-delivered work with proof:

- `deliveredBy` — the task coordinate(s) the work happens on; without it a
  field-classified (`priced` / `general_allowance` / `pc_provisional`) clause
  compiles to a `no_delivering_task` gap and **no package**.
- `requiredEvidence` — the proof the office wants for the clause; without it a
  compiled package carries no `requiredEvidence`, so Phil has nothing to bind a
  capture to.

So a real compiled job could never show a required-proof item, and the #470 loop
was unreachable in the shipped product. This slice closes exactly that gap.

## What it changes (narrow)

In [`reconciliation-producer.ts`](../../src/server/job-control/reconciliation-producer.ts):

- **`ClauseClassificationInputSchema`** — the object variant now also accepts
  `deliveredBy?` (each `{ areaId, stage, taskId }`, `stage` ∈ the closed
  `JobControlStage` set) and `requiredEvidence?` (each `{ id?, label, kind, note? }`,
  `kind` ∈ the closed `REQUIRED_EVIDENCE_KINDS` set). Both are **optional**, so an
  older client sending only `classification` / `warningText` / `note` is
  unchanged (zero regression). Malformed coordinates / proof kinds / blank labels
  are rejected at parse time — no fake shapes.
- **`normalisePatch`** — copies `deliveredBy` through verbatim (never a by-name
  guess; the compiler still validates each ref against the live structure →
  `task_not_found`), and maps `requiredEvidence` through, **deriving a stable id
  only when one is omitted** (see below). It never fabricates proof: an absent
  `requiredEvidence` stays absent.
- **`deriveRequiredEvidenceId(label)`** — FNV‑1a over the trimmed label (the
  repo's id-derivation idiom, cf. `deriveWorkPackageId`) → a stable `re_<hex8>`
  id. Re-authoring the same proof yields the same id, so a previously-recorded
  `EvidenceLink.requiredEvidenceId` keeps pointing at the same requirement across
  recompiles. An explicit `id` always wins.

The domain already supported this: `ScopeClauseClassificationSchema` has carried
`deliveredBy` / `requiredEvidence` since #366, `classifyClause` already accepts
them in its patch, and `compileWorkPackages` already reads `cc.deliveredBy` /
`cc.requiredEvidence`. **The only missing link was the producer input** — which
is all this slice adds. The compiler and routes are untouched.

## The authoring affordance — the documented route path

> **Update (admin UI follow-up):** a minimal admin **click-path** now wraps these
> routes — see [Admin click-path (UI)](#admin-click-path-ui) below. The route
> contract here is unchanged; the UI just builds these exact request bodies. The
> original #471 slice shipped routes-only because no admin reconciliation surface
> existed yet.

The authoring mechanism is the **already-shipped admin route path**, which carries
proof because it consumes the extended `ClassificationsInputSchema` unchanged:

| Step | Route | Body |
|---|---|---|
| L0 confirm | `POST /api/job-control/reconciliation/confirm` | `{ jobId, sourceHash?, classifications }` |
| L1 preview | `POST /api/job-control/compile/preview` | `{ jobId }` |
| L1 confirm | `POST /api/job-control/compile/confirm` | `{ jobId, sourceHash?, expectedRevision? }` |

All three are **admin-only**; the two writes use the authoritative HMAC-verified
gate ([ADR](job-control-runtime-adr.md)). A field-delivered clause authored with
proof looks like:

```jsonc
// POST /api/job-control/reconciliation/confirm
{
  "jobId": "job_100arthur",
  "classifications": {
    "sw_zip": {
      "classification": "priced",
      "deliveredBy": [{ "areaId": "area_east_gym", "stage": "fitOff", "taskId": "task_zip" }],
      "requiredEvidence": [
        { "label": "Circuit test before energising", "kind": "test_result", "note": "RCD trip time" }
      ]
    }
  }
}
```

Then `POST /api/job-control/compile/confirm { "jobId": "job_100arthur" }` writes
`jobs/job_100arthur/job-control.json` with a `wp_…` package whose
`requiredEvidence` holds that item. With no evidence links yet, Phil shows it
**unmet** — the state that lights up the #470 "Capture proof" button.

> Coordinates must be **real**. Read the job's structure first (areas/stages/
> tasks from `jobs.json`) and author `deliveredBy` against ids that exist; a
> coordinate that resolves to nothing compiles to a named `task_not_found` gap,
> never a silent task.

## Admin click-path (UI)

So Tom/admin can author proof **without DevTools JSON**, a minimal admin panel
wraps the three routes above. It is deliberately small — not a job-builder
redesign, not a visual workflow editor.

- **Where:** a new job sub-route `/v2/jobs/[jobId]/job-control`
  ([`page.tsx`](../../src/app/v2/jobs/[jobId]/job-control/page.tsx)), reachable
  from the job hub's section nav ("Job control" row). Admin-tier gated
  (`isAdminRole`); mirrors the other job sub-routes (auth gate → `/api/jobs?id=`
  → `AdminShell` + client panel).
- **Panel:**
  [`JobControlAuthoringPanel.tsx`](../../src/components/admin/JobControlAuthoringPanel.tsx)
  — one top-to-bottom flow: **scope clause → worker task → required proof →
  compile for Phil**. The clause comes from `Job.scopeOfWork[]`; the
  area/stage/task come from the real structure (`effectiveTasks`); the
  classification select offers only the field-delivering set (`priced` /
  `general_allowance` / `pc_provisional`, plain labels — never `field_delivered`).
- **Logic:**
  [`jobControlAuthoringClient.ts`](../../src/components/admin/jobControlAuthoringClient.ts)
  is the pure, fetch-injectable core (payload builders, save-gate, route wrappers,
  result summaries) — unit-tested without a browser (the repo has no RTL/jsdom).
  It omits the proof `id` so the L0 producer derives the stable `re_…` id
  (`deriveRequiredEvidenceId`).
- **Honesty:** raw ids never appear as primary labels (titles/names do; ids live
  in a "Developer details" foldout). It only ever sends real classifications +
  real task coordinates, never an invented id or a fabricated proof item; an
  empty scope renders an honest empty state.

The panel **reuses the existing routes** — no new endpoint, no compiler change,
no Phil/Capture change.

## Compiled proof status (admin read-only)

So the office can **audit** the loop — what proof was compiled, what's still
needed, what's been captured, and which evidence satisfied which requirement — a
read-only "Compiled proof status" section sits below the authoring panel on the
same `/v2/jobs/[jobId]/job-control` page.

- **Read path:** the admin page (already `isAdminRole`-gated) reads
  `jobs/<jobId>/job-control.json` **directly server-side** via
  [`runProofStatus`](../../src/server/job-control/status.ts) — exactly how the
  Phil page calls `read.ts`. **No new HTTP route** (lower surface). It WRITES
  NOTHING, compiles nothing, links nothing.
- **Met rule is shared:** `status.ts` derives needed/met with the SAME
  `isRequiredEvidenceMet` predicate Phil uses (extracted to
  [`task-context.ts`](../../src/domains/job-control/task-context.ts)) — office and
  field never disagree (P7, one source of truth). Met requires a matching
  `EvidenceLink` that carries a real proof (evidence or observation), never a
  photo count.
- **Admin-appropriate, still safe:** unlike the field read it MAY show the
  revision, source hashes and gap count; it still exposes no secrets / tokens /
  signed URLs (none live in the artifact) — the response is an explicit field
  allowlist, never a raw spread.
- **States:** no artifact (`missing`) → "save + compile first"; corrupt
  (`unreadable`) → surfaced; `compiled` → per-package needed/met with captured
  evidence + linked timestamp; Blob error → "Could not load…". Raw ids / source
  hashes only in a Developer foldout.
- Component:
  [`CompiledProofStatus.tsx`](../../src/components/admin/CompiledProofStatus.tsx)
  (pure presentational); counts/copy in
  [`jobControlStatusClient.ts`](../../src/components/admin/jobControlStatusClient.ts).

## Validation walkthrough (code-proven)

[`src/server/job-control/required-proof-authoring.test.ts`](../../src/server/job-control/required-proof-authoring.test.ts)
drives the **whole shipped chain** from authored classifications to the field
read, with no hand-built reconciliation:

```
author classifications (deliveredBy + requiredEvidence)
  → L0  prepareReconciliationConfirm           (scope-reconciliation envelope)
  → L1  prepareCompileConfirm                  (jobs/<jobId>/job-control.json)
  → L2/L3 buildPhilTaskContext                 (task shows requiredEvidence met:false)
```

It pins:

- authored field clause → package carries `requiredEvidence`, **no
  `no_delivering_task` gap**, and the read boundary returns the proof **unmet**;
- a field clause with **no `deliveredBy`** still emits `no_delivering_task` and no
  package;
- `deliveredBy` but **no `requiredEvidence`** → a package with **no** proof
  (never fabricated);
- a coordinate pointing at a missing task → a named `task_not_found` gap, not a
  silent task.

Producer-level coverage (id stability, schema rejection, envelope persistence)
lives in
[`reconciliation-producer.test.ts`](../../src/server/job-control/reconciliation-producer.test.ts).

## What this is NOT

- **Not** a job-builder redesign or a visual workflow editor — just a minimal
  three-step authoring panel on one job sub-route.
- **Not** a Phil / Capture change, **not** a compiler change, **not** a route
  change — the panel reuses the shipped L0/L1 routes, which already read these
  fields.
- **Not** a change to evidence save / evidence-link / revision-guard semantics.

## Field status

The route-based loop was **field-proven** on the validation job
`qa-seed-field-validation-job-required-proof-loop` (author → compile →
`requiredEvidence` with no gap → Phil "Capture proof" → worker captured →
needed → met); the deployed build's derived proof id matched
`deriveRequiredEvidenceId`. This follow-up makes the **admin authoring** step
usable without DevTools. Re-run the same validation through the admin UI to
confirm the click-path end-to-end.
