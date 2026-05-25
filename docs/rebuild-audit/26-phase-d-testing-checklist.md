# 26 · Phase D — testing & quality checklist

> **Status: Partially superseded** (2026-05-25). The baseline gates (§A), regression matrix (§E), and field test script (§C) **remain authoritative** — every PR touching the rebuild surface still walks these. The per-slice §B sections are mixed:
>
> | Section | Status |
> | --- | --- |
> | §A · Baseline gates | ✅ authoritative — every Phase D / Phase D-adjacent PR walks these |
> | §B.1 · D1 (Phil jobs read-only) | ✅ authoritative — D1 shipped as planned |
> | §B.2 · D2 (evidence domain + Phil capture, fixtures) | ❌ superseded by [doc 28 §A](28-d2-d3-d4-evidence-qa-checklist.md). D2 shipped as API-only — no Phil capture in this slice. |
> | §B.3 · D3 (evidence persistence + audit log + real wiring) | ❌ superseded by [doc 28 §B](28-d2-d3-d4-evidence-qa-checklist.md) + [doc 29 §11](29-phase-d3-phil-capture-spec.md). D3 shipped as the Phil capture UI on top of D2's already-real API. |
> | §B.4 · D4 (admin Jobs surface + `/admin/jobs` cutover) | ❌ superseded by [doc 28 §C](28-d2-d3-d4-evidence-qa-checklist.md) + [doc 30](30-phase-d4-admin-evidence-review-spec.md). D4 shipped as admin evidence review at `/v2/jobs/[jobId]/evidence` — no `vercel.json` cutover. |
> | §B.5 · D5 (`/admin/activity` cutover) | ❌ did not ship as planned. D5 shipped instead as evidence hardening — see [phase-d5-runbook.md](phase-d5-runbook.md). An `/activity` feed remains a documented follow-up. |
> | §B.6 · D6 (exit polish + Command Centre evidence count) | ❌ did not ship as planned. D6 shipped instead as the admin jobs index at `/v2/jobs` — see [phase-d6-admin-jobs-index-runbook.md](phase-d6-admin-jobs-index-runbook.md). |
> | §C · Field test script | ✅ authoritative — the script still describes the loop Phil + admin walk end-to-end. |
> | §D · Exit gates | ✅ authoritative for the loops that shipped (D1 + D2/D3/D4 evidence + D.5 snags). |
> | §E · Regression matrix | ✅ authoritative — every Dx merge still runs these. |
>
> **Canonical references:** [23-rebuild-index.md](23-rebuild-index.md) §"Phase D shipped slices", [phase-d55-snags-runbook.md](phase-d55-snags-runbook.md) for the D.5 field test script, and the runbooks linked above.
>
> Per-slice and exit-level testing checklist for Phase D. Use this as the verification source-of-truth during each Dx build session and at Phase D exit. Built on [17-testing-and-quality-plan.md](17-testing-and-quality-plan.md) §C.4 baseline; specific to the Phase D jobs + evidence scope per [24-phase-d-jobs-evidence-plan.md](24-phase-d-jobs-evidence-plan.md).
>
> **Audience:** Phase D build sessions, Oskar (preview verification), and any future on-call after Phase D ships.

---

## How to use this doc

- Every Dx PR (D1 through D6) walks the corresponding § below before opening the PR.
- The "preview verification" sections are performed by Oskar (not the build agent) on the Vercel preview URL.
- The "field test" section runs once before D4 cutover, then again at D6 exit.
- Failed checks halt the slice. Do not paper over a failure with a `.skip` annotation.

---

## §A · Baseline gates (every Phase D PR)

These must pass on every Dx PR, full stop. They mirror [17] §A.

