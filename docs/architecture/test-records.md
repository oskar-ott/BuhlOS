# Structured electrical test records (#517)

> **Status:** SHIPPED end-to-end — the pure domain, the thin persistence route,
> the proof-loop bridge (extend, never fork), the Phil capture sheet and the
> office read-back. The full submit→link→met loop needs PR-preview verification
> (`next dev` can't run `api/*.js`). Part of the job-control QA/reporting story
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

## The pure domain — `src/domains/test-records/`

- **`criteria.ts` — the ONE rule.** `evaluateAgainstCriteria(value, min, max)`
  → `"pass" | "fail" | null`. The single source of truth for "does this number
  meet its limits" across the product. `null` (→ "na") when there is no criterion
  or no numeric value (a missing value is never coerced to a 0 that could
  "fail"). **ITP's `valuePassFail` (`src/domains/itp/format.ts`) delegates here** —
  one derivation engine, no drift (00-rebuild-non-negotiables: a value pass/fail
  has one rule).
- **`schema.ts`** — `TestRecord` / `TestRecordRow` Zod schemas + the test-type,
  report-type and status enums + the per-job store shape
  (`jobs/<jobId>/test-records.json`). `.passthrough()` for forward-compat.
  `supersedesId` carries the AC3 correction link.
- **`derive.ts`** — `deriveRowStatus`, `deriveOverallStatus`,
  `buildTestRecord(input, ctx)` (re-derives every row's status, ignoring any
  client-smuggled status, and rolls up the overall result, then re-parses through
  the schema) and `summariseTestRecord` (the honest one-line "N circuits, overall
  pass" used for the companion evidence note + the read-backs). Pure: id/time/actor
  injected.
- Tests: `criteria.test.ts`, `test-records.test.ts` (bounds, NaN/null/empty,
  per-circuit derivation, overall roll-up, "a fabricated pass is ignored",
  summary, supersedesId).

## Persistence — `src/server/test-records/store.ts`

A pure `applyTestRecord` (append a record built via `buildTestRecord`) +
injectable I/O deps (`TestRecordDeps`) + `blobTestRecordDeps()` over
`jobs/<jobId>/test-records.json` (a `TestRecordStoreSchema`). Mirrors the L0–L4
job-control producers.

- **IMMUTABLE + SUPERSEDE-BY-REVISION (AC3).** A record is never edited in place.
  A correction is a NEW record carrying `supersedesId` pointing at the record it
  replaces; the prior record stays byte-identical in the store. A `supersedesId`
  that names a record not present is rejected (no dangling correction).
- **SERVER-AUTHORITATIVE DERIVATION.** Pass/fail is always re-derived here via
  `buildTestRecord`; a client-asserted `status` is ignored.
- Fail-closed read: an unreadable store is never clobbered (409, no write); a
  missing store is the normal first-write case (an empty store is used).

## Route — `src/app/api/job-control/test-records/route.ts`

A TS App Router route (NOT a legacy `api/*.js` — that can't import the typed
domain, per the job-control runtime ADR). `force-dynamic` + `runtime nodejs`.

- **POST** (create): field-gated exactly like the evidence-link route — 401 with
  no session, 403 `!canAccessSurface(role,'phil')`, then the existing
  `/api/jobs?id=` assignment gate (403s a worker not assigned to the job). Parses
  the body, writes the record (server-derives pass/fail), then mints the companion
  evidence (below). Returns `{ ok, record, evidenceId }`.
- **GET** `?jobId=` → list a job's records for review. Admin tier reads any job;
  an assigned field worker reads their own job (same assignment gate); other roles
  403.

## The proof-loop bridge — **EXTEND, NEVER FORK** (the #517 decision)

> This **supersedes** the earlier "Next slice B" sketch (which proposed adding a
> `testRecordId` proof arm to `EvidenceLink` and extending `isRequiredEvidenceMet`
> / `isRequiredEvidenceMetForTask` / `validateEvidenceLink` / `loadJobProofIds`).
> That would FORK the proof loop's single source of truth across 4+ sites. The
> "extend, never fork" rule (00-rebuild-non-negotiables; the job-control runtime
> ADR) forbids it.

Instead, a TestRecord satisfies a `test_result` required-evidence item by minting
a **real companion `EvidenceItem`** at submit:

- `api/evidence.js` gains a `'test_result'` kind (in `VALID_KINDS`; mirrored in
  `src/domains/evidence/schema.ts`'s `EVIDENCE_KINDS`). The companion row is
  summary-only — it carries `testRecordId` (a pointer back at the numbers in
  `test-records.json`) + an honest one-line `note` (`summariseTestRecord`). It
  rides the SAME create path, so it inherits the audit dual-write + idempotency
  and lands in the SAME `jobs/<jobId>/data.json#evidence[]` array that the proof
  loop's `loadJobProofIds` reads.
- `src/server/test-records/evidence-bridge.ts` (`mintTestResultEvidence`) POSTs
  that companion evidence (server→server, forwarding the worker's cookie + an
  `Idempotency-Key: test-record:<id>` so a retry returns the same row) and returns
  the real `ev_…` id.
- The Phil flow then runs the EXISTING
  `linkAndApply({ evidenceId, workPackageId, requiredEvidenceId, expectedJobControlRevision, taskRef })`
  — the SAME pathway photo/note proof uses. The requirement flips to met through
  the **UNCHANGED** `applyEvidenceLink` + `isRequiredEvidenceMet`
  (`Boolean(el.evidenceId || el.observationId)`). No `testRecordId` arm was added
  to `EvidenceLink`; `isRequiredEvidenceMet` / `isRequiredEvidenceMetForTask` /
  `validateEvidenceLink` / `loadJobProofIds` are touched in ZERO places.

Because the link references a real, existing evidence id, **#513**'s trusted-proof
guard already protects it — a requirement can only be marked met by a proof that
provably exists.

## Field capture — Phil

`PhilTestRecordCard.tsx`: opened from a task's "Proof needed" list when the
required item's `kind === 'test_result'` (the photo/note CaptureSheet handles the
other kinds; `PhilTaskScopeContext` routes on `kind`). One circuit at a time,
numeric keypads (`inputMode="decimal"`), operator-entered min/max, a DERIVED
pass/fail shown LIVE via `deriveRowStatus` **for display only** (the server
re-derives authoritatively). Site language (P11), no fake numbers — no verdict
shows until a reading + a limit are entered (P7). The thin `testRecordClient.ts`
POSTs and returns the minted `evidenceId`; `PhilJobDetail` then links it.

## Office read-back — BuhlOS

`TestRecordsPanel.tsx` on `/v2/jobs/[jobId]/job-control` (AC2): read-only circuits
+ measured values + server-derived status + tester/timestamp, with a superseded
record marked. `/qa` already reflects at the requirement-met level via the shared
rule (no `/qa` change).

## Guards / ops

- `jobs/<jobId>/test-records.json` is registered (named) in the `jobs/` prefix
  comment of `api/_lib/backup-manifest.js` (the key is already covered by the
  prefix — no functional change).
