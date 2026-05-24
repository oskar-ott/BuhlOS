# 29 · Phase D3 — Phil evidence capture UI · spec + build prompt

> **Status:** docs only. Planning artefact. No app code implied or built by this doc.
>
> **Read first:** [24-phase-d-jobs-evidence-plan.md](24-phase-d-jobs-evidence-plan.md) §5.5 + §6.1 + §7 + §8, [27-interface-usability-pass.md](27-interface-usability-pass.md) §4 + §6 + §8.6 + §11 + §12, [28-d2-d3-d4-evidence-qa-checklist.md](28-d2-d3-d4-evidence-qa-checklist.md) §B, [src/components/phil/PhilJobDetail.tsx](../../src/components/phil/PhilJobDetail.tsx) (D1 read-only detail; the floating Capture CTA replaces the current `UnderConstructionPanel`).
>
> **Phasing note:** this is the "Phil capture UI" slice on top of D2's evidence-domain-and-persistence API. **In this session's phasing**, D3 = Phil capture UI. Doc 25's older D2/D3 build prompts are superseded for the evidence loop — see [doc 28 §0](28-d2-d3-d4-evidence-qa-checklist.md) for the reconciliation.

---

## 1 · Purpose

Phil workers capture evidence (photo + optional note) attached to a job. Optionally attached to a stage + area + task using the canonical `roughInTasks` / `fitOffTasks` task IDs. Each capture posts through D2's evidence persistence API and lands on the admin queue in D4.

The slice is UI only — no schema change, no API change, no audit-log change. It consumes the D2 endpoints as-is.

---

## 2 · Scope

### 2.1 · In scope

- Floating CTA "Capture evidence" on `/phil/jobs/[jobId]` (replaces the current `UnderConstructionPanel`).
- Full-screen capture sheet (modal) launched from that CTA.
- Photo capture (camera default, gallery fallback).
- Client-side image resize to ≤ 1920px @ 0.7 jpeg quality (~ 300-700 KB target).
- Optional stage + area + task pickers using canonical job structure (no legacy `stages: { roughIn: [strings] }`).
- Optional note input (≤ 280 chars; character counter).
- Submit → photo POST → evidence POST → "Today's captures" updates.
- Pending / failed-upload / submitted states with the [doc 27 §6.2](27-interface-usability-pass.md) marker dictionary.
- "Today's captures" horizontal strip on Phil job detail showing the worker's **own** captures (server-filtered; client never re-filters).
- Tap a capture → drawer (preferred) or page with full photo + note + status + rejection-reason-if-any.

### 2.2 · Out of scope (defer)

- Admin evidence review surface — that's [doc 30 / D4](30-phase-d4-admin-evidence-review-spec.md).
- Offline-first sync engine. A simple `pending_sync` indicator that survives a retry within the same component lifetime is fine; a durable queue + conflict resolver is Phase F+.
- "Today's captures" cross-job aggregation (today across all jobs). D3 ships per-job only.
- Snags / ITPs / RFIs / materials / AI plan interpretation.
- Evidence editing (workers can recapture, not edit). The existing row stays in place.
- Bulk capture (multi-photo per submit). One photo per submit.
- Video.

---

## 3 · Routes

| Route | Owner | Notes |
| --- | --- | --- |
| `/phil/jobs/[jobId]` | Next.js (existing, server component) | D3 lifts the UC panel and renders the floating Capture CTA + Today's captures strip. |
| **No new route in D3.** | — | Capture is a modal sheet within the existing detail page. URL stable on retry. |

**Decision:** capture is a **sheet inside the detail page**, not a dedicated route. Rationale: a route change on retry (`/capture` → back → `/[jobId]` → forward → `/capture`) is bad UX; the sheet keeps the URL stable so a worker who taps the wrong photo and starts again doesn't get a navigation history littered with `/capture` entries.