```
npm run typecheck         → 0 errors. No new any. No new @ts-ignore.
npm run lint              → 0 warnings. No new no-restricted-syntax violations.
npm run test              → all green. No skipped tests (except documented
                            "pending seeded test accounts" Playwright tests).
npm run build             → succeeds. Bundle size within ±10% of pre-Phase-D.
npm run format:check      → all clean.
npm run check:admin-shell             → green (every admin page wires SHELL.boot)
npm run check:sw-cache-version        → green (CACHE_VERSION bumped if shell
                                        files changed — D1, D4, D5)
npm run check:production-shell        → green
npm run smoke:admin-routes            → green (18-assertion smoke)
npm run test:e2e          → Phase A + B + (C if merged) + Dx specs all pass
```

### A.1 · RSC client-manifest grep (D-26 binding rule)

Per [24] risk D-26 and PR #6 commit `1c92db3` post-mortem, any `"use client"` file sitting next to a page that is ≥2 route segments deep will silently break production SSR with `Error: Could not find the module ... in the React Client Manifest` (digest 292479990).

**Pre-merge grep — must be empty:**

```bash
# Any "use client" file under src/app/phil/jobs/ or src/app/(admin)/jobs/
# is a regression of the D-26 pattern. The only valid client locations are
# src/components/phil/ and src/components/admin/.
git ls-files 'src/app/phil/jobs' 'src/app/(admin)/jobs' \
  | xargs grep -l '"use client"' 2>/dev/null
```

If the grep emits anything, fail the PR. Move the offending file under
`src/components/phil/` or `src/components/admin/` and have the page import it.

Optionally add this as `scripts/check-rsc-client-locations.js` and wire into
the `npm run lint` chain when a Phase D D1+ PR lands.

If a check goes red, fix the root cause. Don't suppress.

---

## §B · Per-slice testing checklists

### B.1 · D1 — jobs domain + Phil read-only

**Unit tests (Vitest):**

- [ ] `src/domains/jobs/jobs.test.ts`:
  - [ ] `JobSchema` parses each fixture in `src/domains/jobs/fixtures.ts`.
  - [ ] `JobSchema` rejects: missing `name`, missing `status`, status not in enum, malformed `startDate` (not YYYY-MM-DD), `areaGroups` not an array.
  - [ ] `JobAreaGroupSchema` parses nested fixtures; rejects missing `id` or missing `areas`.
  - [ ] `JobAreaSchema` parses with and without `roughInTasks` / `fitOffTasks` override.
  - [ ] `client.listMyJobs()` returns `ok: true` with parsed response on 200.
  - [ ] `client.listMyJobs()` returns `ok: false` with typed error on 4xx / 5xx (no throw).
  - [ ] `client.getJob('non-existent')` returns `ok: false, error.status === 404`.
  - [ ] `service.byStatus()` filters correctly for each status enum value.
  - [ ] `service.activeJobs()` excludes archived/complete.
  - [ ] `service.jobAddressLine(job)` handles missing `siteAddress` cleanly.
  - [ ] `service.effectiveTasksForArea(job, area, 'roughIn')` returns area override if non-empty, else job-level.
  - [ ] `service.effectiveTasksForArea(job, area, 'fitOff')` same logic.
  - [ ] `service.effectiveTasksForArea(job, area, 'roughIn')` returns `[]` when both area override and job-level are empty (not undefined).

**Integration tests:**

- [ ] (Optional) Mock `fetch` for `/api/jobs` → parse Job list end-to-end.

**Route smoke (Playwright `tests/phase-d-d1-jobs-read-only.spec.ts`):**

- [ ] Unauthenticated `/phil/jobs` → redirects to `/v2/login?next=%2Fphil%2Fjobs`.
- [ ] Unauthenticated `/phil/jobs/test-job-id` → redirects to `/v2/login`.
- [ ] (Skipped pending seeded accounts) Tradie login → `/phil/jobs` → list visible with ≥1 assigned-to-them job; jobs NOT assigned to them are absent.
- [ ] (Skipped pending seeded accounts) Tradie taps a job → `/phil/jobs/[jobId]` → header + site context block visible.
- [ ] (Skipped pending seeded accounts) Tradie tries to URL-poke `/phil/jobs/<another-tradies-jobid>` → 403 / redirect to forbidden state.
- [ ] Phil bottom tab bar: **Jobs** tab has live link (no UC pill).
- [ ] Phil bottom tab bar: **Snag** tab still has UC pill, no link, `cursor: not-allowed`.
- [ ] DOM does not contain "Site Office" or "Switchboard" (case-insensitive) anywhere.

