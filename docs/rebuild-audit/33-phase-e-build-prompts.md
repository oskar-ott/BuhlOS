# Phase E build prompts (paste-ready)

> **Status:** docs-only. Each prompt below is a self-contained autonomous-agent brief for a future Phase E build session.
> **Source plan:** [32-phase-e-plan.md](32-phase-e-plan.md).
> **Read before pasting:** [27-interface-usability-pass.md](27-interface-usability-pass.md) (UI rules), [phase-d55-snags-runbook.md](phase-d55-snags-runbook.md) (proven loop pattern), [12-domain-model-deep-dive.md](12-domain-model-deep-dive.md) (legacy schema audit).

---

## Prompt E1 — Build ITP / QA checklist foundation

```
You are Claude Code Max working on the BuhlOS / Phil repo.

This is the Phase E1 build session.

You have full repo/tool access and bypass permissions inside the scope below.

Build the ITP / QA checklist foundation.

Do not start E2 (RFIs).
Do not start E3 (Materials).
Do not change vercel.json.
Do not change public/*.html.
Do not change production rewrites.
Do not run manual vercel deploy.
Do not modify Phase B/C/D code unless fixing a genuine production blocker.

============================================================
CURRENT STATE
============================================================

origin/main is at or after commit 17f6da6 (PR #26 D.5 snags hardening merged).

Phase D fully shipped:
- D1 Jobs read-only
- D2 Evidence API + photos
- D3 Phil evidence capture UI
- D4 Admin evidence review at /v2/jobs/[jobId]/evidence
- D5 evidence hardening (audit-log read, un-review, drawer retry)
- D.5 Snags loop (api/snags.js, /v2/jobs/[jobId]/snags)
- D.5 hardening (canWrite normalization, write-through cache, 409 conflict)
- D6 Admin jobs index at /v2/jobs

Read [32-phase-e-plan.md](docs/rebuild-audit/32-phase-e-plan.md) before starting.

Read [phase-d55-snags-runbook.md](docs/rebuild-audit/phase-d55-snags-runbook.md) — your implementation will mirror this shape.

============================================================
SCOPE
============================================================

In scope:
- src/domains/itp/ (NEW domain) — schema, types, format, service, client, tests
- api/itps.js (NEW) — list, create, submit, review, reopen
- api/itp-templates.js (NEW) — template CRUD (REBUILD; legacy stub exists)
- api/audit-log.js — extend to accept targetType=itp
- api/_lib/audit-log.js — extend VALID_ACTIONS to include itp.instance.created / submitted / accepted / rejected / reopened
- src/domains/audit-log/ — schema + client updates for itp targetType
- src/components/phil/JobITPPanel.tsx (NEW)
- src/components/phil/ITPCompletionSheet.tsx (NEW)
- src/components/admin/ITPQueue.tsx (NEW)
- src/components/admin/ITPDrawer.tsx (NEW)
- src/components/admin/ITPRejectModal.tsx (NEW)
- src/app/v2/jobs/[jobId]/itp/page.tsx (NEW)
- src/app/v2/itp/templates/page.tsx (NEW; admin-tier only — may slip to E1.1)
- src/components/admin/ITPTemplateList.tsx (NEW; may slip to E1.1)
- src/middleware.ts — add /v2/itp/templates to PROTECTED with surface=admin
- scripts/smoke-evidence-routes.js — extend with itp routes (30+ checks total)
- scripts/auth-smoke-e1-itp.sh (NEW; full-lifecycle authenticated test)
- package.json — wire smoke:auth-e1-itp script
- docs/rebuild-audit/phase-e1-itp-runbook.md (NEW)
- docs/rebuild-audit/23-rebuild-index.md — add E1 entry to ship table

Out of scope:
- PDF / certificate generation
- Per-item rework (accept-whole / reject-whole only in E1)
- Client portal
- AI plan interpretation
- Stage completion blocked by ITP completion (toggleable, default OFF in E1)
- Snag auto-creation on rejected items
- RFIs (E2)
- Materials (E3)
- Legacy /admin/itp cutover

============================================================
DATA MODEL
============================================================

Use Zod (existing repo pattern from src/domains/snags/).

ITPTemplate:
- id (itpt_<nanoid>)
- name (≤120)
- description (≤1000, optional)
- jobType (optional, freeform)
- stage (roughIn | fitOff | any)
- items: ITPTemplateItem[]
- source (admin | system)
- createdById, createdByName, createdAt, updatedAt
- archived (bool — soft delete)

ITPTemplateItem:
- id (iti_<nanoid>)
- order (number)
- title (≤120)
- description (≤500)
- severity (critical | major | minor)
- requiresPhoto (bool)
- requiresNote (bool)

ITPInstance:
- id (itpi_<nanoid>)
- jobId, templateId, templateName (denormalised)
- stage, areaId, areaName (denormalised)
- status (in_progress | ready_for_review | accepted | rejected | closed)
- responses: ITPItemResponse[]
- rejectionReason (≤500, null until rejected)
- evidenceIds[], snagIds[] (cross-domain links)
- createdById/Name/At
- submittedById/Name/At
- reviewedById/Name/Role/At
- auditLogIds[]
- updatedAt

ITPItemResponse:
- itemId, itemTitle (snapshot)
- state (pass | fail | na)
- note (≤500, optional)
- evidenceIds[]
- respondedById/Name/At

State machine (must match server + UI):
- null → in_progress (create — admin/LH)
- in_progress → ready_for_review (submit — field/LH)
- ready_for_review → accepted (review — admin/LH, four-eyes)
- ready_for_review → rejected (review — admin/LH, four-eyes, reason required)
- rejected → in_progress (worker fixes)
- accepted → closed (admin)
- closed → ready_for_review (admin re-opens)

Four-eyes rule: reviewer.id !== createdById AND reviewer.id !== submittedById.
Server enforces; UI hides buttons when viewer would fail.

============================================================
STORAGE
============================================================

Templates: itp-templates.json at blob root.
Instances: jobs/<jobId>/data.json adds itpsV1[] array.

Use:
- readBlob for normal reads (write-through cache from PR #26)
- readBlobFresh + 750ms wait on canTransition reject (mirror of snags)
- writeBlob (write-through cache)
- Audit dual-write (new monthly + legacy job-audit)

Return canonical updated instance from every mutation API.

============================================================
ROUTES + API
============================================================

GET /api/itp-templates — list (auth-gated)
POST /api/itp-templates — admin-tier only
GET /api/itps?jobId= — list per-job
POST /api/itps?jobId= — admin/LH on assigned job, create instance
POST /api/itps?jobId=&action=submit — field/LH submit
POST /api/itps?jobId=&action=review — admin/LH four-eyes
POST /api/itps?jobId=&action=reopen — admin only
GET /api/audit-log?targetType=itp&targetId= — extend D5 pattern

Error conventions:
- 400 = request validation (invalid body, missing required, too long)
- 401 = unauthenticated
- 403 = role / job access denied / four-eyes violation
- 404 = job or itp not found
- 409 = state-machine conflict (transition not allowed from current status)
- 500 = unexpected

============================================================
PHIL UX
============================================================

Add JobITPPanel below JobSnagsPanel on /phil/jobs/[jobId].

Panel:
- Header: "Inspections" + "N to do" pill
- Empty state: "No inspections assigned for this job."
- Active list: needsWorkerAttention semantics (in_progress + ready_for_review + rejected)
- Rejected snag-style rose alert with reason inline
- Primary action: "Open inspection" → ITPCompletionSheet

ITPCompletionSheet (full-screen):
- Header: template name + scope chip
- Body: scrollable per-item list
- Each item: title (≥18px), criteria muted, severity pill, pass/fail/na 3-button grid (≥48px tap targets)
- Note input if requiresNote or state=fail
- "Attach photo" button — opens existing capture sheet OR picks from job's recent evidence
- Footer: "Submit for review" (disabled until valid)
- Auto-save draft to localStorage keyed by itpInstanceId

Strict rules:
- ≥48px tap targets everywhere (doc 27 §4)
- Rejection reason inline (same pattern as snag PR #20)
- No dense tables in Phil
- No fake data

============================================================
ADMIN UX
============================================================

/v2/jobs/[jobId]/itp:
- ITPQueue (mirror of SnagsQueue)
- Active / Done / All filter (default = Active)
- Status-first rows: status pill, template + scope, submitter, when
- Per-row primary next-step button (Accept / Reject / View)
- Four-eyes: if viewer would violate, show "You created/submitted this — pass to another reviewer"
- LH sees read-only on instances they submitted

ITPDrawer (mirror of SnagDrawer):
- Header: template name + scope + status pill
- Body: per-item responses with evidence thumbnails + notes
- Footer: Accept / Reject (gated by four-eyes), Re-open (if closed)
- History: full audit-log of transitions

ITPRejectModal (mirror of SnagRejectModal):
- Required reason, ≤500 chars, counter visible.

/v2/itp/templates (may slip to E1.1):
- Admin-tier only
- Template list + create + edit (immutable once instances exist; create new version)

============================================================
TESTS
============================================================

Vitest:
- src/domains/itp/itp.test.ts — schema + state machine + four-eyes + validation
- src/components/admin/itp-filter.test.ts (mirror of evidence-filter.test.ts)

Playwright:
- tests/phase-e1-itp.spec.ts — route-gate active, authenticated flows .describe.skip(...)

Scripts:
- scripts/smoke-evidence-routes.js — add itp checks
- scripts/auth-smoke-e1-itp.sh — full lifecycle (submit, four-eyes accept, reject)

Required passing checks:
- npm run typecheck
- npm run lint
- npm run test (target: 400+ tests after E1)
- npm run build
- npm run check:admin-shell
- npm run check:sw-cache-version
- npm run check:production-shell
- npm run smoke:admin-routes

============================================================
DESIGN RULES (BINDING)
============================================================

From doc 27 §3 + §4 + §5 + §6:
- One primary action per screen
- Status-first rows
- 5-tone palette (info / success / danger / warning / neutral)
- ≥48px tap targets on Phil
- No three-dot menus for primary actions
- No KPI cards before real data
- No fake metrics
- No alert() / confirm() / prompt()
- Rejection reason inline (doc 27 + snag PR #20)

============================================================
BOUNDARIES
============================================================

DO NOT:
- run `vercel deploy`
- change vercel.json
- modify public/*.html
- delete branches
- force-push without --force-with-lease
- expose credentials
- commit secrets
- leave temp cookie jars
- start E2 (RFIs)
- start E3 (Materials)
- modify Phase B/C/D code (unless fixing a real blocker)
- skip the design rules

DO:
- create branch phase-e-e1-itp
- run all checks
- push PR
- preview-test
- request smoke results from operator (sandbox egress blocks buhlos.com)
- merge if all green
- production smoke after merge

============================================================
COMMIT / PR
============================================================

Branch: phase-e-e1-itp

Commit message starts with:
Phase E1 · ITP / QA checklist foundation

PR title:
Phase E1 · ITP / QA checklist foundation

PR body must include:
- summary
- data model
- state machine
- routes + APIs
- in scope / out of scope
- four-eyes enforcement
- test coverage
- preview checklist
- production risk

============================================================
REPORT FORMAT
============================================================

After merge + production smoke, produce:

# Phase E1 ITP Build Report

## Starting state
## What shipped
## State machine
## API contract
## Phil UX
## Admin UX
## Tests
## Preview
## Production
## Test data
## Confirmations (no Phase E2/E3, no vercel.json, no rewrites, no credentials)
## Next recommended action (E1.1 hardening if needed; E2 planning otherwise)
```