(If a future requirement forces a route — e.g. for a "deep link to capture" SMS reminder — it should be added then, not now.)

---

## 4 · File plan

All new files **live in `src/components/phil/`** per the binding RSC-manifest rule ([doc 24 D-26](24-phase-d-jobs-evidence-plan.md), [doc 27 §10](27-interface-usability-pass.md), enforced by [doc 26 §A.1](26-phase-d-testing-checklist.md) grep).

### 4.1 · New files

| Path | Role |
| --- | --- |
| `src/components/phil/CaptureSheet.tsx` | The full-screen capture modal. Client component. Receives `job: Job` (full structure, for area/stage/task pickers) and `initialContext?: { stage?, areaId? }` as props from the detail page. |
| `src/components/phil/CapturePhotoPicker.tsx` | Encapsulates the camera/gallery `<input type="file" accept="image/*" capture="environment">` + preview + retake. Pure presentation; the sheet owns state. |
| `src/components/phil/CaptureTargetPickers.tsx` | Stage + area + task pickers. Consumes `effectiveTasks` from `@/domains/jobs/format`. |
| `src/components/phil/TodaysCapturesStrip.tsx` | Horizontal scrollable strip on the detail page. Reads from `evidence.client.listForJob(jobId)`. |
| `src/components/phil/EvidenceDrawer.tsx` | Optional — if the strip uses a drawer instead of a route, the drawer body lives here. |
| `src/components/phil/CaptureSheet.test.tsx` | Vitest + React Testing Library. |
| `src/components/phil/TodaysCapturesStrip.test.tsx` | Same. |
| `tests/phase-d-d3-capture.spec.ts` | Playwright. Full capture cycle. |

### 4.2 · Edits

| Path | Edit |
| --- | --- |
| `src/components/phil/PhilJobDetail.tsx` | Replace the `Capture evidence` `UnderConstructionPanel` with the real CTA + sheet trigger. Add `TodaysCapturesStrip` below the area picker. Keep the file under 250 lines if possible — extract anything new beyond ~30 lines into a child component in `src/components/phil/`. |
| `src/app/phil/jobs/[jobId]/page.tsx` | Server component fetches the job (already does) + the today-captures list (new). Passes both to `PhilJobDetail` as props. No `"use client"` added here. |
| `src/components/phil/PhilJobsList.tsx` | **No edit needed.** Job list is unrelated to capture. |

### 4.3 · No new domain code

D2 ships `src/domains/evidence/`. D3 consumes it. **D3 must not add new schemas or service methods**; if a helper is needed, it should be considered for D2's domain layer in a follow-up — not in D3's UI PR.

If `evidence.client.listForJob(jobId)` does not exist after D2, file a QA finding before opening the D3 PR. (Likely outcome: D2 already ships it because the admin review surface needs it too. Confirm in D2's PR.)

---

## 5 · API contract (consumed)

D3 reads and writes via D2's endpoints. The contract is sketched here so the build session doesn't have to re-derive it from D2's PR.

### 5.1 · `POST /api/photos?jobId=<id>&action=upload-evidence-photo`

Existing legacy endpoint with D2's new action branch.

**Request:** JSON `{ dataUrl: string }` where `dataUrl` is a base64-encoded jpeg (≤ 6 MB after client-side resize).

**Response 200:** `{ id: string, url: string, capturedAt: string }`.

**Errors:** 400 (missing dataUrl), 401, 403, 413 (> 6 MB).

### 5.2 · `POST /api/jobs/[jobId]/evidence`

D2's persistence endpoint. (Path may differ — check D2's PR for the exact handler; this spec assumes the doc-24 §9.2 recommended path.)

**Request:** JSON matching `CreateEvidencePayloadSchema`:

```ts
{
  kind: 'photo',
  photoId: string,            // from the photo POST
  photoUrl: string,           // from the photo POST
  note?: string,              // ≤ 280 chars
  stage?: 'roughIn' | 'fitOff' | null,
  areaId?: string,
  taskId?: string,
  clientCapturedAt?: string,  // ISO; client-set, metadata only
}
```