**Preview verification (Oskar — Vercel preview URL):**

- [ ] Open preview `/phil/jobs` on iPhone (Safari) and Android Chrome → list renders cleanly.
- [ ] Open one job → site context renders; area-groups list renders; archived items hidden.
- [ ] Tap "Capture evidence" CTA → shows "coming in D2" UC pill (no working flow).
- [ ] Tap a "Mark task done" task → no action (D3 wires it).
- [ ] DemoModeBanner is **ON** (D1 still uses fixtures).
- [ ] No console errors in browser DevTools.
- [ ] Hours loop reference E2E still passes on preview.

**Regression:**

- [ ] Legacy `/phil`, `/my-day`, `/phil-hours`, `/my-gear` all still serve.
- [ ] Legacy `/jobs`, `/jobs/:jobId` still serve (legacy admin — cutover is D4).
- [ ] `/command-centre`, `/hours/approvals` unchanged.
- [ ] Phase C `/phil/gear` flow still works (`(Phase C must be merged)`).

---

### B.2 · D2 — evidence domain + Phil capture (fixtures)

> ⚠️ **Superseded** by [doc 28 §A](28-d2-d3-d4-evidence-qa-checklist.md). D2 shipped as evidence domain + persistence API foundation (no Phil capture in this slice; capture moved to D3). This section is kept for history.

**Unit tests (Vitest):**

- [ ] `src/domains/evidence/evidence.test.ts`:
  - [ ] `EvidenceItemSchema` parses every fixture.
  - [ ] `EvidenceItemSchema` rejects: missing `photoId` for `kind: 'photo'`, note > 280 chars, invalid status enum, `photoId` without `photoUrl`, missing `capturedById`.
  - [ ] `CreateEvidencePayloadSchema` validates client payload.
  - [ ] `service.canTransition(from, to)` returns true for every valid transition, false for every invalid.
  - [ ] `service.resizeImageToDataUrl(file, 1920, 0.7)` returns a data URL.
  - [ ] `service.humanFileSize(bytes)` formats correctly for KB / MB.

**Integration tests:**

- [ ] `tests/api/photos-upload-evidence.test.ts`: mock `@vercel/blob.put`, POST a base64 dataUrl, assert returned shape `{ id, url, capturedAt }`.
- [ ] Same test: POSTing without `dataUrl` → 400.
- [ ] Same test: POSTing a >6MB image → 413.
- [ ] Same test: POSTing without an authenticated session → 401.
- [ ] Same test: POSTing as a worker NOT assigned to the job → 403.

**Route smoke (Playwright `tests/phase-d-d2-evidence-capture.spec.ts`):**

- [ ] Tradie opens job → taps Capture → modal opens.
- [ ] Tradie picks a file via the file input → preview renders.
- [ ] Tradie picks stage + area + task → values reflect in payload.
- [ ] Tradie writes a 281-char note → submit blocked client-side with clear message.
- [ ] Tradie writes a 280-char note → submit OK.
- [ ] Tradie taps Submit twice quickly → only one POST fires (button disabled during in-flight).
- [ ] Tradie taps Cancel mid-capture → modal closes, draft preserved in component state for next open.
- [ ] DemoModeBanner is **ON** for evidence (D3 flips it off).

**Preview verification:**

- [ ] Capture flow works from iOS Safari (camera permission prompt, rear camera default).
- [ ] Capture flow works from Android Chrome.
- [ ] Capture flow works from Chrome desktop (file picker fallback).
- [ ] Captured image preview is ≤700KB after client-side resize.
- [ ] No console errors during full capture cycle.

**Regression:**

- [ ] D1 routes still pass.
- [ ] Existing photo uploads for snags (legacy `public/phil.html`) still work — the new `action=upload-evidence-photo` branch doesn't change existing actions.
- [ ] `api/photos.js` other actions (upload-snag-photo, upload-itp-photo, default) unchanged.