---

## Prompt E1-QA — Verification + cleanup after E1 build

```
You are Claude Code Max working as the post-E1 QA session.

E1 (ITP / QA checklist foundation) has been built and merged.

Your job:
1. Verify production health.
2. Authenticated-test the full ITP lifecycle.
3. Document any bugs found.
4. If bugs found, fix only the smallest blocker on a hardening branch.
5. Cleanup test data.
6. Report.

Do not:
- start E2 (RFIs)
- start E3 (Materials)
- run manual vercel deploy
- change vercel.json
- modify Phase B/C/D code

============================================================
VERIFICATION CHECKLIST
============================================================

Unauthenticated smoke:
- npm run smoke:evidence-routes — must pass 30+/30+
- /v2/jobs/[jobId]/itp gated (307 redirect)
- /api/itps unauth → 401 JSON
- /api/itp-templates unauth → 401 JSON
- /api/audit-log?targetType=itp unauth → 401 JSON

Authenticated smoke:
- npm run smoke:auth-e1-itp — full lifecycle

Manual UI test (from doc 32 §15 pilot script):
- Admin creates a TEST E1 ITP TEMPLATE
- Admin assigns instance to Birdwood IV3232
- Tradie opens /phil/jobs/birdwood-iv3232, sees inspection in JobITPPanel
- Tradie completes items, attaches photo evidence, submits
- Admin OTHER (four-eyes) reviews — accepts
- Refresh Phil — status flips to "Accepted"
- Repeat: tradie creates another, admin rejects with reason
- Refresh Phil — rejected with reason visible inline (rose alert)
- Verify audit-log has all transitions

Four-eyes negative test:
- Same admin who created instance tries to accept → 403 with friendly message
- Same admin who submitted (if admin can submit) tries to accept → 403

Regression:
- Snags still work on /v2/jobs/birdwood-iv3232/snags
- Evidence still works on /v2/jobs/birdwood-iv3232/evidence
- Hours approvals still work
- Gear still works
- /v2/jobs index counters still correct
- Legacy routes still serve

============================================================
TEST DATA CLEANUP
============================================================

After tests pass, drive the TEST E1 ITP instances through:
- in_progress → ready_for_review → accepted → closed
OR
- ready_for_review → rejected → in_progress → ready_for_review → accepted → closed

If template archive is implemented, archive the test template.
If not, leave it and report.

Report any remaining TEST E1 / TEST D55 records.

============================================================
REPORT FORMAT
============================================================

# Phase E1 QA Report

## Production state
## Authenticated smoke
## Manual UI test results
## Four-eyes negative tests
## Regression matrix
## Bugs found
## Hardening PR (if needed)
## Test data cleanup
## Next recommended action (E2 planning / E1.1 hardening / hold)
```

