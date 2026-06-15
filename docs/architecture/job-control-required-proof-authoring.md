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

There is **no admin reconciliation/scope UI** in the product today, and building
one (clause list + per-clause classification + task picker + proof authoring) is
the visual-job-builder work this slice deliberately does not do. The authoring
affordance is therefore the **already-shipped admin route path**, which now
carries proof because it consumes the extended `ClassificationsInputSchema`
unchanged:

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

- **Not** field-proven. This is code-level proof; a real phone / real compiled
  job field pass is the recommended next step.
- **Not** a new UI, not a redesign of the admin app, not a visual job builder.
- **Not** a compiler change — the compiler already read these fields.
