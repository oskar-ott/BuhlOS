# 28 · Phase D Evidence — D2 / D3 / D4 QA checklist

> **Status:** docs only. Planning artefact. No app code is implied or built by this doc.
>
> **Read first:** [24-phase-d-jobs-evidence-plan.md](24-phase-d-jobs-evidence-plan.md) §5.5 + §7 + §8 + §9, [26-phase-d-testing-checklist.md](26-phase-d-testing-checklist.md) §A + §B.2 + §B.3, [27-interface-usability-pass.md](27-interface-usability-pass.md) §4 + §6 + §11 + §12, [29-phase-d3-phil-capture-spec.md](29-phase-d3-phil-capture-spec.md), [30-phase-d4-admin-evidence-review-spec.md](30-phase-d4-admin-evidence-review-spec.md).
>
> **Purpose:** a single QA gate that the Session 5 D2 build, the future D3 capture-UI build, and the future D4 admin-review build must each clear before merge. Supersedes the per-slice scattered fragments in doc 26 §B.2 / §B.3 for the evidence loop specifically — doc 26's other slices (D1, D4-jobs-cutover, D5, D6) remain authoritative.

---

## 0 · Phasing reconciliation (read this first)

Two phasing models exist in the repo and they don't line up. Both are valid; **this doc follows the current-execution model**, not the doc-25 model.

