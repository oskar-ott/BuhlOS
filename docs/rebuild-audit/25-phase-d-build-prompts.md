# 25 · Phase D — Claude Code build prompts (D1–D6)

> **Paste-ready prompts** for every Phase D build slice. Each prompt is self-contained: scope, hard rules, preflight reads, checks, PR title, expected report. Each slice gets its own session, its own PR, its own preview verification, its own merge.
>
> **Source of scope truth:** [24-phase-d-jobs-evidence-plan.md](24-phase-d-jobs-evidence-plan.md) §13 (Build sequence). If anything below contradicts §13, §13 wins.
>
> **Pre-flight (binding for every slice):**
> - Phase C (PR #5) is merged to `main` and has had ≥7 days of quiet (per [16-migration-strategy.md] §E.3).
> - [24-phase-d-jobs-evidence-plan.md](24-phase-d-jobs-evidence-plan.md) is the approved plan; §15 decisions 1–7 are RESOLVED; §15.1 decisions 8–9 are answered or explicitly deferred.
> - Build session opens in a **fresh worktree**, not in Session 2's worktree.
> - `git status` is clean on the build branch.
>
> If any of the above is uncertain, **STOP and ask before writing code** ([20-agent-rules.md] #5, #29).

---

## Common preamble (every slice — read once per session)

Every build session begins by reading:

```
docs/rebuild-audit/24-phase-d-jobs-evidence-plan.md   ← Phase D plan (binding)
docs/rebuild-audit/27-interface-usability-pass.md     ← UX rules (binding)
docs/rebuild-audit/26-phase-d-testing-checklist.md    ← test gates (binding)
docs/rebuild-audit/20-agent-rules.md                  ← coding-agent rules
docs/rebuild-audit/10-product-definition.md           ← what BuhlOS / Phil are
docs/rebuild-audit/12-domain-model-deep-dive.md  §Jobs §Evidence §AuditLog
docs/rebuild-audit/13-ui-information-architecture.md  §Phil §Jobs §Admin/Jobs §Defects
docs/rebuild-audit/14-technical-architecture-deep-dive.md
docs/rebuild-audit/16-migration-strategy.md  §B Phase D row, §C.3 cutover sequencing
docs/rebuild-audit/17-testing-and-quality-plan.md  §C.4
docs/rebuild-audit/21-rebuild-decision-record.md  ADR-002, ADR-011, ADR-013, ADR-015
docs/rebuild-audit/19-phase-b-hours-implementation-brief.md  ← format precedent for Phase B
```

Then read the precedent code (every session):

```
api/jobs.js                       ← /api/jobs response shape + auth gating
api/_lib/auth.js                  ← requireAuth / canWrite / canManageJob
api/_lib/blob.js                  ← Vercel Blob R/W with TTL cache + in-flight dedupe
api/_lib/job-tasks.js             ← effectiveRoughInTasks / effectiveFitOffTasks
api/photos.js                     ← photo upload pattern (snag + ITP precedents)
api/task-toggle.js                ← patch-shape mutation precedent
src/lib/http.ts                   ← typed fetch wrapper + HttpResult<T>
src/lib/auth/*                    ← cookie / session / landingFor / permissions
src/domains/timesheets/schema.ts  ← Zod-with-passthrough pattern
src/domains/timesheets/client.ts  ← typed-client pattern with safeParse
src/domains/timesheets/timesheets.test.ts  ← unit-test pattern
tests/phase-b-hours.spec.ts       ← Playwright pattern
```

**Hard rules — every Phase D session:**

- Do NOT touch any branch other than the one you create for your slice.
- Do NOT touch the Session 2 (Phase C hardening) worktree.
- Do NOT deploy. Do NOT `vercel deploy` anything.
- Do NOT push to `main` directly.
- Do NOT bypass any pre-commit hook with `--no-verify`.
- Do NOT add `any` or `@ts-ignore`. Do NOT use `alert()` / `confirm()` / `prompt()` in product code.
- Do NOT use `window.location.href = ...` for in-app nav. Use `<Link>` / `useRouter()`.
- Do NOT add a `vercel.json` rewrite except in the explicitly-scoped cutover PRs (PR-D4, PR-D5).
- Do NOT add new API endpoints except the two explicitly approved in [24] §9.2 (photo `action=upload-evidence-photo` and `src/app/api/jobs/[jobId]/evidence/*`).
- Do NOT silent-fallback to fixtures. If API fails, render error UI.
- Do NOT write "Switchboard" or "Site Office" as user-facing strings.
- Do NOT mix two slices in one PR.
- **DO NOT put a client component (`"use client"`) next to a page that is ≥2 route segments deep.** This is the binding workaround for [24] risk D-26 (Next.js 15.5 RSC manifest bug, confirmed in production on `/hours/approvals`). Phase D client components live under `src/components/phil/` or `src/components/admin/`. Cross-check before you push: any new `*-client.tsx` or `"use client"` file under `src/app/phil/jobs/` or `src/app/(admin)/jobs/` is **wrong** and will 500 in production. Precedents that follow the rule: `src/components/phil/LogHoursSheet.tsx`, `src/components/admin/HoursApprovalsQueue.tsx`, `src/components/admin/SignOutButton.tsx`, `src/components/admin/AdminSidebar.tsx`.

**Every PR title** starts with `[Phase D]`.

---

## D1 · jobs domain + Phil jobs list & detail (read-only)

```
You are Claude Code working as the Phase D · D1 build session for BuhlOS / Phil.

Read first (common preamble + plan §13 D1):
  docs/rebuild-audit/24-phase-d-jobs-evidence-plan.md
  docs/rebuild-audit/25-phase-d-build-prompts.md  §Common preamble
  api/jobs.js                       — verbatim — for the response shape
  src/domains/timesheets/*          — pattern precedent for src/domains/jobs/*

Branch:     phase-d-d1-jobs-read-only   (from latest origin/main)
PR title:   [Phase D] D1 · jobs domain + Phil jobs list & detail (read-only)

============================================================
SCOPE
============================================================

You MAY add (this PR only):

  src/domains/jobs/schema.ts        Zod schemas for /api/jobs response.
                                    Use .passthrough() per timesheets precedent.
                                    Mirror real shape from api/jobs.js:111-187.
                                    Key fields: id, name, status, clientUserId,
                                    type, modules, customFields, ref,
                                    siteAddress, siteContactName, siteContactPhone,
                                    accessNotes, parkingNotes, safetyNotes,
                                    inductionRequired, startDate, dueDate,
                                    programmedDurationDays, areaGroups[],
                                    roughInTasks[], fitOffTasks[], createdAt.
                                    Schemas: JobSchema, JobAreaGroupSchema,
                                    JobAreaSchema, JobTaskTemplateSchema.
                                    Status enum: 'active' | 'complete' |
                                    'archived' | 'on_hold' | 'draft'.

  src/domains/jobs/types.ts         z.infer<> types.

  src/domains/jobs/fixtures.ts      Typed seed Jobs for tests. Include:
                                    - one job with 2 areaGroups, 3 areas each,
                                      roughInTasks + fitOffTasks
                                    - one job with no areaGroups (edge case)
                                    - one archived job (filter test)
                                    - one job with per-area task overrides
                                    isDemoMode() returns true in fixtures.

  src/domains/jobs/client.ts        Typed wrappers around /api/jobs.
                                    Functions:
                                      listMyJobs() — GET /api/jobs (server
                                        already filters by assignedJobIds for
                                        tradies; admin/client get their scope)
                                      getJob(jobId) — GET /api/jobs?id=<jobId>
                                    Both return HttpResult<T> per src/lib/http.ts.

  src/domains/jobs/service.ts       Pure helpers:
                                      byStatus(jobs, status)
                                      activeJobs(jobs)
                                      jobAddressLine(job) → string
                                      effectiveTasksForArea(job, area, stage)
                                        — wraps the legacy helper logic from
                                          api/_lib/job-tasks.js

  src/domains/jobs/jobs.test.ts     Vitest unit tests per [24] §10.1:
                                    - JobSchema parses every fixture
                                    - JobSchema rejects: missing required, bad
                                      status enum, bad date format
                                    - client.listMyJobs formats request correctly
                                    - client.getJob returns ok:false on 404
                                    - service helpers tested for each branch

  src/app/phil/jobs/page.tsx        Phil jobs list. Server component reads
                                    via listMyJobs(). Renders:
                                    - empty state: "No jobs assigned yet."
                                    - error state with retry
                                    - loading skeleton
                                    - list of jobs with name + status pill +
                                      address (one-line) + last-activity
                                    Each row links to /phil/jobs/[jobId].

  src/app/phil/jobs/[jobId]/page.tsx  SERVER component (no "use client";
                                    no useState in this file). Reads via
                                    getJob(jobId). Renders the static parts:
                                    - header: name + status pill + jobNumber
                                    - site context block: siteAddress,
                                      accessNotes, parkingNotes, safetyNotes,
                                      inductionRequired pill, contact name + phone
                                    - area groups → areas list (read-only;
                                      hide archived; show "no areas yet" if empty)
                                    Passes the job + areas data into
                                    <JobAreaPicker job={job} /> for the
                                    interactive area/stage/task chooser.
                                    Floating CTA bar shows "Capture
                                    evidence — coming in D2" UC pill (NOT
                                    a working button).

  src/components/phil/JobAreaPicker.tsx  "use client" component (must
                                    live HERE, not in src/app/phil/jobs/
                                    [jobId]/ — see binding rule §Hard
                                    rules above and [24] D-26):
                                    - stage chooser pills: Rough-in / Fit-off
                                      (defaults to roughIn; useState)
                                    - when an area + stage selected, shows
                                      effectiveTasksForArea(...) with task
                                      state pills (read-only in D1; toggle
                                      lands in D3)
                                    - emits selection up via callback prop
                                      (for D2 capture sheet integration)

  Update src/components/phil/PhilTabBar (and PhilShell if needed):
    - Jobs tab flips from UnderConstructionPanel to live route /phil/jobs
    - Snag tab REMAINS UC (decision §15.0 #1 — Phase D.5)

  tests/phase-d-d1-jobs-read-only.spec.ts  Playwright:
    - unauthenticated /phil/jobs redirects to /v2/login?next=/phil/jobs
    - unauthenticated /phil/jobs/test-job-id redirects
    - (skipped pending seeded test accounts) tradie login → /phil/jobs sees
      assigned jobs only; opens detail; sees area groups
    - Snag tab DOM has UC pill, no link

You MUST NOT (defer to later slice):

  - any capture sheet / photo upload / evidence schema    (D2)
  - any admin Phase D page                                (D4)
  - any new API endpoint                                  (D3 adds 1, D4 adds 1)
  - any vercel.json change                                (D4 + D5 only)
  - any cutover                                           (D4 + D5 only)
  - any change to api/*, public/*, scripts/*, src/app/(admin)/*
  - any change to existing src/domains/{timesheets,gear,auth}/*
  - any touch of Phase C branch or its worktree
  - any merge of this PR yourself

Before writing code:
  - read api/jobs.js fully (response shape is the source of truth)
  - read src/domains/timesheets/schema.ts (passthrough pattern)
  - read src/domains/timesheets/client.ts (HttpResult pattern)
  - read tests/phase-b-hours.spec.ts (Playwright pattern)
  - confirm /phil/jobs is NOT in vercel.json (it isn't — verify)

Checks before opening the PR:
  npm run typecheck             (zero errors)
  npm run lint                  (zero warnings)
  npm run test                  (all green; includes new jobs.test.ts)
  npm run build                 (succeeds)
  npm run check:admin-shell
  npm run check:sw-cache-version
  npm run check:production-shell
  npm run smoke:admin-routes
  npm run test:e2e              (Phase A + B + D1 specs all pass)
  git status                    (only src/domains/jobs/*, src/app/phil/jobs/*,
                                 PhilTabBar/PhilShell changes, tests/* touched)
  git diff --stat               (no api/, no public/, no vercel.json,
                                 no src/app/(admin)/* changes)

PR body must include:
  - link to docs/rebuild-audit/24-phase-d-jobs-evidence-plan.md §13 D1
  - confirmation D2/D3/D4/D5/D6 are separate upcoming PRs
  - rollback plan: revert the PR; no production cutover so blast radius is preview only
  - explicit "DemoModeBanner ON — fixtures only in D1; real data wires in D3"

Final report:
  - branch + base commit
  - files created / modified
  - command outputs for every check
  - any deviation from plan + why
  - PR URL
  - confirmation: no backend touched, no vercel.json, no cutover,
    no Phase C interference, Snag tab still UC
```

---

## D2 · evidence domain + Phil capture flow (fixtures only)

```
You are Claude Code working as the Phase D · D2 build session for BuhlOS / Phil.

Read first (common preamble + plan §13 D2):
  docs/rebuild-audit/24-phase-d-jobs-evidence-plan.md  §5.5 §8 §9.2 §11
  docs/rebuild-audit/25-phase-d-build-prompts.md  §Common preamble
  api/photos.js                — pattern for upload-evidence-photo action
  src/domains/jobs/*           — D1's jobs domain (must be merged to main)

Pre-flight: D1 PR must be merged to main + 24h quiet period.

Branch:     phase-d-d2-evidence-domain   (from latest origin/main, AFTER D1 merge)
PR title:   [Phase D] D2 · evidence domain + Phil capture flow (fixtures only)

============================================================
SCOPE
============================================================

You MAY add (this PR only):

  src/domains/evidence/schema.ts    Zod schemas for EvidenceItem per [24] §5.5.
                                    .passthrough() pattern.
                                    EvidenceItemSchema: id, jobId, areaId?,
                                    stage? ('roughIn'|'fitOff'|null), taskId?,
                                    kind ('photo'|'note'), photoId?, photoUrl?,
                                    thumbnailUrl?, note (≤280), capturedById,
                                    capturedByName, capturedAt, clientCapturedAt?,
                                    exifLocation?, status enum, reviewedById?,
                                    reviewedAt?, rejectionReason?, auditLogIds,
                                    createdAt, updatedAt.
                                    CreateEvidencePayloadSchema: jobId, areaId?,
                                    stage?, taskId?, kind, photoId?, photoUrl?,
                                    note?, clientCapturedAt.

  src/domains/evidence/types.ts     z.infer<> types.

  src/domains/evidence/fixtures.ts  Typed seed EvidenceItems.

  src/domains/evidence/client.ts    Typed wrappers. D2 ships only:
                                      uploadPhoto(jobId, dataUrl) — POSTs to
                                        /api/photos?jobId=<id>&action=upload-evidence-photo
                                      (the evidence-domain client.ts has a
                                       create() stub that returns a fixture
                                       EvidenceItem — wired to real endpoint
                                       in D3).

  src/domains/evidence/service.ts   Pure helpers:
                                      canTransition(from, to) — server-side
                                        truth lives in API, but client validates
                                        for UX (per [24] §5.5 status machine)
                                      resizeImageToDataUrl(file, maxDim=1920,
                                        quality=0.7) — client-side image resize
                                      humanFileSize(bytes)

  src/domains/evidence/evidence.test.ts  Vitest unit tests per [24] §10.1.

  src/components/phil/CaptureSheet.tsx  Client component (`"use client"`),
                                    full-screen modal. Reads jobId from a
                                    prop passed by the server component
                                    (NOT from useParams — the prop edge is
                                    what keeps the server/client boundary
                                    clean). LIVES IN src/components/phil/
                                    NOT src/app/phil/jobs/[jobId]/ per the
                                    binding RSC-manifest rule in this doc
                                    (see also [24] risk D-26 and PR #6's
                                    HoursApprovalsQueue extraction).
                                    Flow:
                                      1. Camera input <input type="file"
                                         accept="image/*" capture="environment">
                                         + gallery fallback button
                                      2. Image preview after pick
                                      3. Stage + area + task pickers (optional;
                                         pre-populated from the job's current
                                         context if available)
                                      4. Note input (≤ 280 chars, character
                                         counter)
                                      5. Submit button — disabled during in-
                                         flight POST. Calls
                                         resizeImageToDataUrl → uploadPhoto.
                                         IN D2: on success, simulate the
                                         second POST (evidence create) with
                                         a fixture response. D3 wires real
                                         endpoint.
                                      6. Pending / submitted state visible.
                                      7. Cancel button keeps draft in state
                                         (no auto-discard).

  Update src/app/phil/jobs/[jobId]/page.tsx:
    - floating CTA "Capture evidence" now opens the capture sheet (was UC)
    - small "Today's captures" strip showing the worker's OWN captures only
      (decision §15.0 #5) — shows fixture rows in D2

  api/photos.js                     ADD ONE NEW ACTION BRANCH ONLY.
                                    The new branch handles
                                    action='upload-evidence-photo':
                                      - mirror uploadSnagPhoto (line 44-74)
                                      - store to jobs/{jobId}/evidence-photos/{photoId}.jpg
                                      - return { id, url, capturedAt }
                                      - 6MB cap (same as snag/itp paths)
                                      - canWrite(user, jobId) gate
                                    ≤ 30 lines added. NO other changes to
                                    api/photos.js.

  tests/phase-d-d2-evidence-capture.spec.ts  Playwright + Vitest covering:
    - capture sheet opens from Phil job detail floating CTA
    - file selection → preview → submit cycle (fixture flow)
    - cancel preserves draft state
    - note > 280 chars blocked client-side
    - tests/api/photos-upload-evidence.test.ts integration test for the
      new action branch (mock fetch; assert response shape)

You MUST NOT:

  - wire the evidence create POST to a real endpoint        (D3)
  - build /api/jobs/[jobId]/evidence/route.ts               (D3)
  - build any admin page                                     (D4)
  - persist EvidenceItems for real (still fixtures in D2)
  - touch vercel.json or perform any cutover
  - add DOM-only re-implementation of any existing photo upload
    (use the existing api/photos.js action pattern)
  - touch src/domains/jobs/* beyond what's needed for CaptureSheet wiring
  - touch other api/*.js files
  - merge this PR yourself

Before writing code:
  - re-read api/photos.js uploadSnagPhoto (lines 44-74) — the exact pattern
  - re-read api/_lib/blob.js writeBlob / readBlob — the storage primitive
  - re-read [24] §5.5 status machine — server enforces, client validates

Checks before opening the PR:
  npm run typecheck
  npm run lint
  npm run test                  (includes new evidence.test.ts + API integration)
  npm run build
  npm run check:admin-shell
  npm run check:sw-cache-version
  npm run check:production-shell
  npm run smoke:admin-routes
  npm run test:e2e
  git diff --stat               (api/photos.js: +≤30 lines; no other api/
                                 changes; no public/, no vercel.json,
                                 no src/app/(admin)/* changes)

PR body must include:
  - explicit note: "DemoModeBanner ON for evidence — D3 wires real persistence."
  - rollback: revert the PR; api/photos.js new action is additive (no break).

Final report: as D1, plus confirmation the photo upload action returns
the expected { id, url, capturedAt } shape against a manual curl test.
```

---

## D3 · evidence persistence API + audit log + Phil real wiring

```
You are Claude Code working as the Phase D · D3 build session for BuhlOS / Phil.

Read first (common preamble + plan §13 D3):
  docs/rebuild-audit/24-phase-d-jobs-evidence-plan.md  §5.5 §5.9 §9.2 §9.4 §9.6
  docs/rebuild-audit/25-phase-d-build-prompts.md  §Common preamble
  api/task-toggle.js               — patch-shape mutation precedent
  api/_lib/blob.js                 — readBlob + writeBlob (full-doc write pattern)
  api/_lib/auth.js                 — canWrite / canManageJob

Pre-flight: D1 + D2 merged to main + 24h quiet period.

Branch:     phase-d-d3-evidence-persistence   (from latest origin/main)
PR title:   [Phase D] D3 · evidence persistence + audit log + Phil real wiring

============================================================
SCOPE
============================================================

You MAY add:

  src/app/api/jobs/[jobId]/evidence/route.ts
                                    Next.js App Router API route.
                                      GET    /api/jobs/[jobId]/evidence
                                        — list EvidenceItems for the job
                                        — query params: status, capturedBy,
                                          fromDate, toDate
                                        — server-side scope filter:
                                          - admin: all items
                                          - tradie: only capturedById === me.id
                                          - LH: all items on jobs they're
                                            assigned to (read-only)
                                          - client: 403
                                      POST   /api/jobs/[jobId]/evidence
                                        — create EvidenceItem
                                        — body validated by Zod (Create-
                                          EvidencePayloadSchema)
                                        — server validates: jobId exists,
                                          areaId belongs to job, stage in
                                          {roughIn,fitOff,null}, taskId
                                          resolves via effectiveRoughIn/Fit
                                          OffTasks
                                        — server sets: id, capturedById,
                                          capturedByName, capturedAt,
                                          createdAt, updatedAt, status='submitted'
                                        — appends to jobs/{jobId}/data.json
                                          under data.evidence[] (§9.4 Option A)
                                        — uses readBlob+writeBlob pattern from
                                          api/task-toggle.js
                                        — writes AuditLog entry

  src/app/api/jobs/[jobId]/evidence/[evidenceId]/review/route.ts
                                    POST    /review
                                        — body: { status: 'reviewed'|'rejected',
                                                  rejectionReason? }
                                        — admin only (403 otherwise)
                                        — server enforces transitions per
                                          [24] §5.5 status machine
                                        — server sets: reviewedById, reviewedAt
                                        — writes AuditLog entry
                                        — server requires rejectionReason when
                                          status='rejected'

  src/domains/audit-log/schema.ts   Zod schemas for AuditLog per [24] §5.9.
  src/domains/audit-log/types.ts
  src/domains/audit-log/client.ts   Append helper used by both new API routes.
                                    Storage: audit/{yyyy-mm}.json (append-only).
                                    Reuses api/_lib/blob.js.
  src/domains/audit-log/audit-log.test.ts

  src/domains/evidence/client.ts    UPDATE: create() now calls real
                                    /api/jobs/[jobId]/evidence POST instead
                                    of returning a fixture.
                                    review() and listForJob() wired to real
                                    endpoints.

  src/components/phil/CaptureSheet.tsx  UPDATE:
                                    - second POST (evidence create) now hits
                                      real /api/jobs/[jobId]/evidence
                                    - retry on POST-2 failure preserves
                                      photoId from POST-1 (no re-upload)
                                    - DemoModeBanner OFF for evidence on
                                      Phil pages

  src/app/phil/jobs/[jobId]/page.tsx  UPDATE:
                                    - "Today's captures" strip now reads real
                                      data via evidence.listForJob(jobId)
                                      filtered to capturedById === me.id

  src/lib/storage/blob.ts           NEW typed wrapper around
                                    /api/jobs/[jobId]/evidence client. Mirrors
                                    api/_lib/blob.js conventions on the server-
                                    facing side (typed helpers used by the new
                                    API route handlers).

  tests/phase-d-d3-evidence-persistence.spec.ts
                                    - tradie captures photo + note → API
                                      returns 200 with EvidenceItem → item
                                      appears in "Today's captures" strip
                                    - capture without note → still succeeds
                                    - capture with note > 280 → 400
                                    - tradie can list own captures; cannot
                                      list another tradie's
                                    - admin can list all captures for a job
                                    - LH can list captures for jobs they're
                                      assigned to (read-only)
                                    - admin reviews capture → status flips
                                    - admin rejects with reason → status flips
                                    - admin rejects WITHOUT reason → 400

You MUST NOT:

  - build any admin Phase D page                            (D4)
  - touch vercel.json                                       (D4)
  - cutover any route                                       (D4)
  - add a third new API endpoint (only the two specified above)
  - touch legacy api/snags-*, api/itps-*, api/plans-*
  - merge

Before writing code:
  - re-read api/task-toggle.js for the read-modify-write pattern
  - re-read [24] §5.5 status machine — implement server-side enforcement
  - confirm the new routes use Next.js App Router conventions per
    src/app/api/... (not pages/api/...)

Checks: standard set + the new API route tests pass.

PR body:
  - explicit note: "DemoModeBanner OFF for evidence; admin pages remain UC."
  - rollback: revert the PR; data already in data.json.evidence[] is harmless
    leftover until next blob write — no separate cleanup needed.
```

---

## D4 · admin Jobs surface + /admin/jobs cutover

```
You are Claude Code working as the Phase D · D4 build session for BuhlOS / Phil.

This is the FIRST Phase D PR that touches vercel.json.
This is the FIRST Phase D PR that performs a production cutover.
ON-CALL ATTENTION IS REQUIRED FOR THIS DEPLOY.

Read first (common preamble + plan §13 D4):
  docs/rebuild-audit/24-phase-d-jobs-evidence-plan.md  §4 §13 D4 §15.0 #4 §15.0 #7
  docs/rebuild-audit/16-migration-strategy.md  §C cutover sequencing
  docs/rebuild-audit/25-phase-d-build-prompts.md  §Common preamble
  vercel.json                       — current rewrites (read every line)

Pre-flight: D1 + D2 + D3 merged to main; 48h quiet period; preview verification
of /v2/jobs by Oskar.

Branch:     phase-d-d4-admin-jobs-cutover   (from latest origin/main)
PR title:   [Phase D] D4 · admin jobs surface + /admin/jobs cutover

============================================================
SCOPE — two sub-phases in one PR (verify-then-cutover)
============================================================

PART A — verify on /v2/jobs (no vercel.json changes)
  src/app/(admin)/v2-jobs/page.tsx (TEMPORARY route — deleted in Part B)
                                    Admin jobs list — same shape as final
                                    /jobs page. Mounted at /v2/jobs for
                                    preview verification only.
  src/app/(admin)/v2-jobs/[jobId]/page.tsx (TEMPORARY)
                                    Admin job detail — same shape as final
                                    /jobs/[jobId].
  Oskar verifies on Vercel preview. Sign-off recorded in PR.

PART B — cutover (small vercel.json edit, route rename)
  RENAME src/app/(admin)/v2-jobs → src/app/(admin)/jobs
  RENAME [jobId] subroute accordingly
  ADD    src/app/(admin)/jobs/[jobId]/evidence/page.tsx
         (server component shell — interactive review panel lives in
          src/components/admin/JobEvidencePanel.tsx per the binding
          client-component rule; the page imports + passes data in)
  ADD    src/components/admin/JobEvidencePanel.tsx
         (the actual "use client" panel — actions, modal, optimistic UI)
  ADD    src/components/admin/JobsListClient.tsx if /jobs list has
         interactive filters/search (server component fetches; client
         renders filters). If the list is purely server-rendered (no
         interactive filters), no client component needed.

  EDIT vercel.json — remove these rewrites:
    /jobs → /admin/jobs.html
    /jobs/:jobId → /project.html
    /jobs/:jobId/log-hours → /project.html       (kept; redirects elsewhere or
                                                  becomes 404 — confirm)
    /admin/jobs → /admin/jobs.html
    /admin/jobs/:jobId → /admin/job.html

  ADD these new quarantine rewrites to vercel.json:
    /legacy/admin-jobs → /admin/jobs.html
    /legacy/admin-jobs/:jobId → /admin/job.html
    /legacy/project/:jobId → /project.html

  BUMP public/sw.js CACHE_VERSION (per check:sw-cache-version requirements;
    this PR changes admin shell pages indirectly via Next.js owning them).

  ADD src/app/(admin)/jobs/[jobId]/evidence/page.tsx — server component:
    - awaits session + permissions check
    - server-side fetches EvidenceItems for the job
    - passes data into <JobEvidencePanel initialItems={items} />
    - NO interactive logic in this file (no "use client", no useState)

  ADD src/components/admin/JobEvidencePanel.tsx — "use client" panel:
    - per-item: photo thumb, note, captured-by, captured-at, target
      (area + stage + task or "unattached"), current status pill
    - actions: Mark reviewed, Reject (modal with required reason)
    - filters: by status, by capturedBy, by date range
    - bulk-select for mark-reviewed
    - empty state, loading skeleton, error retry
    - the actual interactive surface — MUST live here per [24] D-26
      (the page is ≥3 route segments deep; a sibling "use client" file
      will silently break on production SSR)

  UPDATE src/app/(admin)/jobs/page.tsx (final form):
    - jobs list with: name, status pill, address, PM, last-activity
    - filter: status, evidence-pending-review
    - search: name + ref substring
    - admin can click into /jobs/[jobId]

  UPDATE src/app/(admin)/jobs/[jobId]/page.tsx (final form):
    - header: name + status pill + ref
    - tabs or stacked sections: Overview, Evidence, Hours
    - Overview: site context block, area-groups → areas read-only,
      job-level + per-area task templates read-only
    - Evidence tab: count + link to /jobs/[jobId]/evidence
    - Hours: read-only link to /hours filtered for this job

  tests/phase-d-d4-admin-jobs.spec.ts:
    - unauthenticated /jobs and /jobs/[jobId] redirect to /v2/login
    - admin login → /jobs sees full list → opens detail
    - admin reviews evidence → status flips on Phil
    - admin rejects with reason → reason visible on Phil
    - bulk mark-reviewed
    - DemoModeBanner OFF on /jobs and /jobs/[jobId]
    - /legacy/admin-jobs still works (regression check)

You MUST NOT:

  - cutover /admin (the SPA Command Centre) — that's Phase E
  - cutover /admin/snags, /admin/plans, /admin/itp, /admin/job-builder,
    /admin/crew, /admin/variations, /admin/materials — defer
  - delete public/admin/jobs.html or public/admin/job.html
    (quarantined; deleted in a separate PR one billing cycle later)
  - touch Phase C branch
  - deploy directly — let main merge auto-deploy on Vercel
  - merge this PR yourself (Oskar must approve and time the Monday deploy)

Before writing code:
  - re-read vercel.json line-by-line
  - confirm /v2/jobs is not claimed
  - re-read public/admin/job.html briefly — note any data shapes that
    the new admin page must mirror (the data is already in src/domains/jobs;
    this is a UX-not-data check)
  - re-read [24] §11 D-09 (the legacy cutover risk and mitigation)

Checks before opening the PR:
  Standard + manual preview verification:
    - oskar opens /v2/jobs on Vercel preview → confirms list renders
      with real data
    - oskar opens /v2/jobs/<real-jobId> → confirms detail renders
    - oskar opens evidence panel → confirms recent D3 captures visible
    - oskar marks one reviewed → confirms status flips on a tradie's
      preview /phil/jobs/<jobId>
  Cutover Part B only commits AFTER Part A sign-off in PR thread.

PR body must include:
  - explicit deploy plan: Monday morning AEST, on-call attention for 1 hour
  - rollback plan:
      1. revert PR commit → main → Vercel auto-rolls back; OR
      2. vercel promote <previous-deploy>; restores vercel.json rewrites
  - one-billing-cycle quarantine note: public/admin/jobs.html and
    public/admin/job.html and public/project.html remain at /legacy/*
    until <DATE+1month>

Final report:
  - branch, base, head commits
  - files changed (with vercel.json diff highlighted)
  - SW cache version bumped to: <new version>
  - PR URL
  - confirmation cutover deployed Monday + 1-hour on-call window held
  - first 24-hour smoke: any 4xx/5xx spikes on /jobs or /admin/jobs?
```

---

## D5 · admin Activity surface + /admin/activity cutover

```
You are Claude Code working as the Phase D · D5 build session for BuhlOS / Phil.

This PR also touches vercel.json (small).

Read first (common preamble + plan §13 D5 + §15.1 #8 founder call):
  docs/rebuild-audit/24-phase-d-jobs-evidence-plan.md  §13 D5 §5.9 §15.1 #8

Pre-flight: D4 merged to main + 48h quiet + no reported regressions on /jobs.
            Oskar has answered §15.1 decision 8 (Activity scope: evidence-only,
            or include legacy per-job audit events too). If not answered,
            DEFAULT TO EVIDENCE-ONLY for D5 and add legacy aggregation in
            Phase E.

Branch:     phase-d-d5-admin-activity-cutover   (from latest origin/main)
PR title:   [Phase D] D5 · admin activity surface + /admin/activity cutover

============================================================
SCOPE
============================================================

  src/app/(admin)/activity/page.tsx
    - reads AuditLog from audit/{yyyy-mm}.json via a new typed client
    - feed view: latest events first; infinite scroll OR paginated
    - per event: actor, action, target entity + id (linkable),
      timestamp, expandable before/after diff
    - filters: actor, action type, target entity, jobId
    - DEFAULT SCOPE (if decision §15.1 #8 = evidence-only):
      action ∈ { evidence.captured, evidence.reviewed, evidence.rejected,
                 task.toggled }
    - EXTENDED SCOPE (if decision §15.1 #8 = include legacy events):
      ALSO fan out per-job legacy audit log reads
      (jobs/{id}/job-audit/... via api/_lib/job-audit.js shape) and
      merge by timestamp.

  src/domains/audit-log/client.ts   ADD listEvents() helper.

  EDIT vercel.json — remove rewrite:
    /admin/activity → /admin/activity.html
  ADD quarantine:
    /legacy/admin-activity → /admin/activity.html

  tests/phase-d-d5-activity.spec.ts:
    - unauthenticated /activity redirects
    - admin login → /activity sees Phase D events from D3 captures
    - filter by action type works
    - /legacy/admin-activity still serves the legacy page

You MUST NOT:

  - cutover any other /admin/* route
  - delete public/admin/activity.html
  - touch Phase C branch
  - add new API endpoints (read-only feed reuses existing audit-log client)
  - merge this PR yourself

Checks: standard + Monday deploy + 1-hour on-call.

Rollback: revert PR commit → Vercel auto-rolls back; vercel.json rewrites
restored.
```

---

## D6 · Phase D exit polish + docs

```
You are Claude Code working as the Phase D · D6 build session for BuhlOS / Phil.

This is the LAST Phase D slice. No new features — exit polish + docs.

Read first (common preamble + plan §12 + §13 D6):
  docs/rebuild-audit/24-phase-d-jobs-evidence-plan.md  §12 acceptance + §13 D6

Pre-flight: D1 + D2 + D3 + D4 + D5 all merged + 7-day quiet on D4 + D5
            cutovers.

Branch:     phase-d-d6-exit-polish   (from latest origin/main)
PR title:   [Phase D] D6 · exit polish + docs + Command Centre evidence count

============================================================
SCOPE
============================================================

  src/app/(admin)/command-centre/page.tsx UPDATE:
    - add "X items of evidence pending review" line item with real count
      from evidence.listForJob aggregations
    - link to /jobs?filter=evidence-pending
    - count must be real (no fake metric); if 0, show "All evidence reviewed"

  Sweep src/ for `TODO(Phase D)` markers — resolve or convert to GitHub
  issues. None should remain after this PR.

  Update [00-executive-summary.md](docs/rebuild-audit/00-executive-summary.md):
    - add "Phase D" section describing what shipped
    - reference [24] for detail

  Update [11-operational-workflow-map.md](docs/rebuild-audit/11-operational-workflow-map.md):
    - #10 (task completion) marked "shipped — Phase D"
    - #11 (evidence/photo) marked "shipped — Phase D"
    - #12 (snag) reassigned from "Phase D" to "Phase D.5"
    - #19, #20 (stages, areas) — note "read-only shipped Phase D; mutations
      deferred to Phase F+ Job Builder rebuild"

  Update [21-rebuild-decision-record.md](docs/rebuild-audit/21-rebuild-decision-record.md):
    - add ADR-021 · Phase D scope split: jobs + evidence in D;
      snags in D.5 (formalises the Oskar 2026-05-24 decision)

  CREATE [docs/rebuild-audit/27-phase-d-command-results.md](docs/rebuild-audit/27-phase-d-command-results.md)
  (NEW DOC — capture every command run across D1–D6, outcome, fixes applied,
   per [20-agent-rules.md] #24).

  Walk through [24] §12 Phase D acceptance criteria one by one in the PR body;
  every box ticked.

  Walk through [docs/rebuild-audit/26-phase-d-testing-checklist.md] field-test
  script with one nominated tradie + one admin (founder decision §15.1 #9 —
  if "pilot" chosen, this is the pilot).

You MUST NOT:

  - add new features
  - touch vercel.json
  - cutover anything new
  - start Phase D.5 or Phase E
  - touch Phase C branch
  - merge this PR yourself

Checks: standard + manual acceptance walkthrough in PR body.

PR body must include:
  - Phase D §12 acceptance criteria with every checkbox ticked
  - Phase D.5 kickoff plan: "Next planning session opens
    docs/rebuild-audit/28-phase-d5-snags-plan.md (or next available number)
    after this PR merges + 7-day quiet."

Final report:
  - confirmation Phase D is COMPLETE per [24] §12
  - command-results doc created
  - audit doc updates merged in same PR
  - Phase D.5 kickoff scheduled (separate planning session)
```

---

## Status

| Slice | Doc § ref | Sequence prerequisites |
| --- | --- | --- |
| D1 | [24] §13 D1 | Phase C merged + 7d quiet + this plan approved + §15.1 decisions answered |
| D2 | [24] §13 D2 | D1 merged + 24h quiet |
| D3 | [24] §13 D3 | D2 merged + 24h quiet |
| D4 | [24] §13 D4 | D3 merged + 48h quiet + /v2/jobs preview verified |
| D5 | [24] §13 D5 | D4 merged + 48h quiet + no /jobs regression reports |
| D6 | [24] §13 D6 | D1–D5 all merged + 7d quiet on D4+D5 cutovers |

After D6 merges, **Phase D is complete.** Plan Phase D.5 (snags) as the next planning session.

---

## Cross-references

- [24-phase-d-jobs-evidence-plan.md](24-phase-d-jobs-evidence-plan.md) — the binding plan; this doc is its build-prompt companion.
- [26-phase-d-testing-checklist.md](26-phase-d-testing-checklist.md) — the per-slice and exit testing checklist.
- [19-phase-b-hours-implementation-brief.md](19-phase-b-hours-implementation-brief.md) — format precedent.
- [20-agent-rules.md](20-agent-rules.md) — mandatory rules every prompt above must respect.
- [16-migration-strategy.md](16-migration-strategy.md) §C.3 — cutover sequencing for PR-D4 and PR-D5.
