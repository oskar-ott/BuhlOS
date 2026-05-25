# 34 · Phase E1 — testing checklist

> **Status: Planning artefact (docs-only).** Per-slice QA gates for the E1 build sessions, modelled on [doc 28](28-d2-d3-d4-evidence-qa-checklist.md). Each E1 build session pastes the relevant section into its preflight reads. Reviewers gate on the same.
>
> §A covers **E1a** (ITP domain + API extension), §B covers **E1b** (Phil ITP recording UI), §C covers **E1c** (admin ITP queue + sign-off). §D is the regression matrix. §E is the production-smoke gate run after each PR merges.
>
> **Source of scope truth:** [32-phase-e-plan.md](32-phase-e-plan.md). If anything below contradicts that plan, the plan wins.

---

## §0 · Universal preflight

Every E1 PR satisfies these before opening:

- [ ] Branch cut from `origin/main` at the latest published commit. `git status` clean.
- [ ] `npm install` ran without errors.
- [ ] No `vercel.json` changes (E1 is rebuild-surface-only).
- [ ] No new `*.html` files under `public/admin/` or `public/phil/`.
- [ ] No new file under `src/app/phil/jobs/[jobId]/itps/` or `src/app/v2/jobs/[jobId]/itps/` contains `"use client"` — the RSC manifest rule from [doc 24 D-26] is binding.
- [ ] No `any`, no `@ts-ignore`, no `alert()` / `confirm()` / `prompt()` in product code.
- [ ] No new file imports `@vercel/blob` directly. All blob reads/writes go through `api/_lib/blob.js`.
- [ ] No file writes credentials to disk or echoes them to stdout.
- [ ] PR title starts with `[Phase E1]`.

---

## §A · E1a (ITP domain + API extension)

### A.1 — Unit tests (vitest)

Add to `src/domains/itp/itp.test.ts`:

- [ ] **Schemas**
  - [ ] `ITPTemplateSchema` accepts a minimal valid template (`name` + 1 point) and a fully-populated one.
  - [ ] Rejects template missing `name`.
  - [ ] Rejects template with a point missing `label` or `type`.
  - [ ] Rejects template with a point whose `type` is not in `photo|value|signoff|note`.
  - [ ] Rejects template with a `value` point's `min` > `max`.
  - [ ] Passthrough: an unknown future field on a template is preserved on parse.
  - [ ] `ITPInstanceSchema` accepts a fully-populated instance (results map, signed-off stamps).
  - [ ] Rejects instance missing `templateSnapshot`.
  - [ ] Rejects instance whose `status` is not in `pending|in-progress|witnessed|signed-off`.
  - [ ] Rejects instance whose `scope` is not in `job|level|area|switchboard`.
  - [ ] `AttachITPPayloadSchema` rejects missing `templateId`.
  - [ ] `SignOffITPPayloadSchema` accepts payload without `overrideJustification`.
  - [ ] `SignOffITPPayloadSchema` rejects `overrideJustification` longer than 500 chars.

- [ ] **State machine** (`service.canTransition`)
  - [ ] `null → pending` allowed (create via attach).
  - [ ] `pending → in-progress` allowed.
  - [ ] `in-progress → witnessed` allowed.
  - [ ] `witnessed → signed-off` allowed.
  - [ ] `signed-off → witnessed` allowed (reopen).
  - [ ] `pending → signed-off` rejected (must go through witnessed).
  - [ ] `in-progress → signed-off` rejected.
  - [ ] Archive is orthogonal — covered by a separate API method, not a transition.

- [ ] **Role gates** (`service.canRoleTransition`)
  - [ ] Admin tier (`admin`, `boss`, `owner`, `manager`, `office`, `pm`, `estimator`) — every allowed transition passes.
  - [ ] LH tier (`leadinghand`, `leading_hand`, `leading-hand`, `lh`) — can record points on assigned jobs; can reopen if witness role permits; cannot sign off otherwise.
  - [ ] Field tier (`tradie`, `apprentice`, `labourer`, `electrician`) — can record points only.
  - [ ] Client — read-only.

