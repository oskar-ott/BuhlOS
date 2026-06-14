# Job-control data spine (#364)

> Status: **foundation, real.** A documented, typed link model — defined once,
> adopted by every issue that builds a piece of it. This is a **schema doc plus
> shared types, not a UI.** Code: [`src/domains/job-control/`](../../src/domains/job-control/)
> (`schema.ts`, `types.ts`, `spine.ts` + `spine.test.ts`).

## 1. The problem this solves

BuhlOS's records are each real, but they don't form a chain. Scope lives in
`Job.scopeOfWork[]`, prices in quote-section blobs, work in areas/stages/tasks,
proof in evidence and observations, money in the hand-set `contractValue` /
`claimedToDate` scalars — and **nothing ties them together.** On the 100 Arthur
St reference job that disconnect is exactly where money leaks: the dedicated 20A
ZIP circuit exists as a quote row, a task on a wall, a photo on a phone and a
line in a progress claim, and reassembling claim support and closeout proof is
hand archaeology every month.

The spine is the connective tissue:

```
scope clause → BOQ line → work package → task → evidence → claim line → closeout
```

defined as one typed link model so a clause can be traced to the photo that
proves it happened — a lookup, not an excavation.

## 2. What already exists vs what's new

The spine **references** existing domains by id; it never duplicates them. This
table is the load-bearing audit — every issue that builds a piece of the chain
must check its work against it.