---

## Prompt E2 — RFI planning (FUTURE, not for this session)

```
You are Claude Code Max planning Phase E2 (RFIs).

E1 (ITP) has been live for at least 2 weeks. Field feedback collected.

Your job:
1. Read current state of E1 in production.
2. Read [12-domain-model-deep-dive.md §"RFI"] and [11-operational-workflow-map.md §21].
3. Decide if RFI is still the right E2.
4. Create planning doc only: docs/rebuild-audit/35-phase-e2-rfi-plan.md.

Reconsider: by the time E1 has been live a while, is RFI still useful, or has the snag + ITP loop covered most RFI use-cases?

If RFI still adds value:
- closed loop: worker raises → admin sends to architect/client → response logged → Phil sees answer
- data model: RFI + RFIResponse[] thread
- routes: /v2/jobs/[jobId]/rfis + /phil/jobs/[jobId] new panel
- API: similar shape to snags
- key difference: external response (email / link to architect)

If RFI is now stale (snags + ITP covered it):
- recommend skipping to E3 materials
- document why

Do not build app code.
Open PR with planning doc only.
```

---

## Prompt E3 — Materials planning (FUTURE, not for this session)

```
You are Claude Code Max planning Phase E3 (Materials).

E1 + E2 have shipped or been deferred.

Your job:
1. Read [11-operational-workflow-map.md §13 + §14] and [12-domain-model-deep-dive.md materials section].
2. Inspect existing legacy: api/materials-list.js, api/materials-summary.js, api/supplier-*.js.
3. Decide scope: is this materials REQUEST only, or full inventory + delivery + reconciliation?
4. Create planning doc only: docs/rebuild-audit/36-phase-e3-materials-plan.md.

E3 is intentionally hard. Materials request → PO → delivery → reconciliation → inventory is a full operational loop with external dependencies (suppliers).

Recommended E3 minimum: REQUEST + ADMIN APPROVE + DELIVERY CONFIRM. Defer PO / reconciliation / inventory to Phase F.

If E3 looks too big for one slice, split into E3a (request loop) and E3b (delivery + reconciliation) as separate plans.

Do not build app code.
Open PR with planning doc only.
```

---

## Cross-references

- [32-phase-e-plan.md](32-phase-e-plan.md) — source plan; binding.
- [34-phase-e-testing-checklist.md](34-phase-e-testing-checklist.md) — testing matrix.
- [25-phase-d-build-prompts.md](25-phase-d-build-prompts.md) — precedent (Phase D build prompts).
- [27-interface-usability-pass.md](27-interface-usability-pass.md) — UI rules (binding).
- [phase-d55-snags-runbook.md](phase-d55-snags-runbook.md) — proven loop pattern E1 mirrors.
