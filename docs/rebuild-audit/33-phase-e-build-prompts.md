# 33 · Phase E1 — Claude Code build prompts

> **Status: Planning artefact (docs-only).** Paste-ready build prompts for the three E1 sub-slices: E1a (domain + API extension), E1b (Phil UI), E1c (admin UI). Each prompt is self-contained: scope, hard rules, preflight reads, checks, PR title, expected report.
>
> **Source of scope truth:** [32-phase-e-plan.md](32-phase-e-plan.md) §14 (Build sequence). If anything below contradicts §14, §14 wins. [34-phase-e-testing-checklist.md](34-phase-e-testing-checklist.md) is the binding test gate.
>
> **Pre-flight (binding for every slice):**
> - Phase D + D.5 are shipped to production and stable. PR #26 (D.5 hardening) is merged at `17f6da6`.
> - [32-phase-e-plan.md](32-phase-e-plan.md) is the approved plan; §15.1 decisions 1-6 are RESOLVED or explicitly deferred.
> - Build session opens in a fresh worktree, not in another session's worktree.
> - `git status` is clean on the build branch.
>
> If any of the above is uncertain, **STOP and ask before writing code** ([20-agent-rules.md] #5, #29).
>
> E2 (template editor rebuild + cross-job ITP triage), E3 (RFI bootstrap), and E4 (materials) get their own planning docs and build-prompt docs when their plans are written. **No prompts for E2/E3/E4 in this document.**

---

## Common preamble (every E1 slice — read once per session)

Every build session begins by reading:

```
docs/rebuild-audit/32-phase-e-plan.md                    ← Phase E plan (binding)
docs/rebuild-audit/33-phase-e-build-prompts.md           ← this file's §Common preamble
docs/rebuild-audit/34-phase-e-testing-checklist.md       ← test gates (binding)
docs/rebuild-audit/27-interface-usability-pass.md        ← UX rules (still binding from Phase D)
docs/rebuild-audit/20-agent-rules.md                     ← coding-agent rules
docs/rebuild-audit/10-product-definition.md              ← what BuhlOS / Phil are
docs/rebuild-audit/12-domain-model-deep-dive.md  §ITP §AuditLog
docs/rebuild-audit/13-ui-information-architecture.md  §Phil §Admin/Jobs
docs/rebuild-audit/14-technical-architecture-deep-dive.md
docs/rebuild-audit/21-rebuild-decision-record.md
docs/rebuild-audit/phase-d55-snags-runbook.md            ← operational pattern E1 mirrors
docs/rebuild-audit/phase-d6-admin-jobs-index-runbook.md  ← /v2/jobs chip pattern E1 extends
```

Then read the precedent code (every session):

```
api/job-itps.js                       — legacy ITP state machine — E1 extends, does not replace
api/itp-templates.js                  — legacy template editor — E1 does NOT touch
api/photos.js                         — upload-itp-photo path (already shipped, reused verbatim)
api/snags.js                          — V2 audit-log call pattern + readBlobFresh pattern (PR #26)
api/_lib/auth.js                      — role tier helpers (PR #23)
api/_lib/blob.js                      — write-through cache (PR #26)
api/_lib/job-audit.js                 — legacy structural log (already wired for ITP)
api/_lib/audit-log.js                 — V2 monthly journal helper

src/domains/snags/schema.ts           — Zod-with-passthrough pattern for E1a
src/domains/snags/client.ts           — typed-client pattern for E1a
src/domains/snags/service.ts          — state-machine + role-gate pattern for E1a
src/domains/snags/format.ts           — pure display helpers pattern for E1a
src/domains/snags/snags.test.ts       — unit-test pattern for E1a
src/domains/audit-log/schema.ts       — audit verbs + target types (extend in E1a)

src/components/phil/JobSnagsPanel.tsx — Phil panel-on-job-detail pattern for E1b
src/components/phil/ReportSnagSheet.tsx — Phil sheet pattern for E1b
src/app/phil/jobs/[jobId]/page.tsx    — server-component initial-fetch pattern for E1b

src/components/admin/SnagsQueue.tsx   — admin queue pattern for E1c
src/components/admin/SnagDrawer.tsx   — drawer + history-retry pattern for E1c
src/components/admin/SnagRejectModal.tsx — modal pattern for E1c (used by sign-off modal)
src/components/admin/JobsList.tsx     — /v2/jobs chip pattern for E1c
src/app/v2/jobs/[jobId]/snags/page.tsx — admin server-component pattern for E1c
```

**Hard rules — every Phase E session (mirror of Phase D rules):**

- Do NOT touch any branch other than the one you create for your slice.
- Do NOT touch other sessions' worktrees.
- Do NOT deploy. Do NOT `vercel deploy` anything.
- Do NOT push to `main` directly.
- Do NOT bypass any pre-commit hook with `--no-verify`.
- Do NOT add `any` or `@ts-ignore`. Do NOT use `alert()` / `confirm()` / `prompt()` in product code.
- Do NOT use `window.location.href = ...` for in-app nav. Use `<Link>` / `useRouter()`.
- Do NOT add a `vercel.json` rewrite. E1 is rebuild-surface-only.
- Do NOT add new API endpoint paths. The two new HTML routes in [32 §4.1](32-phase-e-plan.md) are the only new HTTP additions. API changes are extensions to existing endpoints only (new audit-log calls + new `statsItpsActive` field).
- Do NOT silent-fallback to fixtures. If API fails, render error UI.
- Do NOT write "Switchboard" or "Site Office" as a UI section or sidebar label — but DO render "Switchboard" as the ITP scope label per [32 §15.1] #4 (it's the legacy semantic for `scope='switchboard'`).
- Do NOT touch the legacy `/admin/itp.html` page or `api/itp-templates.js` template-editor endpoint in E1.
- Do NOT mix E1a / E1b / E1c into a single PR.
- DO NOT put a client component (`"use client"`) next to a page that is ≥2 route segments deep. Same RSC manifest rule from [doc 24 D-26]. E1 client components live under `src/components/phil/` or `src/components/admin/`. Cross-check before you push: any `*-client.tsx` or `"use client"` file under `src/app/phil/jobs/[jobId]/itps/` or `src/app/v2/jobs/[jobId]/itps/` is **wrong** and will 500 in production.
- DO NOT overbuild. Each slice has a stated LOC bound (E1a ~200-400, E1b/E1c ~400-600). If you find yourself wanting to add cross-job triage, a template editor rebuild, RFI, materials, reporting, snag auto-creation on reject, per-item rework, conditional checkpoints, PDF/certificate export, client portal sign-off, offline-first sync, or any item in [32 §17](32-phase-e-plan.md) — **STOP and ask** ([20-agent-rules.md] #5, #29). All of those are explicitly deferred. The E1 ship is the smallest field-to-office loop that proves the surface; everything else is later.

**Every PR title** starts with `[Phase E1]`.

---

## E1a · ITP domain + API extension

```
You are Claude Code working as the Phase E · E1a build session for BuhlOS / Phil.

Read first (common preamble + plan §13 + relevant precedents):
  docs/rebuild-audit/33-phase-e-build-prompts.md  §Common preamble
  docs/rebuild-audit/32-phase-e-plan.md           §2.1, §5, §10, §13
  docs/rebuild-audit/34-phase-e-testing-checklist.md  §A (E1a)

  api/job-itps.js                  — verbatim — this is the endpoint you'll extend
  api/itp-templates.js             — verbatim — DO NOT TOUCH (read for shape only)
  api/snags.js                     — verbatim — pattern: V2 audit-log calls + readBlobFresh
  api/_lib/audit-log.js            — append() helper shape
  src/domains/snags/*              — pattern precedent (schema, client, service, format, tests)
  src/domains/audit-log/schema.ts  — enum extension target

Scope (E1a — small, ~200-400 LOC + tests):

  1. Add Zod domain at src/domains/itp/:
     - schema.ts: ITPTemplatePointSchema, ITPTemplateSchema, ITPInstanceSchema,
       ITPInstanceResultSchema, AttachITPPayloadSchema, RecordITPPointPayloadSchema,
       SignOffITPPayloadSchema, ReopenITPPayloadSchema, ArchiveITPPayloadSchema,
       ITPListResponseSchema, ITPTransitionResponseSchema.
       Mirror the on-disk shape from api/job-itps.js verbatim. Use .passthrough()
       for forward-compat (same as snags).
     - types.ts: re-export inferred z.infer types.
     - format.ts: pure display helpers — statusLabel, statusTone, pointTypeLabel,
       valuePassFailLabel(point, result), isActive(status), isDone(status),
       needsWorkerAttention(status), formatProgress(instance) returning
       { done, total, percent }.
     - service.ts: state-machine + role gates:
       - ALLOWED_TRANSITIONS set (per [32-phase-e-plan.md] §3 verbs)
       - canTransition(from, to)
       - canRoleTransition(from, to, viewer, instance) — admin tier always; LH
         can record + reopen-witnessed on assigned jobs; field tier can record
         only; signoff requires admin tier + the independence check below.
       - canSignOff(viewer, instance, points): independence-rule helper.
         Returns { ok: true } | { ok: false, reason: 'needs-justification', ratio }
         | { ok: false, reason: 'wrong-role' }.
         Threshold = 0.5 (configurable constant SIGNOFF_INDEPENDENCE_THRESHOLD).
     - client.ts: typed httpPost wrappers — listItps, attachItp, recordItpPoint,
       signOffItp (accepts optional overrideJustification), reopenItp, archiveItp.
       Mirror the snags client shape verbatim.
     - itp.test.ts: vitest unit tests covering schemas (accept happy path, reject
       bad shapes, passthrough unknown fields), state machine (every allowed
       transition + a few rejected ones), role gates (admin / LH / field / client
       cases), independence rule (above 50%, exactly 50%, below 50%, 0%), and
       client surface (200 / 400 / 403 / 409 returned from server).

  2. Extend src/domains/audit-log/schema.ts:
     - AUDIT_ACTIONS: append 'itp.attached', 'itp.point.recorded', 'itp.signed_off',
       'itp.reopened', 'itp.archived'.
     - AUDIT_TARGET_TYPES: append 'itp_template', 'itp_instance'.
     - Update audit-log.test.ts enum-in-sync assertions.

  3. Extend api/job-itps.js with V2 audit-log writes:
     - Import { append: appendAuditLog } from './_lib/audit-log'.
     - For attach: call appendAuditLog with action='itp.attached',
       targetType='itp_instance', targetId=newInstanceId, metadata={ templateId,
       scope, scopeId, templateName }.
     - For record: appendAuditLog with action='itp.point.recorded',
       targetType='itp_instance', targetId=instanceId, metadata={ pointId,
       pointLabel, valueProvided, photoProvided, statusAfter }.
     - For signoff: appendAuditLog with action='itp.signed_off',
       targetType='itp_instance', targetId=instanceId, metadata={
       overrideJustification, signedOffByName }.
     - For reopen: appendAuditLog with action='itp.reopened',
       targetType='itp_instance', targetId=instanceId, metadata={ previousStatus }.
     - For archive: appendAuditLog with action='itp.archived',
       targetType='itp_instance', targetId=instanceId, metadata={ statusAtArchive }.
     - All calls wrapped in .catch(() => {}) — never block the ITP write.
     - Keep existing appendAudit (legacy structural log) calls intact.

  4. Apply PR #23 role-tier alignment to api/job-itps.js (verbatim from PR #26 fix
     to api/snags.js): replace any local ADMIN_ROLES set with imports from
     api/_lib/auth.js (isAdminRole / isLeadingHandRole / isFieldRole helpers).
     Do not broaden permissions beyond the intended role model.

  5. Apply PR #26 stale-read fix to api/job-itps.js record/signoff/reopen/archive
     paths: replace readBlob with readBlobFresh for the transition reads; add the
     same retry-once-with-750ms pattern from api/snags.js#transitionSnag if
     canTransition rejects.

  6. Add server-side independence rule check on the signoff path:
     - Compute the ratio of points where result.byUserId === me.id.
     - If > 0.5 AND req.body.overrideJustification is empty/missing, return 409
       { error: 'sign-off requires an override justification — too many points
       were recorded by the signing user' }.
     - If <= 0.5, do not require justification.
     - Mirror canSignOff() in src/domains/itp/service.ts.
     - REJECTION_JUSTIFICATION_MAX = 500 chars (matches snag rejection reason).

  7. Extend api/jobs.js withStats=1 enrichment:
     - Read jobs/<id>/itps.json (.catch fallback to { instances: [] }).
     - statsItpsActive = instances filter status in
       (pending|in-progress|witnessed) && !archived.
     - Add to the enriched job object.
     - Update src/domains/jobs/schema.ts JobSchema to include
       statsItpsActive: z.number().optional().

  8. NO new HTTP routes. NO new files under api/. NO changes to api/itp-templates.js
     or api/photos.js.

Local checks (must pass before push):
  npm run typecheck
  npm run lint
  npm run test                      ← expect 351 + new ITP domain tests
  npm run build
  npm run check:admin-shell
  npm run check:sw-cache-version    ← should report no admin-shell changes
  npm run check:production-shell
  npm run smoke:admin-routes        ← unchanged

Branch:  phase-e1a-itp-domain
Commit:  fix: E1a · ITP domain + V2 audit-log + role-tier alignment + stats counter
PR title: [Phase E1] E1a · ITP domain and API extension

Open PR and wait for CI + Vercel preview green. Run the unauth preview smoke
(node scripts/smoke-evidence-routes.js <preview>) — expect 24/24 still (no new
routes in this slice; surface unchanged from main).

Report:
  - bugs / nothing surfaced
  - files changed (count)
  - tests run + pass count
  - PR number
  - whether CI + preview green
  - merge decision (defer to Oskar)
  - test data created (none — this slice is server-side only)

Do NOT merge without Oskar review. Do NOT proceed to E1b in this session.
```

---

## E1b · Phil ITP recording UI

```
You are Claude Code working as the Phase E · E1b build session for BuhlOS / Phil.

PRECONDITION: E1a is merged to main. src/domains/itp/* is the binding shape.

Read first (common preamble + plan §6 + relevant precedents):
  docs/rebuild-audit/33-phase-e-build-prompts.md  §Common preamble
  docs/rebuild-audit/32-phase-e-plan.md           §2.1, §6, §13
  docs/rebuild-audit/34-phase-e-testing-checklist.md  §B (E1b)

  src/domains/itp/*                — your binding domain (just shipped in E1a)
  src/components/phil/JobSnagsPanel.tsx — panel-on-job-detail pattern
  src/components/phil/ReportSnagSheet.tsx — sheet capture pattern
  src/components/phil/CaptureSheet.tsx    — evidence photo sheet pattern
  src/app/phil/jobs/[jobId]/page.tsx     — server-component initial-fetch pattern
  src/components/phil/PhilJobDetail.tsx  — orchestrates the per-job sections

Scope (E1b — medium, ~400-600 LOC + tests):

  1. Add Phil JobITPsPanel to the existing job detail page:
     - src/components/phil/JobITPsPanel.tsx (client component).
     - Mounts in src/components/phil/PhilJobDetail.tsx alongside the existing
       JobSnagsPanel (sibling Card, below Snags).
     - Server fetch in src/app/phil/jobs/[jobId]/page.tsx: add
       loadInitialItps(cookieValue, jobId) following the loadInitialSnags
       precedent. Pass initialItps prop to <PhilJobDetail />.
     - Render: status pill, template name + scope label, progress (N / M points),
       chevron. Tap → next.router.push('/phil/jobs/X/itps/Y').
     - Group by needsWorkerAttention(status) — show active first, then signed-off
       collapsed (or as a "N done" pill, mirroring how the Snags panel shows it).

  2. Add /phil/jobs/[jobId]/itps/[instanceId] route:
     - src/app/phil/jobs/[jobId]/itps/[instanceId]/page.tsx (server component).
       Gate auth + phil-surface access. Fetch GET /api/job-itps?jobId=X and
       find the instance by id from params. 404 if not found. Pass to client.
     - src/components/phil/ITPRecording.tsx (client component) — the
       per-instance point-recording UI.
       - Sticky header: back link, template name, status pill, progress.
       - Scope context line ("Whole job" / "Level: G" / "Area: <name>" /
         "Switchboard: <name>").
       - Vertical list of points (one PointCard per point).
     - src/components/phil/ITPPointCard.tsx — per-point recorder. Switches on
       point.type:
         photo  → photo-capture button (lift CaptureSheet pattern; POST to
                  /api/photos?action=upload-itp-photo with { jobId, instanceId,
                  pointId, dataUrl }) + 1-line note + Save button.
         value  → number input + unit display + pass-criterion hint + 1-line
                  note + Save.
         signoff → boolean toggle + 1-line note + Save. Disabled if point's
                   witnessRole is incompatible with viewer.role.
         note   → textarea only + Save.
     - On Save: POST /api/job-itps?jobId=X&action=record with the appropriate
       body. Optimistic state update; canonical row from response replaces
       in-memory.
     - Per-point local state: idle | dirty | submitting | saved | error.

  3. Error mapping (same shape as JobSnagsPanel + SnagsQueue post-PR-26):
     - 403 → "You can't record this point."
     - 409 → "This ITP has been updated. Reload to see the latest."
     - 400 → r.error.message || "Invalid request."
     - other → r.error.message || "Couldn't save. Try again."

  4. Tap-target rule: every primary button size="lg" (48 px). Photo capture is
     56 px (matches CaptureSheet).

  5. Tests:
     - src/components/phil/itp-panel.test.tsx — render JobITPsPanel with various
       initialItps shapes; assert visible groups + counts + nav target.
     - src/components/phil/itp-recording.test.tsx — render ITPRecording with a
       3-point template (one of each non-signoff type); assert each card renders
       the right input + Save behaviour. Mock fetch and assert canonical-row
       replacement after Save.

  6. NO new API routes. NO changes to api/* in this slice.

Local checks (must pass before push):
  npm run typecheck
  npm run lint
  npm run test
  npm run build                      ← /phil/jobs/[jobId] bundle size delta < 5 kB
  npm run check:admin-shell
  npm run check:sw-cache-version
  npm run check:production-shell
  npm run smoke:admin-routes
  npm run smoke:evidence-routes <preview>  ← expect 24/24 + one new HTML check:
       /phil/jobs/birdwood-iv3232/itps/sn_smoke (gated → 307). Update the script
       in this slice.

Branch:  phase-e1b-phil-itp-ui
Commit:  feat: E1b · Phil ITP recording surface
PR title: [Phase E1] E1b · Phil ITP recording UI

Preview verification (mandatory before merge):
  - Open preview in Chrome MCP as tradie Oskar.
  - Navigate to /phil/jobs/birdwood-iv3232.
  - Confirm ITPs section renders below Snags. Empty state if no attached ITPs.
  - Attach a TEST E1 ITP from the legacy /admin/itp.html (or via API curl).
  - Reload preview as Oskar — confirm the ITP appears in the new section.
  - Tap into it — confirm the per-instance page renders all points.
  - Record one of each point type — confirm Save succeeds.
  - Verify status auto-advances pending → in-progress on first save.
  - Verify status auto-advances to witnessed when all required points are saved.

Report:
  - bugs surfaced (with severity)
  - files changed
  - tests run + pass count
  - PR number
  - preview test results (auth flow + per-point save flow)
  - merge decision (defer to Oskar)
  - test data created (TEST E1 ITP instances; cleanup plan)

Do NOT merge without Oskar review. Do NOT proceed to E1c in this session.
```

---

## E1c · Admin ITP queue + sign-off

```
You are Claude Code working as the Phase E · E1c build session for BuhlOS / Phil.

PRECONDITION: E1a is merged. E1b is merged or in flight (E1c can run in parallel
once E1a lands; no cross-PR dependency between E1b and E1c since they touch
different file trees).

Read first (common preamble + plan §7 + relevant precedents):
  docs/rebuild-audit/33-phase-e-build-prompts.md  §Common preamble
  docs/rebuild-audit/32-phase-e-plan.md           §2.1, §7, §9, §13
  docs/rebuild-audit/34-phase-e-testing-checklist.md  §C (E1c)

  src/domains/itp/*                       — binding domain (from E1a)
  src/components/admin/SnagsQueue.tsx     — admin queue pattern
  src/components/admin/SnagDrawer.tsx     — drawer + history-retry pattern
  src/components/admin/SnagRejectModal.tsx — modal pattern (E1c sign-off modal mirrors)
  src/components/admin/JobsList.tsx       — /v2/jobs chip pattern (extend in E1c)
  src/app/v2/jobs/[jobId]/snags/page.tsx  — admin server-component pattern
  src/app/v2/jobs/page.tsx                — D6 jobs index page

Scope (E1c — medium, ~400-600 LOC + tests):

  1. Add /v2/jobs/[jobId]/itps route:
     - src/app/v2/jobs/[jobId]/itps/page.tsx (server component). Auth gate (LH
       or admin tier per src/lib/auth/permissions canAccessSurface). Fetch
       /api/job-itps?jobId=X and /api/jobs?id=X in parallel. Render <ITPsQueue/>.
       Force-dynamic.

  2. Add the ITPsQueue + drawer + modal trio:
     - src/components/admin/ITPsQueue.tsx (client component).
       - Filter tabs: Active | Signed off | All (counts).
       - Sort by updatedAt desc.
       - Row primary action by status:
           pending     → "No actions" pill (read-only)
           in-progress → "No actions" pill
           witnessed   → "Sign off" (opens modal)
           signed-off  → "Reopen" (direct POST)
       - Row error/loading states from SnagsQueue pattern.
       - Drawer open/close state.
     - src/components/admin/ITPDrawer.tsx
       - Point grid: each point label + result rendering (image thumb for photo,
         value + pass/fail for value, recorded-by + at for signoff/note).
       - History panel: reads /api/audit-log?targetType=itp_instance&targetId=Y
         with the same 2.5s retry pattern as SnagDrawer / EvidenceDrawer.
       - Footer actions: Sign off / Reopen / Archive (admin only).
     - src/components/admin/ITPSignOffModal.tsx
       - Reads canSignOff(viewer, instance, points) from src/domains/itp/service.
       - If { ok: false, reason: 'needs-justification', ratio } → render a
         textarea labelled "Override justification (required)" with a 500-char
         counter and an explanation: "You recorded N/M points on this ITP. Sign
         off requires a justification."
       - If { ok: true } → simple "Confirm sign off" body.
       - Submit calls signOffItp(jobId, { instanceId, overrideJustification? }).
       - Error mapping: 403 → "You can't sign off this ITP.", 409 → "ITP changed
         since you loaded — reload to see the latest.", 400 → server message.

  3. Extend src/components/admin/JobsList.tsx:
     - Add an ActionChip in the row for ITPs, sourced from job.statsItpsActive
       (already added to /api/jobs?withStats=1 in E1a).
     - Aria-label: "Open N ITPs needing attention for ${job.name}".
     - Click navigates to /v2/jobs/[jobId]/itps.
     - Snag chip + Evidence chip stay where they are. ITP chip slots between
       Snags and the chevron.

  4. Mount the ITP route as middleware-gated (extend src/middleware.ts only if
     the existing snags-route gating doesn't already cover /v2/jobs/* — it
     should; do not add a new middleware case).

  5. Tests:
     - src/components/admin/itps-queue.test.tsx — render with various items;
       assert filter tab counts + visible-row ordering + primary action choice
       per status. Mock fetch and assert transition POSTs.
     - src/components/admin/itp-signoff-modal.test.tsx — render in both
       ratio modes; assert textarea required-state + submit payload includes
       overrideJustification when above threshold.
     - src/components/admin/itp-drawer.test.tsx — render with 3-point fixture;
       assert each point's result rendering branch.

  6. NO changes to api/* in this slice.

Local checks (must pass before push):
  npm run typecheck
  npm run lint
  npm run test
  npm run build                       ← /v2/jobs/[jobId]/itps bundle reasonable
  npm run check:admin-shell
  npm run check:sw-cache-version
  npm run check:production-shell
  npm run smoke:admin-routes
  npm run smoke:evidence-routes <preview>  ← expect 24/24 + one new HTML check:
       /v2/jobs/birdwood-iv3232/itps (gated → 307). Update the script in this
       slice.

Branch:  phase-e1c-admin-itp-queue
Commit:  feat: E1c · admin ITP queue + sign-off + jobs-index chip
PR title: [Phase E1] E1c · admin ITP queue and sign-off

Preview verification (mandatory before merge):
  - Open preview in Chrome MCP as admin Tom.
  - Navigate to /v2/jobs — confirm Birdwood row shows an ITP chip with count.
  - Click the ITPs chip — confirm /v2/jobs/birdwood-iv3232/itps renders with
    the test ITP instances.
  - Click a row — drawer opens with point grid + History.
  - For a witnessed instance, click Sign off — modal opens. Submit.
  - Confirm status flips to signed-off + the History panel shows the new
    audit row (allowing for the 2.5s retry window).
  - Test the independence-rule branch:
    - Attach a TEST E1 ITP. Have Tom record most points himself.
    - Try to sign off — modal should require the override justification.
    - Sign off without justification — server returns 409.
    - Sign off with justification — succeeds. Confirm metadata in audit log.
  - For a signed-off instance, click Reopen — confirm status reverts.
  - Test as LH user (if a test LH user exists) — confirm read-only pill +
    no sign-off button surface.

Report:
  - bugs surfaced (with severity)
  - files changed
  - tests run + pass count
  - PR number
  - preview test results (admin loop + independence rule + LH read-only)
  - merge decision (defer to Oskar)
  - test data created + cleanup plan

Do NOT merge without Oskar review.

After merge of E1a + E1b + E1c, run the full production smoke checklist from
docs/rebuild-audit/34-phase-e-testing-checklist.md §E (production smoke).
```

---

## Post-E1 follow-ups (not in scope, captured for the runbook)

- **E1-runbook**: write `docs/rebuild-audit/phase-e1-itp-runbook.md` after E1c
  ships. Include: production deploy URLs, the auth smoke script command, known
  limitations (E1-L1, E1-L2, ...), and any operational findings discovered
  during preview / production testing. Same shape as
  `phase-d55-snags-runbook.md`.

- **E1-fix candidates** (if found during production smoke, raise as separate
  hardening PRs, not bundled with E1c):
  - Independence-rule UX tuning (the 50% threshold might need adjustment after
    field observation).
  - Per-point photo lazy-loading regression if `/phil/jobs/[jobId]/itps/[instanceId]`
    is slow on large templates.
  - Cross-instance read consistency for the Vercel Blob race (E1a inherits the
    PR #26 fix preemptively but field validation is the proof).

- **E2 planning doc**: open a `phase-e2-plan.md` after E1 ships and stabilises
  for ≥3 days. E2 covers the template-editor rebuild + cross-job ITP triage.

- **E3 planning doc**: open `phase-e3-rfi-plan.md` independently. E3 is
  greenfield-small.

- **E4 planning pack**: materials needs multiple planning docs (legacy is
  large and overlaps takeoff / PO / invoicing). Don't open E4 prompts until a
  scoping pass on `api/materials-list.js` is complete.

---