**Response 200:** the canonical persisted `EvidenceItem` (full shape per [doc 24 §5.5](24-phase-d-jobs-evidence-plan.md)).

**Errors:** 400 (validation), 401, 403 (not assigned), 404 (job missing).

**Important:** server returns the canonical row to avoid a re-fetch under Vercel Blob's read-after-write window (the [BUG-C-004 lesson](27-interface-usability-pass.md) from Phase C).

### 5.3 · `GET /api/jobs/[jobId]/evidence`

Returns `{ evidence: EvidenceItem[] }`. Server filters per role:

- Tradie → `capturedById === me.id`.
- LH (assigned) → all on this job.
- Admin → all on this job.
- Client / not-assigned → 403.

The "Today's captures" strip on Phil calls this; the server filter is the only authority. Client must **not** re-filter by `capturedById`.

---

## 6 · State machine (client)

```
        ┌─── client only ────────────────────┐  ┌── server-persisted ──────┐
        │                                    │  │                            │
draft ─► uploading ──(photo POST 200)──► pending_sync ──(evidence POST 200)──► submitted
   ▲          │                                 │
   │          │                                 │
   │          ▼                                 ▼
   │     (photo POST fail / network)       (evidence POST fail; photo retained)
   │          │                                 │
   │          ▼                                 ▼
   └────  failed_upload ◄────── (Retry button — same photoId, no re-upload) ──┘
                                                                              │
                                                                              ▼
                                                                          submitted

submitted ──(admin reviews)──► reviewed
         ──(admin rejects)───► rejected (rejectionReason inline)

rejected ──(worker recaptures via fresh sheet open)──► new EvidenceItem
           (old row preserved; never edited in place)
```

- `draft` and `uploading` are sheet-local state. Never sent to the server.
- `pending_sync` is shown while the photo upload succeeded but the evidence POST is still in flight or failed. Retry preserves the `photoId` so the photo isn't re-uploaded.
- `submitted` is the first state the server emits.
- The worker never sees `reviewed` / `rejected` change in real-time — they see it on next page open or after the parent's revalidation timer fires (no live socket in D3).

---

## 7 · UI rules (binding)

All rules live in [doc 27](27-interface-usability-pass.md); the most relevant for D3:

### 7.1 · Sheet shell

- Full-screen modal. Not a half-sheet. Not a popup.
- Sticky bottom: full-width primary "Submit" + full-width "Cancel" stacked or side-by-side at equal height.
- Header: "Capture evidence" title (left) + close X (top-right, ≥ 48×48).
- Tap-target ≥ 48×48 everywhere.
- Sunlight contrast: black-on-yellow for primary; navy-on-white for body.
- Respect safe-area-inset-bottom (per [doc 27 §19.1](27-interface-usability-pass.md) open question — confirm with Oskar before D3 ships if not already answered).

### 7.2 · Photo step

- On open: camera permission prompt fires immediately.
- Fallback button if denied or not available: "Choose from gallery".
- Preview after pick. "Retake" button visible alongside.
- Resize client-side to ≤ 1920px @ 0.7 jpeg (handled by `evidence/service.resizeImageToDataUrl`).
- Show file size below the preview: `humanFileSize(bytes)`. Reassures the worker the upload won't take forever.

### 7.3 · Target pickers (stage / area / task)

