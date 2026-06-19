# Structured electrical test records (#517)

> **Status:** the pure domain shipped (schema + the one pass/fail rule +
> derivation + tests). The thin persistence API and the proof-loop link are
> scoped below as the next slices. Part of the job-control QA/reporting story
> (see [proof-review-model.md](proof-review-model.md) and
> [itp-qa-status-readback.md](itp-qa-status-readback.md)).

## What this is

An electrician records measured circuit results — continuity, insulation
resistance, polarity, earth-fault-loop `Zs`, RCD trip — as a **TestRecord**: a
facet of a task (optional `areaId/stage/taskId`) under a job, with one row per
circuit. Each row's **pass/fail/na is DERIVED from the measured value against its
min/max limits**, never asserted by the client. This is what lets a TestRecord
honestly stand as `test_result` proof: a row with no value, or a value outside
its limits, cannot read "pass".

## Shipped (pure domain — `src/domains/test-records/`)

- **`criteria.ts` — the ONE rule.** `evaluateAgainstCriteria(value, min, max)`
  → `"pass" | "fail" | null`. The single source of truth for "does this number
  meet its limits" across the product. `null` (→ "na") when there is no criterion
  or no numeric value (a missing value is never coerced to a 0 that could
  "fail"). **ITP's `valuePassFail` (`src/domains/itp/format.ts`) now delegates
  here** — one derivation engine, no drift (00-rebuild-non-negotiables: a value
  pass/fail has one rule).
- **`schema.ts`** — `TestRecord` / `TestRecordRow` Zod schemas + the test-type,
  report-type and status enums + the per-job store shape
  (`jobs/<jobId>/test-records.json`). `.passthrough()` for forward-compat.
- **`derive.ts`** — `deriveRowStatus`, `deriveOverallStatus`, and
  `buildTestRecord(input, ctx)` which re-derives every row's status (ignoring any
  client-smuggled status) and rolls up the overall result, then re-parses through
  the schema. Pure: id/time/actor injected.
- Tests: `criteria.test.ts`, `test-records.test.ts` (bounds, NaN/null/empty,
  per-circuit derivation, overall roll-up, "a fabricated pass is ignored").

## Next slice A — persistence API (thin)

A TS App Router route `src/app/api/test-records/route.ts` (NOT a legacy
`api/*.js` — that can't import the typed domain, per the job-control runtime
ADR):

- `GET ?jobId=` → list a job's records (auth: admin or assigned worker).
- `POST` → `TestRecordInputSchema.parse` → `buildTestRecord` (server-derives
  `status`) → append to `jobs/<jobId>/test-records.json`.
- A small `src/server/test-records/store.ts` (mirror `src/server/job-control/blob.ts`).
- **Register `jobs/<jobId>/test-records.json` in `api/_lib/backup-manifest.js`**
  before the first real write (the `check:backup-manifest` guard + the ADR
  require this for any new blob key).
- Verify on the PR preview (Blob needs a token; `next dev` can't exercise it).

## Next slice B — satisfy `test_result` proof (touches the shared met rule)

To let a TestRecord flip a `test_result` required-evidence to **met**, add a
third proof id to the job-control evidence link. This is purely additive (an
extra arm of the existing `evidenceId || observationId` OR) but it touches the
single source of truth for proof, so it is its own slice with its own review:

1. `EvidenceLinkSchema` (+ `EvidenceLinkRequestSchema`): add
   `testRecordId: z.string().nullable().optional()`.
2. The met rule — `isRequiredEvidenceMet` / `isRequiredEvidenceMetForTask`
   (`task-context.ts`): extend the proof-presence check
   `Boolean(el.evidenceId || el.observationId)` to include `el.testRecordId`.
3. The writer (`evidence-link.ts`): `evidenceLinkRequestHasProof` / `proofId` /
   the idempotency identity include `testRecordId`; **#513**'s
   `loadJobProofIds` / `KnownProofIds` gains `testRecordIds` (read from
   `jobs/<jobId>/test-records.json`) and the existence guard checks it.
4. `findDanglingRefs` (`spine.ts`): add a `testRecordIds` known set + an
   `el.testRecordId` check; the admin status read passes it.
5. `status.ts` proof-status view: include `testRecordId` in the matching filter
   and the `ProofEvidenceLinkView`.

Because of (2)/(3) this lands honestly: **#513** guarantees a link can only mark
a requirement met when the referenced test record actually exists.