- [ ] **Independence rule** (`service.canSignOff`)
  - [ ] Viewer recorded 0/N points → `{ ok: true }`.
  - [ ] Viewer recorded N/N points (100%) → `{ ok: false, reason: 'needs-justification', ratio: 1.0 }`.
  - [ ] Viewer recorded N-1/N points (just over threshold) → `needs-justification`.
  - [ ] Viewer recorded exactly half (e.g. 3/6) → `{ ok: true }` (at threshold, no override required).
  - [ ] Wrong role → `{ ok: false, reason: 'wrong-role' }`.
  - [ ] Instance has zero required points → `{ ok: true }` (degenerate case; legacy permits).

- [ ] **Client wrappers**
  - [ ] `listItps('birdwood-iv3232')` POSTs nothing and GETs `/api/job-itps?jobId=birdwood-iv3232` with `cache: 'no-store'`, `credentials: 'same-origin'`.
  - [ ] `recordItpPoint` surfaces 200 / 400 / 403 / 409 status codes faithfully on `r.error.status`.
  - [ ] `signOffItp` includes `overrideJustification` in body when provided, omits when not.
  - [ ] `attachItp` rejects shapes that fail `AttachITPPayloadSchema` client-side (refuses to call the server).

### A.2 — Audit-log schema extension

- [ ] `AUDIT_ACTIONS` enum contains `itp.attached`, `itp.point.recorded`, `itp.signed_off`, `itp.reopened`, `itp.archived`.
- [ ] `AUDIT_TARGET_TYPES` enum contains `itp_template`, `itp_instance`.
- [ ] `src/domains/audit-log/audit-log.test.ts` enum-in-sync assertion updated.

### A.3 — `api/job-itps.js` extension