- Stage chooser: two equal-weight pills `Rough-in` / `Fit-off`. Default to whatever the worker selected on the parent detail page; if neither was selected, leave both unselected and allow capture without one.
- Area picker: vertical list of visible areas (not archived). Pre-filled from parent. Tap to choose; tap again to clear.
- Task picker: only shown when both stage + area are chosen. Lists `effectiveTasks(job, selectedArea, selectedStage)` from `@/domains/jobs/format`. **Must not** read `job.stages.roughIn[]` or `job.stages.fitOff[]` — those are legacy string arrays per the D3 warning carried from Session 4 Part 1.
- All three are optional. Capture without any of them is valid — unattached evidence is accepted server-side per [doc 24 §15.0 #5](24-phase-d-jobs-evidence-plan.md).

### 7.4 · Note input

- Single text input (not textarea — keep it small, 3 lines max). Most workers won't type more than 10 words.
- `maxLength={280}` + visible counter ("182 / 280").
- Numeric keypad **not** used (default text). Camera-shortcut not used.

### 7.5 · Submit

- Full-width, bottom edge, sticky.
- Disabled while POST in flight + during the 200ms transition after a successful return (debounce the double-tap).
- **Sheet closes on first tap** (per [doc 27 §8.3 / BUG-C-003 lesson](27-interface-usability-pass.md)). Banner lands when async settles.
- Single tap = single capture. Idempotency owned client-side (button disabled). Server doesn't dedupe (per [doc 24 D-22](24-phase-d-jobs-evidence-plan.md) accepted risk).

### 7.6 · Cancel

- Full-width grey button, same height as Submit.
- Closes the sheet without discarding state. Re-opening from the floating CTA restores the photo + note + pickers.
- An explicit "Discard draft" affordance can be a tertiary text-link below Cancel, but only if testing shows workers misuse Cancel. Default: no discard button.

### 7.7 · Pending / error states

- After Submit tap: sheet closes → "Submitting…" banner at top of detail page → either:
  - 200 → banner flips to "Captured" (success tone, decays in 1.5s) and the new item appears in the strip.
  - non-200 → banner flips to danger tone: "Couldn't save. Open the failed capture to retry." The capture lives in the strip with `failed_upload` pill + Retry button.
- If the photo POST succeeded but evidence POST failed, the row in the strip uses `pending_sync` until retry resolves.
- Retry tries evidence POST again with the same `photoId` (no second photo upload).

### 7.8 · "Today's captures" strip

- Horizontally scrollable. Each card: 48×48 thumb + small caption (time + status pill).
- Tap a card → drawer with full photo + note + target + status + rejection-reason-if-any.
- Empty state: "No captures yet today" — short copy, no illustration.
- Scope: **own captures only** (server-filtered).
- "Today" is the worker's local day — defined as midnight to midnight in Australia/Sydney (matches `BUSINESS_TIMEZONE` from `src/domains/timesheets/service.ts`).

---

## 8 · Visual markers (doc 27 §6.2)

| Marker | Tone | When | Action |
| --- | --- | --- | --- |
| `submitted` | info | server acknowledged | Worker: wait. Admin: review. |
| `reviewed` | success | admin marked reviewed | Worker: done. |
| `rejected` | danger | admin rejected | Worker: read reason + recapture. |
| `pending sync` | info | photo uploaded, evidence POST in flight or failed | Worker: hold position; will retry. |
| `failed upload` | danger | retry failed | Worker: tap Retry. |

**No new tones, no new labels.** If a workflow demands one, file an ADR before D3 ships.

---

## 9 · Empty / loading / error / pending

Per [doc 27 §12](27-interface-usability-pass.md), every async surface has all four:

| State | Strip | Sheet |
| --- | --- | --- |
| Loading | Skeleton 3 cards | n/a (sheet only opens on tap) |
| Empty | "No captures yet today" | Camera prompt |
| Error | Banner: "Couldn't load captures. Retry." | Inline error above Submit + Retry preserves draft |
| Ready | Cards | Photo + pickers + note |
| Submitted (1.5s decay) | "Captured" pill on the new card | Sheet closed |
| Pending sync | `pending_sync` pill on the card | n/a (worker is back on detail) |
| Failed upload | `failed_upload` pill on the card + Retry CTA | n/a |

---

## 10 · Validation rules (client-side mirror of D2 server rules)

- `note.length ≤ 280` — submit blocked at 281.
- `kind === 'photo'` requires a selected photo file. Submit disabled until photo picked.
- `taskId` requires `stage` AND `areaId` both set. If task is selected and either is cleared, task clears too.
- `stage`, `areaId`, `taskId` all use the canonical job structure IDs from `roughInTasks` / `fitOffTasks` / `areaGroups[].areas[]` — **never** `stages.roughIn` strings.
- Photo file size > 6 MB → reject before POST (the resize step shouldn't produce > 6 MB; failsafe).
- Network offline (`navigator.onLine === false`) → Submit still enabled (the POST will queue in the browser network stack); banner at top of sheet: "Offline — will sync when you're back".

Server is the authority — these client rules exist for UX, not security.

---

## 11 · Acceptance criteria

Phase D3 is shipped when **all** of:

- [ ] Floating CTA "Capture evidence" replaces the `UnderConstructionPanel` on `/phil/jobs/[jobId]`.
- [ ] Sheet opens, photo picks, note entered, submit fires both POSTs, sheet closes, new card appears in the strip with `submitted` pill.
- [ ] Retry on a `failed_upload` row reuses the same `photoId`.
- [ ] Cancel preserves draft state; reopening restores photo + note + pickers.
- [ ] Strip shows own captures only (verified by logging in as a second worker on the same job — admin can verify by checking with two test accounts).
- [ ] Admin queue (D4) sees the new evidence within 5 seconds (post-D4).
- [ ] Submit button disabled while in flight; double-tap produces exactly one row.
- [ ] DemoModeBanner is **OFF** on `/phil/jobs/[jobId]` for evidence — the data is real.
- [ ] All client components live in `src/components/phil/`; [doc 26 §A.1](26-phase-d-testing-checklist.md) grep is empty.
- [ ] Vitest + Playwright tests per [doc 28 §B.9](28-d2-d3-d4-evidence-qa-checklist.md).
- [ ] iOS Safari + Android Chrome + desktop Chrome smoke passes.
- [ ] Phase B / C / D1 / D2 regression passes (per [doc 28 §D](28-d2-d3-d4-evidence-qa-checklist.md)).
- [ ] Phase D1 routes (`/phil/jobs`, `/phil/jobs/[jobId]`) still render.

---

## 12 · Risks

| ID | Risk | Mitigation |
| --- | --- | --- |
| D3-1 | Camera permission denied → worker has no fallback | Gallery `<input type=file>` always present, labelled "Choose from gallery". |
| D3-2 | Photo > 6 MB after resize on some Android cameras | Cap dimensions at 1920px **and** quality at 0.7. If still > 6 MB, drop quality to 0.5 with one retry. Failsafe rejection client-side. |
| D3-3 | Double-tap submits two evidence rows | Button disabled on first tap; sheet closes on first tap; debounced 200ms. Server doesn't dedupe (accepted per [doc 24 D-22](24-phase-d-jobs-evidence-plan.md)). |
| D3-4 | Worker thinks the orange `pending_sync` pill is permanent | Auto-retry every N seconds while the sheet is open; if sheet closed, Retry button on the strip card. |
| D3-5 | iOS sheet clipped by home indicator | `safe-area-inset-bottom` on the sheet's sticky footer. Confirm with Oskar in the open-question gate. |
| D3-6 | Worker captures against the wrong area | Visible area name in the sheet header + a "Change area" affordance one tap away. Confirmation only on submit, not on every picker change (per [doc 27 §5.5 anti-confirmation rule](27-interface-usability-pass.md)). |
| D3-7 | Sheet stays open after submit (BUG-C-003 regression) | Sheet closes on first tap of Submit (per [doc 27 §8.3](27-interface-usability-pass.md)). Banner lands when async settles. Unit test enforces. |
| D3-8 | RSC manifest regression — `CaptureSheet.tsx` accidentally placed in `src/app/phil/jobs/[jobId]/` | [Doc 26 §A.1 grep](26-phase-d-testing-checklist.md) enforces. Pre-merge gate. |
| D3-9 | Task ID picker accidentally reads `job.stages.roughIn[]` (legacy strings, no IDs) | Spec calls this out explicitly. Code review must verify the picker reads `effectiveTasks(...)` only. Carries the Session 4 Part 1 D3 warning forward. |

---

## 13 · Build prompt — paste into Session 6

```
You are Claude Code working as the Phase D · D3 build session for BuhlOS / Phil.

This session builds the Phil evidence capture UI on top of D2's evidence
domain + persistence API (which must be merged on main before this session
opens).

Read first (in order):
  docs/rebuild-audit/27-interface-usability-pass.md   ← UI binding rules
  docs/rebuild-audit/29-phase-d3-phil-capture-spec.md ← this spec
  docs/rebuild-audit/28-d2-d3-d4-evidence-qa-checklist.md §B  ← QA gate
  docs/rebuild-audit/24-phase-d-jobs-evidence-plan.md §5.5 + §7 + §8
  docs/rebuild-audit/26-phase-d-testing-checklist.md §A.1 + §B.2
  src/components/phil/PhilJobDetail.tsx               ← current D1 detail
  src/domains/jobs/format.ts                          ← effectiveTasks
  src/domains/evidence/*                              ← D2 domain
  api/photos.js                                       ← upload-evidence-photo branch
  src/app/api/jobs/[jobId]/evidence/route.ts          ← D2 persistence handler
                                                         (path may differ — confirm
                                                          from D2's merged PR)

Branch:    phase-d-d3-phil-capture        (from latest origin/main, AFTER D2 merge)
PR title:  Phase D3 · Phil evidence capture UI

============================================================
SCOPE
============================================================

You MAY add (this PR only):

  src/components/phil/CaptureSheet.tsx
  src/components/phil/CapturePhotoPicker.tsx
  src/components/phil/CaptureTargetPickers.tsx
  src/components/phil/TodaysCapturesStrip.tsx
  src/components/phil/EvidenceDrawer.tsx
  src/components/phil/CaptureSheet.test.tsx
  src/components/phil/TodaysCapturesStrip.test.tsx
  tests/phase-d-d3-capture.spec.ts

You MAY edit (minimally):

  src/components/phil/PhilJobDetail.tsx
    - replace the "Capture evidence" UnderConstructionPanel with the
      floating CTA + sheet trigger.
    - add <TodaysCapturesStrip /> below the area picker.

  src/app/phil/jobs/[jobId]/page.tsx
    - server-side fetch the worker's today-captures list (GET evidence)
      and pass to <PhilJobDetail /> as a prop.
    - NO "use client" added.
    - NO new files created in this directory.

You MUST NOT:

  - add api/*.js changes               (D2 owns the API)
  - add src/domains/evidence/* changes (D2 owns the domain)
  - add src/app/api/* changes          (D2 owns the persistence route)
  - add admin review UI                (D4 owns this)
  - add a /phil/jobs/[jobId]/capture route — sheet is in-page only
  - add a new component co-located under src/app/phil/jobs/[jobId]/
  - add an offline sync engine          (Phase F+)
  - add evidence editing                (workers recapture, not edit)
  - add multi-photo capture             (one photo per submit)
  - add bulk capture / multi-area dispatch
  - touch vercel.json
  - touch public/*.html
  - touch src/app/(admin)/*
  - touch src/components/admin/*
  - merge this PR yourself

Hard rules (binding):

  - All capture client components live in src/components/phil/.
  - All marker strings + tones come from doc 27 §6.2 dictionary.
    No new tones, no new labels.
  - Task IDs come from effectiveTasks(job, area, stage) — never
    job.stages.roughIn[]/fitOff[] (legacy strings).
  - Sheet closes on first tap of Submit (BUG-C-003 lesson, doc 27 §8.3).
  - Submit button disabled while in flight; debounce 200ms post-success.
  - DemoModeBanner OFF on /phil/jobs/[jobId] — data is real.
  - No alert() / confirm() / prompt() anywhere in the flow.

Before writing code:
  - re-read PhilJobDetail.tsx in full — the sheet's prop edge starts here.
  - re-read api/photos.js to confirm the upload-evidence-photo action's
    exact response shape (D2 may have shifted it).
  - re-read src/domains/evidence/client.ts to confirm the create() and
    list() method names.
  - re-read doc 26 §A.1 grep — pre-flight your file layout.

Checks before opening the PR:
  npm run typecheck
  npm run lint
  npm run test                 (includes new CaptureSheet + Strip tests)
  npm run build
  npm run check:admin-shell
  npm run check:sw-cache-version
  npm run check:production-shell
  npm run smoke:admin-routes
  npm run test:e2e             (includes new phase-d-d3-capture.spec.ts)
  git diff --stat              (only src/components/phil/* +
                                src/components/phil/*.test.tsx +
                                tests/phase-d-d3-capture.spec.ts +
                                src/components/phil/PhilJobDetail.tsx (edit) +
                                src/app/phil/jobs/[jobId]/page.tsx (edit) +
                                NO api/, NO src/domains/, NO vercel.json,
                                NO public/, NO src/components/admin/)

Doc 28 §B QA checklist must be pasted into the PR body and ticked.

Authenticated preview smoke (run before requesting review):
  - Log in as Phil tradie with the dev credentials.
  - Open /phil/jobs/birdwood-iv3232.
  - Tap Capture evidence.
  - Walk a real capture (photo + note + stage + area + task).
  - Confirm Today's captures shows the new card with `submitted` pill.
  - Tap the card → drawer renders.
  - Kill wifi mid-submit → row enters `pending_sync` → restore → Retry → resolves.

PR body must include:
  - confirmation of the doc 28 §B checklist
  - confirmation no api/, no domain, no admin changes
  - explicit before/after note about the UC panel removal
  - explicit "DemoModeBanner OFF" note for evidence
  - preview smoke screenshot (if practical) or a brief written walk

Final report: as previous Dx sessions, plus the authed preview smoke
table.
```

---

## 14 · Cross-references

- [24-phase-d-jobs-evidence-plan.md](24-phase-d-jobs-evidence-plan.md) — binding scope, data model, state machine.
- [27-interface-usability-pass.md](27-interface-usability-pass.md) — UI rules + §6.2 markers + §8.6 capture screen critique.
- [28-d2-d3-d4-evidence-qa-checklist.md](28-d2-d3-d4-evidence-qa-checklist.md) — D3 QA gate (§B).
- [30-phase-d4-admin-evidence-review-spec.md](30-phase-d4-admin-evidence-review-spec.md) — admin counterpart; D3 + D4 close the loop.
- [src/components/phil/PhilJobDetail.tsx](../../src/components/phil/PhilJobDetail.tsx) — D1's current detail page; the floating CTA replaces the UC panel here.
- [src/domains/jobs/format.ts](../../src/domains/jobs/format.ts) — `effectiveTasks` (canonical task resolver, NOT `stages` strings).

---

## Document status

| Field | Value |
| --- | --- |
| Document | `docs/rebuild-audit/29-phase-d3-phil-capture-spec.md` |
| Author | Session 4 (non-interference QA / UX planning agent) |
| Branch | `session-4-qa-ux-planning` |
| Status | **Docs-only. Planning artefact.** No app code implied. |
| Phase precondition | D1 shipped (PR #11). D2 must be merged before D3 starts. |
| Next action | After D2 ships, Session 6 pastes the §13 build prompt and follows. |