| Slice | Doc 25 build prompt | **Current execution (this doc)** |
| --- | --- | --- |
| D1 | Jobs domain + Phil jobs read-only (✅ shipped 2026-05-24 in PR #11) | same |
| **D2** | Evidence domain + Phil capture flow (**fixtures only**) + `api/photos.js?action=upload-evidence-photo` | **Evidence domain + persistence API foundation** (Session 5). No Phil capture UI in this slice. |
| **D3** | Persistence API + audit log + Phil real wiring | **Phil capture UI** (sheet, "Today's captures" strip), built on top of D2's real API. See [doc 29](29-phase-d3-phil-capture-spec.md). |
| **D4** | Admin Jobs surface + `/admin/jobs` cutover (Evidence panel inside) | **Admin Evidence review** (read + reviewed/rejected) as its own thin slice. See [doc 30](30-phase-d4-admin-evidence-review-spec.md). The wider `/admin/jobs` route cutover is deferred to a later slice (provisionally "D4.5" or rolled into D5). |
| D5 / D6 | activity cutover · exit polish | unchanged from doc 25 §13 |

**Why the deviation:** the doc-25 fixtures-first capture-flow approach was a Vercel-preview-safety lever. With D1 already in production and `/api/jobs` confirmed live with the canonical `roughInTasks` / `fitOffTasks` task IDs, building the API first ("evidence domain + persistence") removes the fixture-vs-real dual-write trap. The capture UI then targets the real endpoint from day one — no fixture flip-the-switch step.

**What this doc treats as canonical:**
- **D2** = Session 5's "evidence domain + API foundation" — schemas, server validation, persistence, audit log, no UI.
- **D3** = future "Phil capture UI" slice — sheet, today's captures, real D2 API calls.
- **D4** = future "Admin evidence review" slice — queue, drawer, mark reviewed / reject with reason.

The doc-25 D2/D3 build prompts are obsolete for the evidence loop; the doc-25 D4 prompt's *Evidence panel* requirements get split out and land in this doc's §C. Doc 25 itself should be retired or rewritten at Phase D exit (D6 polish PR's docs cleanup).

---

## 1 · How to use this doc

- Every D2/D3/D4 PR must paste the relevant subsection of this checklist into its own PR body and tick each box.
- The §D regression matrix and §E production smoke are mandatory on every Dx merge — including hardening PRs.
- Every visual marker added to UI in D2/D3/D4 must match [doc 27 §6.2](27-interface-usability-pass.md)'s dictionary. No new tones, no new labels without an ADR.
- "Doc only" PRs from Session 4 are exempt from §A and §B; they still must clear §D's docs-aren't-lying check.

---

## §A · D2 — evidence domain + persistence API

**Scope (Session 5):** `src/domains/evidence/{schema,types,format,service,client}.ts` + persistence endpoint(s) + audit log bootstrap + the `api/photos.js?action=upload-evidence-photo` action branch. **No Phil capture UI. No admin review UI.** That's D3 / D4.

### A.1 · Schema + types

- [ ] `EvidenceItemSchema` matches [doc 24 §5.5](24-phase-d-jobs-evidence-plan.md) verbatim: `id`, `jobId`, `areaId?`, `stage?` (`'roughIn' | 'fitOff' | null`), `taskId?`, `kind` (`'photo' | 'note'`), `photoId?`, `photoUrl?`, `thumbnailUrl?`, `note (≤280)`, `capturedById`, `capturedByName`, `capturedAt`, `clientCapturedAt?`, `exifLocation?`, `status`, `reviewedById?`, `reviewedAt?`, `rejectionReason?`, `auditLogIds`, `createdAt`, `updatedAt`.
- [ ] `.passthrough()` on the schema (parity with `JobSchema`, `GearAssetSchema`, `TimeEntrySchema`).
- [ ] `kind: 'photo'` requires `photoId` + `photoUrl` (zod refinement).
- [ ] `status` enum: `uploading | pending_sync | submitted | reviewed | rejected`. **`draft` and `uploading` are client-only** — the server-emitted shape never carries them; if it does, that's a bug.
- [ ] `status === 'rejected'` requires non-empty `rejectionReason` (zod refinement).
- [ ] `note` constrained to ≤ 280 chars (`z.string().max(280)`).
- [ ] `CreateEvidencePayloadSchema` — what the client sends — matches the doc-24 plan: `jobId`, `areaId?`, `stage?`, `taskId?`, `kind`, `photoId?`, `photoUrl?`, `note?`, `clientCapturedAt?`.
- [ ] Types are inferred from schemas (`z.infer<>`), not hand-rolled.
- [ ] No `stages: { roughIn: [strings] }` shape consumed anywhere. The legacy field exists on the live `/api/jobs` response but **is not the canonical task-ID source**. Task references must use `roughInTasks[].id` / `fitOffTasks[].id` only (per the D3 warning carried forward from Session 4 Part 1).

### A.2 · Service layer

- [ ] `service.canTransition(from, to)` mirrors [doc 24 §5.5](24-phase-d-jobs-evidence-plan.md) state machine: only `null → submitted`, `submitted → reviewed`, `submitted → rejected`, `reviewed → submitted` are valid. Anything else returns `false`.
- [ ] `service.resizeImageToDataUrl(file, maxDim=1920, quality=0.7)` exists with that exact default signature so D3 capture matches the contract.
- [ ] `service.humanFileSize(bytes)` exists.
- [ ] No "guess the status" inference: status only enters the system from server responses.

### A.3 · `api/photos.js?action=upload-evidence-photo` action branch

- [ ] ≤ 30 lines added to `api/photos.js`. No other actions modified.
- [ ] Mirrors `uploadSnagPhoto` shape (the existing precedent — lines ~44-74 of `api/photos.js`).
- [ ] Storage path: `jobs/{jobId}/evidence-photos/{photoId}.jpg`.
- [ ] Returns `{ id, url, capturedAt }` — same shape as snag photo upload.
- [ ] 6MB cap (matches snag / ITP).
- [ ] `canWrite(user, jobId)` gate is the authority. Worker not assigned to job → 403.
- [ ] Anonymous → 401.
- [ ] Missing `dataUrl` → 400.
- [ ] Image > 6MB → 413.
- [ ] Other actions in `api/photos.js` (`upload-snag-photo`, `upload-itp-photo`, default) byte-for-byte unchanged in the diff.

### A.4 · Persistence endpoint(s) — `/api/jobs/[jobId]/evidence`

The plan calls for a single Next.js route handler at `src/app/api/jobs/[jobId]/evidence/route.ts` that POSTs evidence and GETs the per-job list. Review endpoint(s) may live alongside (`/api/jobs/[jobId]/evidence/[evidenceId]/review`) or under a separate path; either is acceptable as long as the body shape and permission rules below hold.

**POST evidence:**
- [ ] Body matches `CreateEvidencePayloadSchema`. Anything else → 400 with a JSON error.
- [ ] `stage`, `areaId`, `taskId` cross-checked against the job's actual structure (loaded fresh from blob). Stage `'roughIn'` + an `areaId` not in `job.areaGroups[].areas[].id` → 400. `taskId` not in the resolved tasks for that area+stage (via [doc 24 §5.4](24-phase-d-jobs-evidence-plan.md) `effectiveTasks` logic) → 400.
- [ ] Worker not assigned to job → 403.
- [ ] Anonymous → 401.
- [ ] Client cannot set `status` to anything other than `submitted` on create (or omit it; server fills).
- [ ] Server fills `capturedById`, `capturedByName`, `capturedAt`, `id` (nanoid), `createdAt`, `updatedAt`, `auditLogIds`.
- [ ] `clientCapturedAt` if provided is stored verbatim (metadata only — never used for ordering).
- [ ] Returns the canonical persisted `EvidenceItem` (so the client doesn't immediately re-fetch and hit the Vercel Blob read-after-write lag — see [doc 27 §8.3 / BUG-C-004](27-interface-usability-pass.md)).
- [ ] `AuditLog` row written: `{ action: 'evidence.captured', actor, jobId, evidenceId, ... }`. See §A.5.

**GET list:**
- [ ] As admin → all evidence for the job.
- [ ] As LH assigned to the job → all evidence for the job (read-only on actions; D4 will gate writes).
- [ ] As tradie → only `capturedById === me.id` (server-filtered, **not** client-filtered).
- [ ] As client → 403.
- [ ] As tradie not assigned to the job → 403.
- [ ] Anonymous → 401.

**POST review (admin only — D4 wires the UI; D2 may stub the endpoint):**
- [ ] Body: `{ status: 'reviewed' }` or `{ status: 'rejected', rejectionReason: '<≤500 chars>' }`.
- [ ] `status: 'rejected'` without `rejectionReason` → 400.
- [ ] Caller not admin → 403.
- [ ] Transition `submitted → reviewed` or `submitted → rejected` (or `reviewed → submitted` admin un-review). Anything else → 400.
- [ ] `AuditLog` row written: `evidence.reviewed` or `evidence.rejected`.
- [ ] Returns the canonical updated `EvidenceItem`.

**Idempotency / race:**
- [ ] Double-tap on capture (two POSTs with same `clientCapturedAt` + same `capturedById` + same `jobId` within 5s) is **not** deduped at the server in D2 — the doc-24 D-22 risk accepts this; the client owns idempotency via a disable-on-submit guard. The QA box: document the choice in the PR body so future-D3 knows.
- [ ] Two concurrent POSTs on the same job from different workers both succeed and produce two distinct rows.

### A.5 · `AuditLog` bootstrap

- [ ] `src/domains/audit-log/schema.ts` + `client.ts` exist per [doc 24 §5.9](24-phase-d-jobs-evidence-plan.md).
- [ ] Append-only. No update / delete method exposed.
- [ ] Storage: `audit/{yyyy-mm}.json` blob. New month → new file.
- [ ] Each evidence write produces one audit row.
- [ ] Dual-write: legacy `api/_lib/job-audit.js` per-job audit continues to work (the legacy admin's audit tab depends on it). Both paths write on every evidence event.

### A.6 · Storage / Blob discipline

- [ ] `EvidenceItem` rows appended to `jobs/{jobId}/data.json` under `evidence[]` (decision §15.0 #2 in doc 24). Schema validation on write.
- [ ] Read-after-write retry: server returns the canonical written row (don't trust an immediate `readBlob`). If Vercel Blob's eventual-consistency window bites, the server retries up to N times before responding (or rolls back).
- [ ] No partial writes: photo upload + evidence create are two POSTs; if evidence create fails after photo upload succeeded, the orphan photo is acceptable (handover-to-D3-cleanup story in the PR body, but **the photo URL is never garbage-collected automatically**). Document this in the PR.
- [ ] No mock fallback: if `readBlob` returns no jobs.json, the response is 500 with a JSON error — not a synthesised empty array. (Per [doc 21 ADR-015](21-rebuild-decision-record.md): no silent fallback.)

### A.7 · Tests

- [ ] `src/domains/evidence/evidence.test.ts` — schema parses every fixture; rejects every invalid shape listed above; `service.canTransition` table-tests every (from, to) pair.
- [ ] `tests/api/photos-upload-evidence.test.ts` — POST 200 / 400 / 401 / 403 / 413.
- [ ] `src/app/api/jobs/[jobId]/evidence/route.test.ts` — POST 200 / 400 / 401 / 403; GET 200 (admin/LH/tradie/client matrix); review POST 200 / 400 / 403.
- [ ] `src/domains/audit-log/audit-log.test.ts` — append-only enforcement.
- [ ] Total D2 test count is reported in the PR body. Existing 183 tests still pass.

### A.8 · Hygiene gates (cross-check with [doc 26 §A](26-phase-d-testing-checklist.md))

- [ ] `npm run typecheck` ✓
- [ ] `npm run lint` ✓
- [ ] `npm run test` ✓ (full suite)
- [ ] `npm run build` ✓
- [ ] `npm run check:admin-shell` ✓
- [ ] `npm run check:sw-cache-version` ✓
- [ ] `npm run check:production-shell` ✓
- [ ] `npm run smoke:admin-routes` ✓
- [ ] [Doc 26 §A.1](26-phase-d-testing-checklist.md) RSC client-manifest grep returns no new `"use client"` files under `src/app/<deep route>/` — D2 adds **no** client components (no UI), so the grep should still be clean.
- [ ] `vercel.json` unchanged.
- [ ] No `public/*.html` changed.
- [ ] No `src/app/(admin)/*` changed.
- [ ] No `src/components/admin/*` changed (D4's lane).
- [ ] No `src/components/phil/*` changed beyond what's needed for type imports (capture UI is D3).

---

## §B · D3 — Phil capture UI

**Scope (future Session 6):** the Phil-side capture flow. Reads/writes through D2's real API. See [doc 29](29-phase-d3-phil-capture-spec.md) for the full build spec.

### B.1 · Component placement (binding)

- [ ] `CaptureSheet.tsx` lives in `src/components/phil/` — **NOT** under `src/app/phil/jobs/[jobId]/`. This is the [doc 24 D-26 / PR #6 RSC manifest binding rule](24-phase-d-jobs-evidence-plan.md), re-stated in [doc 27 §10](27-interface-usability-pass.md). Violation = blocker.
- [ ] Any new helper client components also live in `src/components/phil/`.
- [ ] `src/app/phil/jobs/[jobId]/page.tsx` may import the client component but **must not define a `"use client"` file co-located there**. Server-only changes (lifting the UC panel, wiring the prop to the sheet) are fine.

### B.2 · Functional

- [ ] Floating CTA "Capture evidence" on Phil job detail opens the sheet. (Replaces the current `UnderConstructionPanel`.)
- [ ] Sheet is a **full-screen modal**, not a half-sheet, not a popup.
- [ ] Sheet receives `jobId` as a prop from the server page — never reads `useParams()` for it.
- [ ] Default: camera permission prompt. Fallback: gallery `<input type=file>` button labelled clearly.
- [ ] Image preview after pick. Worker can retake (clears + reopens picker).
- [ ] Stage chooser: `Rough-in` / `Fit-off`. If the worker has just selected a stage on the job detail page, prefill (carry through via prop or local context).
- [ ] Area picker: only the visible (non-archived) areas of the job. Pre-filled if worker has selected one. Stage-and-area being optional is fine — server accepts unattached evidence (per [doc 24 §15.0 #5](24-phase-d-jobs-evidence-plan.md) decision).
- [ ] Task picker: shows only the tasks `effectiveTasks(job, selectedArea, selectedStage)` resolves to. **Never** populated from `job.stages.roughIn[]` (legacy strings — see the D3 warning). Disabled when area + stage aren't both chosen.
- [ ] Note input: ≤ 280 chars (matches `EvidenceItemSchema`). Character counter visible. Submission blocked client-side at 281.
- [ ] Submit button is full-width, bottom-edge, sticky. Disabled while POST in-flight.
- [ ] **Sheet closes on first tap of Submit** (per [doc 27 §8.3 BUG-C-003 lesson](27-interface-usability-pass.md) from Phase C). Banner lands when the async result settles.
- [ ] Cancel button is full-width grey, just above Submit, equal height. Closes the sheet without discarding the captured photo + note (per [doc 24 §8](24-phase-d-jobs-evidence-plan.md) — re-opening preserves the draft).
- [ ] No `alert()` / `confirm()` anywhere in the flow.

### B.3 · State machine (client)

- [ ] Capture lifecycle: `draft → uploading → pending_sync → submitted` (server-side once API returns).
- [ ] `draft` and `uploading` are **client-only**; never sent to server.
- [ ] `pending_sync` shows when the photo POST succeeded but the evidence POST hasn't yet — retry preserves the photo (no re-upload).
- [ ] `failed_upload` shows when both retries failed. Retry button re-uses the same `photoId` (no second blob write).
- [ ] On a successful `submitted`, the sheet emits a `evidence:captured` callback (or invokes the parent's setter) so "Today's captures" updates without a full route refresh.

### B.4 · "Today's captures" strip

- [ ] Lives on Phil job detail, below the area picker.
- [ ] Horizontally scrollable thumb + time. Tap → drawer (or simpler: full-page detail) with the captured photo + note + status pill.
- [ ] **Own captures only** (`capturedById === me.id`) — per [doc 24 §15.0 #5](24-phase-d-jobs-evidence-plan.md). Server already filters; client doesn't re-filter.
- [ ] Empty state: "No captures yet today" — short copy, no illustration.

### B.5 · Visual markers

All markers must use [doc 27 §6.2](27-interface-usability-pass.md) tones + labels:

- `submitted` → info — "Submitted"
- `reviewed` → success — "Reviewed"
- `rejected` → danger — "Rejected" (rejection reason inline below)
- `pending sync` → info — "Pending sync"
- `failed upload` → danger — "Retry upload"

**No new tones, no new labels.** Any divergence is a blocker.

### B.6 · Empty / loading / error / pending

- [ ] Initial sheet open with no draft → focus on camera, no skeleton.
- [ ] Sheet open with prior draft → preview + note re-rendered, "Resume" affordance not needed (it's just visible).
- [ ] In-flight POST → submit button disabled + spinner inside button + sheet still closed (the close happens on tap).
- [ ] POST error → inline error banner above the submit button: "Couldn't save. Tap retry." Retry button preserved with the photo + note.
- [ ] Network offline → top-of-sheet warning: "Offline — capture will sync when you're back online."

### B.7 · Mobile / accessibility

- [ ] Submit button ≥ 48×48 px. All interactive surfaces ≥ 48×48 px.
- [ ] Tap targets respect safe-area-inset-bottom (doc 27 §19.1 open question — sheet must not be clipped by the iOS home indicator).
- [ ] Sunlight contrast: black-on-yellow for primary, navy-on-white for body. No grey-on-grey.
- [ ] Status pill is colour + label; never colour alone.

### B.8 · Regression

- [ ] D1 routes still pass: `/phil/jobs`, `/phil/jobs/[jobId]` render.
- [ ] D2 endpoints unchanged in behaviour (D3 is a UI-only slice on top of D2).
- [ ] Phase B and Phase C surfaces unchanged.

### B.9 · Tests (D3)

- [ ] `src/components/phil/capture-sheet.test.tsx` — render, submit-disabled-while-in-flight, character-counter, cancel-preserves-state, sheet-closes-on-submit.
- [ ] `tests/phase-d-d3-capture.spec.ts` (Playwright) — full capture cycle on a logged-in tradie session.
- [ ] iOS Safari + Android Chrome + desktop Chrome smoke (per [doc 26 §B.2 Preview verification](26-phase-d-testing-checklist.md)).

---

## §C · D4 — admin evidence review

**Scope (future Session 7):** admin queue + drawer + mark reviewed / reject. See [doc 30](30-phase-d4-admin-evidence-review-spec.md) for the full build spec.

### C.1 · Component placement (binding)

- [ ] All review-UI client components live in `src/components/admin/`. None co-located with route folders. RSC manifest rule still binding.
- [ ] If D4 ships without the `/admin/jobs` route cutover (preferred, per §0 phasing), the review surface mounts at a safe path that `vercel.json` doesn't claim — provisionally `/v2/jobs/[jobId]/evidence` until §C.3 cutover decisions land.

### C.2 · Functional

- [ ] Queue view shows status pill (left), photo thumb (48×48), note excerpt, target (area + stage + task or "unattached"), captured-by, captured-at, actions (Mark reviewed / Reject).
- [ ] Reject opens modal with required reason (≤ 500 chars). Reject without reason → submit blocked.
- [ ] Bulk-select checkbox column. "Mark N reviewed" CTA appears when ≥ 1 row selected. Bulk reject is **not** in scope for D4 (one reason per item is the right shape; bulk reject muddles audit).
- [ ] Filters: status (`submitted` / `reviewed` / `rejected`) · capturedBy · date range · unattached-only. Default: `status === 'submitted'`.
- [ ] Drawer on row click: full-size photo, full note, target detail, full history (capture event + any rejections + current state) from `AuditLog`.
- [ ] Empty state: "No evidence captured for this job yet." (Per [doc 27 §9.6](27-interface-usability-pass.md).)

### C.3 · Route placement decision

D4 has two paths; the build session must pick one explicitly in its PR body:

- **A. Standalone `/v2/jobs/[jobId]/evidence`** (recommended for first ship). No `vercel.json` change. Lives parallel to the legacy admin. Cut over later in a separate PR.
- **B. Integrated into `/jobs/[jobId]/evidence` with the `/admin/jobs` cutover**. Higher-stakes; pairs with route cutover and SW cache version bump.

Default to A. Cutover (B) is its own slice.

### C.4 · Permissions

- [ ] Admin only writes (mark reviewed / reject).
- [ ] LH read-only (per [doc 24 §15.0 #6](24-phase-d-jobs-evidence-plan.md) — LH evidence review is read-only in Phase D).
- [ ] Tradie, client, anonymous → 403.

### C.5 · Visual markers

Reuse [doc 27 §6.2](27-interface-usability-pass.md):
- `submitted` (info)
- `reviewed` (success, may include a "lock" icon for immutability)
- `rejected` (danger, rejection reason inline)

### C.6 · State transitions

- [ ] `submitted → reviewed` via mark-reviewed.
- [ ] `submitted → rejected` (with `rejectionReason`) via reject modal.
- [ ] `reviewed → submitted` admin un-review — secondary action, admin-only. Optional in D4; can defer to D5.
- [ ] Any other transition rejected by the server.

### C.7 · Tests (D4)

- [ ] `src/components/admin/evidence-queue.test.tsx` — render, filter, bulk-select.
- [ ] `tests/phase-d-d4-admin-review.spec.ts` (Playwright) — mark reviewed + reject + reject-without-reason-blocked.
- [ ] `tests/admin-evidence-permissions.test.ts` — LH/tradie/client 403.

### C.8 · Regression

- [ ] D1, D2, D3 surfaces unchanged.
- [ ] Legacy admin pages still serve.

---

## §D · Regression matrix (every Dx merge)

Run **before** merge, on the preview, then again **after** production deploy.

**Logged-out routes (expect 200 → redirect to /v2/login):**

- [ ] `/phil/my-day`
- [ ] `/phil/hours`
- [ ] `/phil/gear`
- [ ] `/phil/jobs`
- [ ] `/phil/jobs/birdwood-iv3232`
- [ ] `/hours`
- [ ] `/hours/approvals`
- [ ] `/gear`
- [ ] `/command-centre`

**Logged-out routes (legacy, direct serve):**

- [ ] `/login`
- [ ] `/phil`
- [ ] `/my-day`
- [ ] `/my-gear`
- [ ] `/admin/operations`

**API auth wall (expect 401 with JSON):**

- [ ] `GET /api/auth?action=me`
- [ ] `POST /api/auth?action=login` with bogus creds
- [ ] `GET /api/jobs`
- [ ] `GET /api/assets`
- [ ] `GET /api/time-entries`
- [ ] `GET /api/jobs/[jobId]/evidence` (post-D2)

**Authed tradie (read-only smoke):**

- [ ] `/phil/jobs` lists assigned jobs only.
- [ ] `/phil/jobs/[jobId]` renders for own-assigned job.
- [ ] `/phil/jobs/[jobId-not-mine]` shows "not assigned to you" friendly card.
- [ ] `/api/jobs/[jobId]/evidence` GET returns only own captures.

**Authed admin:**

- [ ] `/phil/jobs`, `/phil/my-day`, `/phil/gear` redirect admin to `/command-centre` (middleware `landingFor(admin)`).
- [ ] `/command-centre`, `/hours/approvals`, `/gear` all serve directly.
- [ ] `/api/jobs/[jobId]/evidence` GET returns all captures on that job.

**Cross-surface (after D3 + D4 are both live):**

- [ ] Tradie captures evidence → admin sees it in the review queue within 5 seconds.
- [ ] Admin marks reviewed → tradie's "Today's captures" pill flips to `reviewed` on next refresh.
- [ ] Admin rejects with reason → tradie sees the reason inline; can capture again (fresh row, old preserved).

---

## §E · Production smoke (post-deploy)

Run **immediately** after the merge commit's Vercel deployment goes READY and the `buhlos.com` alias has switched.

- [ ] Run §D regression matrix against `https://buhlos.com` (not the preview).
- [ ] No 4xx / 5xx spikes in Vercel logs in the first 30 minutes.
- [ ] No "blank page" report from Oskar in the first 1 hour.
- [ ] Audit log has at least one new row per capture (verify via admin route post-D4, or via blob read pre-D4).
- [ ] No orphan photos: if D2 ships before D3, photos uploaded but not evidenced are acceptable but counted (manual blob inspection at exit).

**Cleanup rules:**

- [ ] No test data created in production (read-only smoke only — no manual captures unless explicitly part of a field test).
- [ ] Field test data (D3 / D4 field-test script in [doc 26 §C](26-phase-d-testing-checklist.md)) labelled `TEST <feature> <ISO timestamp>` so it can be filtered out.
- [ ] Field test captures: photo blobs survive (don't manually delete), evidence rows can be marked `rejected` with reason "TEST" so they don't pollute counts.

---

## Cross-references

- [24-phase-d-jobs-evidence-plan.md](24-phase-d-jobs-evidence-plan.md) — binding scope + data model.
- [26-phase-d-testing-checklist.md](26-phase-d-testing-checklist.md) — broader Phase D testing matrix (D1, D4-cutover, D5, D6 sections still authoritative).
- [27-interface-usability-pass.md](27-interface-usability-pass.md) — UI rules + §6.2 marker dictionary.
- [29-phase-d3-phil-capture-spec.md](29-phase-d3-phil-capture-spec.md) — D3 capture UI spec + build prompt.
- [30-phase-d4-admin-evidence-review-spec.md](30-phase-d4-admin-evidence-review-spec.md) — D4 admin review spec + build prompt.

---

## Document status

| Field | Value |
| --- | --- |
| Document | `docs/rebuild-audit/28-d2-d3-d4-evidence-qa-checklist.md` |
| Author | Session 4 (non-interference QA / UX planning agent) |
| Branch | `session-4-qa-ux-planning` |
| Status | **Docs-only. Planning artefact.** No app code implied. |
| Phase precondition | D1 shipped (PR #11). |
| Next action | Session 5 ticks §A in the D2 PR body. Future D3 session ticks §B. Future D4 session ticks §C. Every Dx merge runs §D + §E. |