---

### B.3 · D3 — evidence persistence API + audit log + Phil real wiring

> ⚠️ **Superseded** by [doc 28 §B](28-d2-d3-d4-evidence-qa-checklist.md) + [doc 29 §11](29-phase-d3-phil-capture-spec.md). D3 shipped as the Phil capture UI, built against D2's already-real persistence API (which shipped one slice earlier than this plan assumed). Kept for history.


**Unit tests (Vitest):**

- [ ] `src/domains/audit-log/audit-log.test.ts`:
  - [ ] `AuditLogSchema` parses every action type.
  - [ ] `AuditLogSchema` enforces required fields.
  - [ ] `audit-log/client.ts append()` is append-only (no update method exposed).

**Integration tests:**

- [ ] `src/app/api/jobs/[jobId]/evidence/route.test.ts`:
  - [ ] POST with valid payload → 200 + parsed EvidenceItem with server-set fields.
  - [ ] POST with invalid stage value → 400.
  - [ ] POST with stage=`roughIn` but areaId not in job's areaGroups → 400.
  - [ ] POST with stage=`roughIn` + taskId not in resolved tasks for that area → 400.
  - [ ] POST as unauthenticated → 401.
  - [ ] POST as a worker not assigned to the job → 403.
  - [ ] GET as admin → list (all items, all workers).
  - [ ] GET as tradie → filtered to capturedById === me.id.
  - [ ] GET as LH (assigned to job) → all items on this job (read-only).
  - [ ] GET as client → 403.
  - [ ] POST `/review` body with `status='reviewed'` as admin → 200.
  - [ ] POST `/review` body with `status='rejected'` and missing `rejectionReason` → 400.
  - [ ] POST `/review` body with `status='reviewed'` as LH → 403.
  - [ ] POST `/review` body with `status='reviewed'` as tradie → 403.
  - [ ] Concurrent POST creating two EvidenceItems on the same job → both succeed (race window is brief; test doesn't fail on this — see [24] D-18).

**Route smoke (Playwright `tests/phase-d-d3-evidence-persistence.spec.ts`):**

- [ ] Tradie captures photo + note → API returns 200 with EvidenceItem.
- [ ] Captured item appears in "Today's captures" strip within 2 seconds.
- [ ] Capture without note still succeeds.
- [ ] Capture with note > 280 chars blocked.
- [ ] Tradie can list own captures via GET.
- [ ] Tradie cannot see another tradie's captures (server-filtered).
- [ ] Admin sees all captures for the job.
- [ ] Admin marks reviewed → status flips on Phil after refresh.
- [ ] Admin rejects with reason → reason visible on Phil.
- [ ] Admin rejects without reason → 400.
- [ ] DemoModeBanner is **OFF** for evidence on Phil pages.

**Preview verification:**

- [ ] Full Phil capture-and-see cycle on iOS + Android with real network.
- [ ] One capture per second sustained for 10 captures → all persist.
- [ ] Capture with intentionally-killed wifi mid-upload → item stays `pending_sync`; retry succeeds when wifi restored.

**Regression:**

- [ ] D1 + D2 routes still pass.
- [ ] Hours loop reference E2E passes.
- [ ] `api/photos.js` other actions unchanged.
- [ ] No regression to `data.json` structure for existing jobs (verify by reading one before + after).

---

### B.4 · D4 — admin Jobs surface + /admin/jobs cutover

> ⚠️ **Superseded** by [doc 28 §C](28-d2-d3-d4-evidence-qa-checklist.md) + [doc 30](30-phase-d4-admin-evidence-review-spec.md). D4 shipped as admin **evidence review only** at `/v2/jobs/[jobId]/evidence` — no `vercel.json` cutover, legacy `/admin/jobs.html` untouched. The admin jobs **index** (a separate concern) shipped later as D6 at `/v2/jobs` — see [phase-d6-admin-jobs-index-runbook.md](phase-d6-admin-jobs-index-runbook.md). Kept for history.


**This is a CUTOVER PR. Higher stakes. Extra scrutiny.**

**Unit + integration:** all D1–D3 tests still pass.

**New unit tests:**

- [ ] Admin Evidence panel filter logic.
- [ ] Bulk mark-reviewed: select N, POST N review actions, assert each AuditLog entry.

**Route smoke (Playwright `tests/phase-d-d4-admin-jobs.spec.ts`):**

- [ ] Unauthenticated `/jobs` → redirect to `/v2/login`.
- [ ] Unauthenticated `/jobs/[jobId]` → redirect.
- [ ] Admin login → `/jobs` → list visible with real jobs.
- [ ] Admin clicks into job → Overview, Evidence, Hours sections render.
- [ ] Admin reviews evidence → status flips.
- [ ] Admin rejects with reason → reason visible.
- [ ] Bulk mark-reviewed: select 3, mark, all 3 update.
- [ ] Filters work: by status, by evidence-pending.
- [ ] Search works: by name + ref.
- [ ] DemoModeBanner OFF on `/jobs` and `/jobs/[jobId]`.

**Cutover-specific Playwright:**

- [ ] `/legacy/admin-jobs` → renders the legacy `public/admin/jobs.html` (quarantine works).
- [ ] `/legacy/admin-jobs/<jobId>` → renders the legacy `public/admin/job.html`.
- [ ] `/legacy/project/<jobId>` → renders the legacy `public/project.html`.
- [ ] All admin-side legacy pages OTHER than `/jobs` continue to work via existing rewrites (`/admin/operations`, `/admin/snags`, etc.).

**Pre-cutover preview verification (Part A — Oskar on `/v2/jobs`):**

- [ ] `/v2/jobs` renders real job list within 1s on cold load.
- [ ] `/v2/jobs/[jobId]` renders within 2s.
- [ ] Evidence panel shows D3 captures.
- [ ] Marking one reviewed updates Phil within 5s.
- [ ] Sign-off recorded in PR thread before Part B commit lands.

**Post-cutover preview verification (Part B — Oskar):**

- [ ] `/jobs` is now the new admin surface.
- [ ] `/admin/jobs` is now the new admin surface (same Next.js page).
- [ ] `/legacy/admin-jobs` serves the old page (preserved).
- [ ] SW cache version bumped — installed PWAs receive update on next open.

**Manual production smoke (post-deploy, 1-hour on-call window):**

- [ ] First 1-hour window: monitor `/jobs` + `/jobs/:jobId` for 4xx/5xx spikes (Vercel logs).
- [ ] Open `/jobs` from at least 2 admin accounts → list renders correctly.
- [ ] Cross-link from `/command-centre` to `/jobs` works.
- [ ] No "blank page" reports from Oskar after 1 hour.

**Rollback test (rehearse before deploy):**

- [ ] `vercel promote <previous-deploy>` restores the pre-D4 state.
- [ ] `git revert <D4 merge>` + push → Vercel auto-rolls back.
- [ ] Both rollback paths verified before the Monday deploy.

**Regression:**

- [ ] Hours loop reference E2E passes.
- [ ] All Phase A–C surfaces still work.
- [ ] `/phil/jobs` still works.

---

### B.5 · D5 — admin Activity surface + /admin/activity cutover

> ⚠️ **Did not ship as planned.** D5 shipped instead as evidence hardening (audit-log read endpoint + admin un-review flow + production rollout smoke) — see [phase-d5-runbook.md](phase-d5-runbook.md). An `/admin/activity → /activity` audit-log feed remains a documented open follow-up (the underlying monthly journal blobs already exist). Kept for history.


**Smaller cutover than D4. Same scrutiny pattern, lower stakes.**

**Unit:** AuditLog list helper covered. Filter logic covered.

**Route smoke (Playwright `tests/phase-d-d5-activity.spec.ts`):**

- [ ] Unauthenticated `/activity` → redirect.
- [ ] Admin login → `/activity` → feed visible with D3 evidence events.
- [ ] Filter by action type: `evidence.captured` shows only captures.
- [ ] If decision §15.1 #8 = include legacy events: legacy per-job audit events also appear.
- [ ] `/legacy/admin-activity` serves the legacy page.

**Preview:** Oskar opens `/v2/activity` (if used as pre-cutover preview) or `/activity` post-cutover.

**Regression:** all D1–D4 passes.

---

### B.6 · D6 — exit polish

> ⚠️ **Did not ship as planned.** D6 shipped instead as the admin jobs index at `/v2/jobs` — the discoverability slice that makes D4 evidence review + D.5 snags reachable from the rebuild sidebar. See [phase-d6-admin-jobs-index-runbook.md](phase-d6-admin-jobs-index-runbook.md). The "exit polish" checklist below (UC removal, Command Centre evidence count, doc cleanup) was not bundled into a single PR — the underlying items are tracked in the per-slice runbooks under "Open questions / future work". Kept for history.


**No new feature tests.**

**Phase D §12 acceptance criteria walked manually:**

- [ ] Walk through every checkbox in [24-phase-d-jobs-evidence-plan.md] §12 functional.
- [ ] Walk through every checkbox in §12 technical.
- [ ] Walk through every checkbox in §12 quality.
- [ ] Walk through every checkbox in §12 deploy/cutover.
- [ ] Walk through every checkbox in §12 documentation.

**Command Centre evidence count:**

- [ ] On `/command-centre`, "X items of evidence pending review" line item shows real count.
- [ ] Link goes to `/jobs?filter=evidence-pending`.
- [ ] Count is 0 → shows "All evidence reviewed" (positive empty state).

---

## §C · Field test script (D4 pre-cutover + D6 exit)

This is the manual, with-a-real-tradie-on-a-real-site test. Performed by Oskar with one nominated tradie + one admin (per §15.1 #9 decision).

### C.1 · Setup

- One real active job in production data with: area-groups, areas, roughIn + fitOff tasks.
- One real tradie account, assigned to that job.
- One real admin account.
- Tradie's phone: latest Phil PWA installed.
- Admin: laptop, Chrome, signed in.

### C.2 · Phil tradie path

- [ ] Tradie opens Phil from home-screen icon → lands on `/phil/my-day` (Phase B).
- [ ] Tradie taps **Jobs** tab → `/phil/jobs` → sees the test job in the list.
- [ ] Tradie taps the job → `/phil/jobs/[jobId]` → sees:
  - [ ] Job name + status pill.
  - [ ] Site address (legible in sunlight — go outside for this).
  - [ ] Access notes block.
  - [ ] Area-groups → areas list.
- [ ] Tradie picks an area → stage chooser appears → taps Rough-in → task list appears.
- [ ] Tradie taps **Capture evidence** → modal opens → camera prompt accepted → photo taken → preview renders.
- [ ] Tradie picks the same area + stage + a task → adds 1-line note → taps Submit.
- [ ] Tradie sees the captured item in "Today's captures" strip within 2s.
- [ ] Tradie repeats with another area / stage / task — 5 captures total.
- [ ] Tradie marks one task complete → status flips.
- [ ] Tradie kills wifi → captures one more photo → item stays `pending_sync` with clear indicator.
- [ ] Tradie re-enables wifi → item flips to `submitted` within 5s.

### C.3 · Admin path

- [ ] Admin opens `/jobs` → sees the test job in the list with "5 pending evidence" pill or similar.
- [ ] Admin opens `/jobs/[jobId]` → Overview tab renders.
- [ ] Admin opens Evidence tab → sees all 5 captures with photo thumbs, notes, target tags (area + stage + task), captured-by + captured-at.
- [ ] Admin clicks one capture → full-size photo + full note + metadata.
- [ ] Admin marks 3 reviewed.
- [ ] Admin rejects 1 with reason "Photo is blurry — please retake".
- [ ] Admin leaves 1 unreviewed (to verify queue state).
- [ ] Admin opens `/activity` → sees all 5 captured events + 3 reviewed + 1 rejected events in feed.

### C.4 · Cross-surface verification

- [ ] Tradie opens `/phil/jobs/[jobId]` → "Today's captures" shows updated states:
  - 3 marked Reviewed.
  - 1 marked Rejected with reason "Photo is blurry — please retake".
  - 1 still Submitted.
- [ ] Tradie taps the rejected item → re-captures (new EvidenceItem; old one preserved with rejected state).
- [ ] Admin refreshes Evidence tab → sees the new submitted item alongside the old rejected one.

### C.5 · Pass / fail

Pass if:
- All 5 captures persist.
- Pending-sync recovery works.
- Cross-surface state propagation under 5 seconds.
- No "loose" captures (every item has correct target metadata).
- No console errors.
- No "blank page" anywhere.

Fail if any of the above. If failed, halt the cutover (D4) or revert (D6).

---

## §D · Exit gates (must all be true to declare Phase D shipped)

- [ ] All §A baseline gates green on `main`.
- [ ] All §B.1 through §B.6 per-slice checklists complete.
- [ ] §C field test passed end-to-end.
- [ ] Phase D §12 acceptance criteria (every section) ticked.
- [ ] One billing cycle (~4 weeks) of real production use post-D4 without rollback or major regression.
- [ ] Oskar sign-off recorded in [24-phase-d-jobs-evidence-plan.md] §17.
- [ ] Phase D.5 (snags) planning session scheduled.
- [ ] [00-executive-summary.md](00-executive-summary.md) updated with Phase D summary.
- [ ] No remaining `TODO(Phase D)` in src/.
- [ ] No skipped tests added for Phase D code (the `pending seeded test accounts` Phase B pattern is acceptable, but additions need a clear comment).

---

## §E · Regression matrix (run before every Dx merge)

| Surface | Test | D1 | D2 | D3 | D4 | D5 | D6 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/v2/login` | renders sign-in form | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `/command-centre` | unauth redirects; auth renders | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `/phil/my-day` | hours capture works | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `/hours/approvals` | admin approves entry | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `/phil/gear` | Phase C gear list (if merged) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `/phil/jobs` | Phil jobs list | new | ✓ | ✓ | ✓ | ✓ | ✓ |
| `/phil/jobs/[id]` | Phil job detail | new | ✓ | ✓ | ✓ | ✓ | ✓ |
| Capture sheet | Phil capture flow | — | new | ✓ | ✓ | ✓ | ✓ |
| `/api/jobs/[id]/evidence` | persistence + audit | — | — | new | ✓ | ✓ | ✓ |
| `/jobs` | admin jobs list | legacy | legacy | legacy | new (cutover) | ✓ | ✓ |
| `/jobs/[id]/evidence` | admin review panel | — | — | — | new | ✓ | ✓ |
| `/activity` | admin activity feed | legacy | legacy | legacy | legacy | new (cutover) | ✓ |
| `/legacy/admin-jobs` | legacy admin jobs (quarantined) | n/a | n/a | n/a | new | ✓ | ✓ |
| `/legacy/admin-activity` | legacy activity (quarantined) | n/a | n/a | n/a | n/a | new | ✓ |
| Legacy `/admin/snags`, `/admin/plans`, etc. | all serve via existing rewrites | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Snag tab (Phil) | shows UC pill, no link | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| DemoModeBanner | visible iff a domain on the page uses fixtures | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

---

## Cross-references

- [24-phase-d-jobs-evidence-plan.md](24-phase-d-jobs-evidence-plan.md) — the binding plan.
- [25-phase-d-build-prompts.md](25-phase-d-build-prompts.md) — paste-ready build prompts that reference this doc.
- [17-testing-and-quality-plan.md](17-testing-and-quality-plan.md) — baseline gates this doc extends.
- [16-migration-strategy.md](16-migration-strategy.md) §C.4 — preventing blank-page regressions during cutover.
- [20-agent-rules.md](20-agent-rules.md) §"Documentation posture" — command-results expectations.