| Chain link | Carried today by | Type / field | New? |
| --- | --- | --- | --- |
| **Scope clause** | `Job.scopeOfWork[]` (#200, shipped) | `ScopeOfWorkItem` `{ id, title, detail, order }` — admin/LH read, redacted from field/client GET | **Exists.** Referenced by `ScopeOfWorkItem.id` (e.g. `sw_…`). |
| **BOQ line** | quotes-v2 blob (`quotes-v2/<id>.json`) | `QuoteLine` `{ id, kind, description, qty, unit, rate }` nested in `Quote.sections[].lines[]` | **Exists** as the priced line. Referenced by `BoqLineRef` `{ quoteId, sectionId, lineId }`. No standalone "BOQ" entity. |
| **Work package** | — | grouping of tasks with scope+price+claim provenance | **NEW** — `WorkPackage`. Provenance **on** existing areas/stages/tasks, *not* a parallel task system. |
| **Task** | `jobs.json` structure + `dwellings` state | `JobAreaGroup → JobArea → JobTaskTemplate`; stage `JobStage = "roughIn" \| "fitOff"`; completion in `dwellings[areaId][stage].tasks[taskId]` (canonical [`progress.ts`](../../src/domains/jobs/progress.ts) #198) | **Exists.** Referenced by `TaskRef` `{ areaId, stage, taskId }` — the same coordinate evidence/observations already use. State is **never** copied onto the spine. |
| **Evidence** | per-job evidence + observations stores | `EvidenceItem` `{ id, jobId, areaId?, taskId?, stage?, kind, source }`; typed `ObservationItem` (variation/defect/blocker/…) | **Exists.** The *link* proof→spine-node is new: `EvidenceLink`. |
| **Claim line** | hand-set scalar `Job.claimedToDate` (api/jobs.js) | one number, no lines | **NEW** — `ClaimLine`. The scalar stays; lines reconcile against it (`reconcileClaimedToDate`). |
| **Closeout requirement** | — (nothing) | — | **NEW** — `CloseoutRequirement`, satisfied-by a `Document` / `ITPInstance` / `EvidenceLink`. |

Also referenced, never duplicated: `Document` (plan/spec/certificate register, with
`supersedes`/`supersededBy` lineage), `ITPInstance` (Checks), `MaterialRequestItem`.

## 3. The new entities

All schemas use the house `.passthrough()` pattern so the calculator/claims/
closeout children (#372/#374/#193/#214) can add fields without breaking older
parsers. Full definitions: [`schema.ts`](../../src/domains/job-control/schema.ts).

- **`WorkPackage`** `{ id: wp_…, jobId, title, scopeClauseIds[], boqLineRefs[],
  taskRefs[], order, notes? }` — the unit the job is managed and claimed by. It
  ties agreed scope (`scopeClauseIds` → `Job.scopeOfWork[].id`) to the priced
  lines that fund it (`boqLineRefs` → quote lines) and the existing tasks that
  deliver it (`taskRefs` → area/stage/task coordinates). **Provenance only — it
  references tasks, never replaces them.** The compile child #367 produces these.
- **`ClaimLine`** `{ id: cl_…, jobId, claimRef?, periodLabel?, description,
  workPackageId?, boqLineRefs[], claimedAmount, status, order }` — one line of a
  progress claim. The claim *header* (the monthly document + its
  submission/approval lifecycle + the Payapps-ready export) is #372; this is the
  line shape #372 builds on. `claimedAmount` is the office's number — helpers
  **sum** claim lines, they never derive a claim from work.
- **`EvidenceLink`** `{ id: el_…, jobId, evidenceId?, observationId?,
  workPackageId?, claimLineId?, closeoutRequirementId?, role }` — ties a piece of
  proof (an `EvidenceItem` or a variation/defect `ObservationItem`) to a spine
  node. `role ∈ { progress, closeout, variation, defect_rectification }`. A link
  must have a proof side **and** a node side (`validateEvidenceLink`).
- **`CloseoutRequirement`** `{ id: cr_…, jobId, title, kind, scopeClauseIds[],
  workPackageId?, documentId?, itpInstanceId?, evidenceLinkId?, status, order }` —
  an obligation that must be discharged to close the job (as-builts issued, every
  ZIP circuit tested + ITP signed, O&M manual delivered). The closeout *matrix*
  that generates these from job obligations is #374; this is the requirement
  shape #374 produces.

**Id conventions.** New entities carry a typed prefix so they're greppable and
never collide across stores: `wp_`, `cl_`, `cr_`, `el_` (see `ID_PREFIXES` in
`schema.ts`). Referenced entities keep their own ids (scope clauses `sw_…` per
#200; quote lines, evidence, documents, ITP instances use their domain's ids).

## 4. Per-job blob homes (v1) and the Supabase future

**v1 storage is blob-first**, mirroring how evidence/observations/documents are
stored per job today.

| Store | Home | Owner |
| --- | --- | --- |
| Scope clauses | `jobs.json` → `job.scopeOfWork[]` | jobs domain (#200) |
| BOQ / quote lines | `quotes-v2/<id>.json` | quoting domain (#183) |
| Tasks + task state | `jobs.json` + `jobs/<id>/data.json` (`dwellings`) | jobs domain |
| Evidence / observations / documents / ITP | existing per-job stores | their domains |
| **The spine** (work packages, claim lines, closeout requirements, evidence links) | **`jobs/<jobId>/job-control.json`** | this domain — `JobControlSpine` |
| Scope-vs-quote reconciliation (#366) | its own per-job store (e.g. `jobs/<jobId>/scope.json`) — finalised by #366 | reconciliation overlay that the compile child #367 reads to **produce** work packages |

**Supabase note.** Phase 1 (the applied 31-table schema,
`supabase/migrations/20260611142758_phase1_core_schema.sql`) contains **no**
quote, scope, BOQ, work-package, claim or closeout tables — it covers the
field→office operational loop only (evidence/snags/observations/material
requests/ITP/time entries). So the spine entities are **blob-first** until a
Phase 2 migration lands. The future table shapes, sketched so the #152 importers
aren't surprised:

```
work_packages       (id, job_id, title, order, notes, created_at, created_by)
work_package_scope  (work_package_id, scope_clause_id)            -- m:n to scope
work_package_boq    (work_package_id, quote_id, section_id, line_id)
work_package_tasks  (work_package_id, area_id, stage, task_id)    -- provenance, FK to tasks
claim_lines         (id, job_id, claim_ref, period_label, work_package_id,
                     description, claimed_amount, status, order, created_at)
evidence_links      (id, job_id, evidence_id, observation_id, work_package_id,
                     claim_line_id, closeout_requirement_id, role)  -- extends the
                     -- Phase-1 evidence_links table, which today links evidence↔snag
closeout_requirements (id, job_id, title, kind, work_package_id, document_id,
                     itp_instance_id, evidence_link_id, status, order)
closeout_req_scope  (closeout_requirement_id, scope_clause_id)
```

Scope clauses and quote lines get their own Phase-2 tables (`scope_clauses`,
`quote_lines`); the m:n bridge tables above then become real foreign keys. The
blob `legacy_id` convention Phase 1 already uses carries the blob ids across.

## 5. The shared helpers

[`spine.ts`](../../src/domains/job-control/spine.ts) — pure, no I/O. The
sibling issues build on these signatures:

- `traceClause(spine, scopeClauseId)` → walk one clause to its packages, BOQ
  lines, tasks, claim lines, evidence and closeout obligations (§6).
- `validateEvidenceLink(link)` → a link must connect proof to a spine node.
- `claimedTotalForPackage` / `jobClaimedTotal` → sum recorded claim amounts.
- `reconcileClaimedToDate(spine, job.claimedToDate)` → surface drift between the
  hand-set headline and what the claim lines actually support — the exact place
  100 Arthur St money leaks. Counts `approved` + `paid` lines by default.
- `closeoutProgress(spine)` → tally requirements; a percentage exists only where
  there's something to measure (null otherwise — never a fake 0% / 100%, the
  `progress.ts` rule).
- `findDanglingRefs(spine, knownIds)` → references that point at nothing. Always
  checks links internal to the spine; checks outward refs only for the id sets
  the caller supplies (no false positives when the caller hasn't loaded a domain).
- `taskRefKey` / `boqLineRefKey` → stable coordinate keys.

## 6. Worked example — 100 Arthur St, the East Gym ZIP circuit

One scope clause traced end to end (the headline test in
[`spine.test.ts`](../../src/domains/job-control/spine.test.ts)):

| Stage | Record | Real id / coordinate |
| --- | --- | --- |
| Scope clause | `Job.scopeOfWork[]` item | `sw_zip_east_gym` — "dedicated 20A ZIP circuit, East Gym" |
| BOQ line | quote line in `quotes-v2/<id>.json` | `BoqLineRef { q_100arthur, sec_power, ql_zip_20a }` |
| Work package | `WorkPackage` | `wp_east_gym_zip` — names the clause + the BOQ line |
| Task | area/stage/task in `jobs.json` | `TaskRef { area_east_gym, fitOff, task_zip_circuit }` |
| Evidence | `EvidenceLink` → `EvidenceItem` | `el_zip_photo` → `ev_zip_tested` (role `progress`) |
| Claim line | `ClaimLine` | `cl_zip_claim3` — "Claim 3", `$1,850`, status `approved` |
| Closeout | `CloseoutRequirement` | `cr_zip_itp` — "tested & ITP signed", → `itp_zip_east_gym` |

`traceClause(spine, "sw_zip_east_gym")` returns exactly this set — the package,
its one BOQ line and task, the claim line, the evidence link and the closeout
obligation — and nothing from the unrelated reception package. That is the
"lookup instead of archaeology" the user story asks for.

## 7. Adoption — the children that build the pieces

This doc and the shared types are the contract. Each builder references the
types above and is checked against them at its review:

- **#366** scope-vs-quote reconciliation → its forced classification feeds the
  compile child; it does not duplicate `ScopeOfWorkItem` or `QuoteLine`.
- **#367** compile reconciled scope into `WorkPackage[]` with provenance —
  `scopeClauseIds` + `boqLineRefs` + `taskRefs`, never a parallel task tree.
- **#368** Phil scope-context on the task reads `WorkPackage` provenance for a
  `TaskRef` (model only until the #132 field-review freeze lifts).
- **#372** progress claims write `ClaimLine[]`; `reconcileClaimedToDate` guards
  the scalar.
- **#374** closeout matrix generates `CloseoutRequirement[]`.
- **#152** Supabase importers adopt the Phase-2 table sketches in §4.

## 8. Non-goals (v1)

- No UI and no API — purely the typed link model and pure helpers.
- No write path yet: `job-control.json` is the documented home; the first writer
  is the compile child #367.
- No invented numbers: claim totals are sums of recorded `ClaimLine.claimedAmount`,
  never derived from task progress; closeout fractions are null when empty.