- [ ] Imports `{ append: appendAuditLog }` from `./_lib/audit-log`.
- [ ] Imports `{ isAdminRole, isFieldRole, isLeadingHandRole }` from `./_lib/auth` (PR #23 alignment).
- [ ] Replaces any local `ADMIN_ROLES` set with the imported helpers (same as PR #26 for `api/snags.js`).
- [ ] `readBlob` calls on the record/signoff/reopen/archive write paths replaced with `readBlobFresh` (PR #26 pattern).
- [ ] `canTransition`-equivalent reject on these paths triggers a 750ms retry with a `readBlobFresh` re-read.
- [ ] All five action verbs call `appendAuditLog(...)` wrapped in `.catch(() => {})`.
- [ ] Existing `appendAudit` (legacy structural log) calls preserved verbatim.
- [ ] Independence rule enforced server-side on signoff: returns 409 with `{ error: 'sign-off requires an override justification — too many points were recorded by the signing user' }` when ratio > 0.5 and no justification provided.
- [ ] `overrideJustification` validation: max 500 chars, returns 400 if exceeded.

### A.4 — `api/jobs.js` extension

- [ ] `withStats=1` enrichment now reads `jobs/<id>/itps.json` with the same `.catch(() => ({ instances: [] }))` fallback as other reads.
- [ ] `statsItpsActive` = count of non-archived instances with status in `pending|in-progress|witnessed`.
- [ ] `src/domains/jobs/schema.ts` `JobSchema` extended with `statsItpsActive: z.number().optional()`.

### A.5 — Local checks

- [ ] `npm run typecheck` — no errors.
- [ ] `npm run lint` — no errors or warnings.
- [ ] `npm run test` — every existing test plus the new E1a tests pass.
- [ ] `npm run build` — bundle sizes unchanged (no UI in E1a; API + domain only).
- [ ] `npm run check:admin-shell` — green.
- [ ] `npm run check:sw-cache-version` — reports no admin-shell file changes.
- [ ] `npm run check:production-shell` — green.
- [ ] `npm run smoke:admin-routes` — 24/24 (no new routes in E1a).

### A.6 — Preview smoke (after CI green)

- [ ] `node scripts/smoke-evidence-routes.js <preview-url>` — 24/24 still.
- [ ] Authenticated curl (or Chrome MCP) verifies:
  - [ ] `POST /api/snags?jobId=X` (regression) still returns 400 on non-object body. (PR #26 fix unaffected.)
  - [ ] `POST /api/job-itps?jobId=X&action=attach` with valid body → 200; new audit-log row visible at `GET /api/audit-log?targetType=itp_instance&targetId=Y`.
  - [ ] `POST /api/job-itps?jobId=X&action=record` on each point type — confirm appendAuditLog writes the right action verb.
  - [ ] Sign-off independence rule: have one admin record N/N points, attempt sign-off without justification → 409. With justification → 200, audit row metadata contains the justification.
  - [ ] `GET /api/jobs?withStats=1` returns `statsItpsActive` on each job (number, even if 0).

### A.7 — Merge gate

- [ ] CI green (lint + typecheck + tests + build).
- [ ] Vercel preview READY.
- [ ] Unauth smoke 24/24 on preview.
- [ ] Oskar review approved.
- [ ] No new HTTP routes mounted (verify in the PR diff).

---

## §B · E1b (Phil ITP recording UI)

### B.1 — Unit tests (vitest)

- [ ] `src/components/phil/itp-panel.test.tsx`
  - [ ] Renders empty state when `initialItps=[]`.
  - [ ] Renders one row per active instance with status pill + progress + scope label.
  - [ ] "N done" pill shows count of signed-off + archived.
  - [ ] Tapping a row calls the router with `/phil/jobs/X/itps/Y`.

- [ ] `src/components/phil/itp-recording.test.tsx`
  - [ ] Renders all points from `instance.templateSnapshot.points`.
  - [ ] Each point card renders the correct input type by `point.type`.
  - [ ] Save button is `idle` when no edits made, `dirty` after typing, `submitting` during fetch, `saved` after 200.
  - [ ] Sign-off-type point is disabled if viewer's role doesn't match `point.witnessRole`.
  - [ ] On 409 from save: shows "This ITP has been updated. Reload to see the latest." banner with a Reload button.

- [ ] `src/components/phil/itp-point-card.test.tsx`
  - [ ] Photo type: shows capture button; thumbnail renders after upload.
  - [ ] Value type: shows unit + pass-criterion hint; renders pass/fail pill after save.
  - [ ] Signoff type: renders toggle; disables on wrong role.
  - [ ] Note type: renders textarea + Save only.

### B.2 — Visual + structural sanity

- [ ] Phil panel mounts as a sibling Card below Snags in `PhilJobDetail.tsx`.
- [ ] Render order on `/phil/jobs/[jobId]` from top to bottom: header → site notes → stage chooser → areas → Capture evidence CTA → Today's captures → Snags → ITPs.
- [ ] All primary buttons size="lg" (48 px).
- [ ] Photo capture buttons 56 px (matches `CaptureSheet.tsx`).
- [ ] Per-instance page uses dedicated route `/phil/jobs/[jobId]/itps/[instanceId]` (NOT a sheet).
- [ ] Sticky header on per-instance page contains: back link → job, template name, status pill, progress badge.

### B.3 — Server initial-fetch

- [ ] `loadInitialItps(cookieValue, jobId)` added to `src/app/phil/jobs/[jobId]/page.tsx`.
- [ ] Mirrors `loadInitialSnags` precedent: no-store cache, forwards the session cookie, validates response with `ITPListResponseSchema`, returns `[]` on any failure (non-blocking).
- [ ] `initialItps` prop passed to `<PhilJobDetail />`.

### B.4 — RSC + manifest compliance

- [ ] No `*-client.tsx` file under `src/app/phil/jobs/[jobId]/itps/`.
- [ ] All client components live under `src/components/phil/`.
- [ ] `src/app/phil/jobs/[jobId]/itps/[instanceId]/page.tsx` is a server component (no `"use client"` at the top).

### B.5 — Preview smoke

- [ ] `scripts/smoke-evidence-routes.js` updated to include `HTML  /phil/jobs/birdwood-iv3232/itps/itp_smoke (gated → 307)`.
- [ ] 25/25 (or whatever the new total is) PASS on preview.
- [ ] Chrome MCP smoke as tradie Oskar:
  - [ ] Open `/phil/jobs/birdwood-iv3232` → ITPs section visible.
  - [ ] No ITPs attached → empty state.
  - [ ] Attach a TEST E1 ITP via legacy `/admin/itp.html` or API call.
  - [ ] Reload Phil → instance appears.
  - [ ] Tap row → per-instance page loads.
  - [ ] Record one of each point type → each Save returns 200, optimistic + canonical replacement works.
  - [ ] After all required points recorded, status auto-advances to `witnessed`.
  - [ ] Reload page → status persists.

### B.6 — Merge gate

- [ ] CI green + preview READY + unauth smoke pass.
- [ ] Visual confirmation: section renders in correct order; tap targets pass thumb-test (Chrome MCP touch simulation or device).
- [ ] Auth smoke against preview as Oskar — full record-loop succeeds.
- [ ] Oskar review approved.

---

## §C · E1c (admin ITP queue + sign-off)

### C.1 — Unit tests (vitest)

- [ ] `src/components/admin/itps-queue.test.tsx`
  - [ ] Renders Active filter by default with the right count.
  - [ ] Switching filter to Signed off / All shows the right rows.
  - [ ] Row primary action is `Sign off` for witnessed, `Reopen` for signed-off, "No actions" for pending/in-progress.
  - [ ] Click row → drawer opens with that instance.
  - [ ] Click `Reopen` on signed-off row → POSTs transition + on 200, status flips in-memory.

- [ ] `src/components/admin/itp-signoff-modal.test.tsx`
  - [ ] When `canSignOff` returns `{ ok: true }` → renders simple confirm body, no textarea.
  - [ ] When `canSignOff` returns `{ ok: false, reason: 'needs-justification', ratio: 0.83 }` → renders textarea, submit disabled until non-empty.
  - [ ] Submit with justification → POSTs `signOffItp` with `overrideJustification` in body.
  - [ ] Submit without justification when required → submit button stays disabled.
  - [ ] 409 from server → renders "ITP changed since you loaded — reload to see the latest." banner.

- [ ] `src/components/admin/itp-drawer.test.tsx`
  - [ ] Renders point grid for a 3-point fixture (one of each type).
  - [ ] Photo point shows thumb + click-to-open-fullscreen.
  - [ ] Value point shows pass/fail pill based on `valuePassFailLabel`.
  - [ ] History panel reads from `/api/audit-log` and renders entries newest-first.
  - [ ] On status change (`updatedAt` prop changes), History panel re-fetches with the 2.5s retry pattern.

- [ ] `src/components/admin/jobs-list.test.tsx`
  - [ ] Birdwood row with `statsItpsActive: 2` renders an ITPs chip with count 2 and yellow-highlighted state.
  - [ ] Birdwood row with `statsItpsActive: 0` renders the ITPs chip without highlight, count 0.
  - [ ] Clicking the chip navigates to `/v2/jobs/<id>/itps`.

### C.2 — Visual + structural sanity

- [ ] `/v2/jobs/[jobId]/itps` renders inside `AdminShell` with breadcrumb back to `/v2/jobs`.
- [ ] Filter tabs: Active | Signed off | All. Counts match filtered row counts.
- [ ] Sign off modal independence rule fires for the threshold case visually.
- [ ] LH viewer sees the read-only pill and no Sign off button surface.
- [ ] JobsList ITP chip slots between Snags chip and the chevron on the right side of the row.

### C.3 — RSC + manifest compliance

- [ ] No `*-client.tsx` file under `src/app/v2/jobs/[jobId]/itps/`.
- [ ] All client components live under `src/components/admin/`.
- [ ] `src/app/v2/jobs/[jobId]/itps/page.tsx` is a server component.

### C.4 — Preview smoke

- [ ] `scripts/smoke-evidence-routes.js` updated to include `HTML  /v2/jobs/birdwood-iv3232/itps (gated → 307)`.
- [ ] All smoke checks pass.
- [ ] Chrome MCP smoke as admin Tom:
  - [ ] `/v2/jobs` → Birdwood row shows ITPs chip with count.
  - [ ] Click ITPs chip → admin queue page loads with the test instances.
  - [ ] Click a row → drawer with point grid + History opens.
  - [ ] For a witnessed instance: click Sign off → modal opens. Submit. Status flips. Audit row appears in History within 2.5s.
  - [ ] For a signed-off instance: click Reopen → POST returns 200. Status flips.
  - [ ] Test independence rule:
    - [ ] Attach a TEST E1 ITP. Have Tom record all required points himself.
    - [ ] Try Sign off → modal requires override justification.
    - [ ] Submit empty justification → submit button disabled.
    - [ ] Submit with justification → 200; audit row metadata contains the justification.
  - [ ] Test LH read-only flow (if a test LH user exists).

### C.5 — Merge gate

- [ ] CI green + preview READY + unauth smoke pass.
- [ ] Independence-rule branch verified end-to-end.
- [ ] Oskar review approved.
- [ ] No new HTTP routes beyond `/v2/jobs/[jobId]/itps` (verify in the PR diff).

---

## §D · Regression matrix (every E1 PR)

Run `npm run smoke:evidence-routes` against the preview and confirm:

- [ ] `/v2/login` 200 HTML
- [ ] `/phil/jobs` 307 (gated)
- [ ] `/phil/jobs/birdwood-iv3232` 307 (gated)
- [ ] `/v2/jobs` 307 (gated)
- [ ] `/v2/jobs/birdwood-iv3232/evidence` 307 (gated)
- [ ] `/v2/jobs/birdwood-iv3232/snags` 307 (gated)
- [ ] `/v2/jobs/birdwood-iv3232/itps` 307 (gated) — **new in E1c**
- [ ] `/phil/jobs/birdwood-iv3232/itps/<id>` 307 (gated) — **new in E1b**
- [ ] `/command-centre` 307 (gated)
- [ ] `/hours/approvals` 307 (gated)
- [ ] `/login` 200 (legacy)
- [ ] `/phil` 200 (legacy)
- [ ] `/admin/operations` 200 (legacy)
- [ ] `/admin/itp` 200 (legacy template editor — must still serve through E1)
- [ ] `/admin/jobs` 200 (legacy admin jobs — must still serve through E1)
- [ ] All `/api/*` unauthenticated returns 401 JSON.

Per-flow regression checks (run by hand on preview as admin Tom):

- [ ] Hours: `/hours` loads, approvals queue renders, can approve a TEST hours row.
- [ ] Gear: `/gear` loads with the asset list.
- [ ] Phil Hours: `/phil/hours` loads.
- [ ] Phil Gear: `/phil/gear` loads.
- [ ] Evidence loop (D4): `/v2/jobs/birdwood-iv3232/evidence` renders, drawer opens, review action works.
- [ ] Snags loop (D.5): `/v2/jobs/birdwood-iv3232/snags` renders, rapid transitions succeed (PR #26 fix).
- [ ] Jobs index (D6): `/v2/jobs` renders both jobs with their chips.

---

## §E · Production smoke (run after each E1 merge to main)

Wait for Vercel deploy to complete (check via Vercel deployment URL or production deploy notification). Then:

### E.1 — Deploy confirmation

- [ ] Vercel deployment for the merge commit is READY.
- [ ] Deployment target is `production`.
- [ ] `buhlos.com` alias is on the new deployment.
- [ ] No manual `vercel deploy` was used.

### E.2 — Unauth smoke

- [ ] `node scripts/smoke-evidence-routes.js https://buhlos.com` — all checks PASS.
- [ ] New routes (`/v2/jobs/birdwood-iv3232/itps`, `/phil/jobs/birdwood-iv3232/itps/<id>`) return 307 gated.

### E.3 — Authenticated full lifecycle (admin Tom)

- [ ] Log in via `/v2/login`.
- [ ] Navigate `/v2/jobs` → Birdwood shows ITPs chip.
- [ ] Click ITPs chip → admin queue loads.
- [ ] Attach a `TEST E1 PROD` ITP via legacy `/admin/itp.html` (or via API curl with the test session cookie).
- [ ] Reload `/v2/jobs/birdwood-iv3232/itps` → instance visible.
- [ ] Open drawer → History shows `itp.attached` entry.
- [ ] Log in as tradie Oskar on a different browser tab / Chrome MCP session.
- [ ] Navigate to `/phil/jobs/birdwood-iv3232` → ITPs section shows the new instance.
- [ ] Open the instance, record points, save each.
- [ ] Confirm History panel on admin side shows `itp.point.recorded` entries.
- [ ] As admin: status now `witnessed` → click Sign off → modal opens (no justification required since tradie recorded points, not admin).
- [ ] Submit sign-off → status flips to `signed-off`. Audit row appears.
- [ ] Test independence-rule: attach a separate ITP. Have Tom (admin) record most points. Try Sign off → modal requires override justification. Submit with justification → succeeds.

### E.4 — Test data cleanup

- [ ] After verification, leave the test instances in `signed-off` state (terminal; they don't count in active queue or chip).
- [ ] Note any TEST E1 instances created in the final report; admin can archive them via API if desired.

### E.5 — Regression on production

- [ ] Run `node scripts/smoke-evidence-routes.js https://buhlos.com` — full pass.
- [ ] Verify D.5 BUG 2 fix still works (PR #26): admin clicks rapid snag transitions → no stale-state errors.
- [ ] Verify Hours / Gear / Phil / legacy all still render.

### E.6 — Final report after E1c production smoke

The session that runs the post-merge production smoke produces a report with:

- [ ] Deployment ID
- [ ] Merge commit
- [ ] Pass/fail on each E.1-E.5 step
- [ ] Test data created + status (signed-off, archived, etc.)
- [ ] Any production findings to add as E1-fix candidates
- [ ] Confirmation that no Phase F work started
- [ ] Confirmation that legacy `/admin/itp.html` still serves correctly (E1 doesn't break legacy)

---

## §F · Hard exit gates for E1 (all must be true before E2 plans open)

- [ ] E1a, E1b, E1c all merged to main.
- [ ] Production deployment of the latest E1 merge commit is READY on `buhlos.com`.
- [ ] §E production smoke (all sub-sections) is PASS.
- [ ] No D.5 / D6 / earlier regressions surfaced.
- [ ] Vercel Blob propagation lag mitigation (PR #26 retry pattern) works for ITP transitions — verified via rapid `record → record → signoff` sequence.
- [ ] Independence-rule UX has been field-validated by Oskar.
- [ ] `phase-e1-itp-runbook.md` published in `docs/rebuild-audit/`.
- [ ] Rebuild index updated with E1 shipped rows.

---

## §G · Known not-in-scope (call out in PR descriptions)

These items are deliberately NOT delivered by E1. PRs should explicitly say so in their "Out of scope" section:

- E2: ITP template editor rebuild (legacy `/admin/itp.html` template UI stays live).
- E2: Cross-job ITP triage queue.
- E3: RFI bootstrap.
- E4: Materials rebuild.
- Phase F: Reporting / handover rollups.
- Phase F: AI plan interpretation.
- Phase F: Xero / payroll integration.
- Phase F: Offline-first sync engine.
- `/admin → /command-centre` cutover.
- `vercel.json` cleanup.

---
