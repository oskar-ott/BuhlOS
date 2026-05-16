# Phil Photo Feature — Manual Test Checklist

Run these tests against the deployed environment after every release that touches
photos, Phil, or `/api/photos`. Test on a real phone (iOS Safari + Android Chrome)
plus a desktop browser with DevTools mobile emulation for offline simulation.

## Pre-flight

- [ ] Sign in as a **tradie** assigned to **exactly one active job**.
- [ ] Sign in as a **tradie** assigned to **two or more active jobs** in a
      second browser/profile.
- [ ] Sign in as a **tradie with zero jobs assigned**.
- [ ] Sign in as an **admin** for the admin app (`/admin` or `/jobs/<jobId>`).

## 1. Photo from Today screen — single job

- [ ] Open Phil. Today screen shows the assigned job, not a Sydney mock job.
- [ ] Tap **📷 Photo** quick action.
- [ ] The capture sheet shows the job pre-selected (no job dropdown visible).
- [ ] Pick a category, take or upload a photo, submit.
- [ ] Upload-queue snack appears, then says "✓ N photo uploaded".
- [ ] Open Job → Gallery → the new photo appears.

## 2. Photo from Today — multiple jobs

- [ ] Tap **📷 Photo** from Today (no job context).
- [ ] Sheet shows a **Job** dropdown listing only the worker's active jobs.
- [ ] Submit without picking a job → toast: "Select a job first".
- [ ] Pick a job → submit → upload succeeds and is filed under that job.

## 3. Photo with no jobs loaded

- [ ] Sign in as a tradie with zero assigned jobs.
- [ ] Tap **📷 Photo** → toast: "No active jobs assigned" — sheet does not open.

## 4. Photo with jobs request failing

- [ ] In DevTools, block `/api/jobs` (returns 500).
- [ ] Reload Phil. Tap **📷 Photo** → toast: "Load jobs before uploading photos"
      OR "No active jobs assigned" (depending on whether the cached value is null/empty).
- [ ] The capture sheet does NOT open.

## 5. Photo from Job home

- [ ] Open a real job from the Jobs tab. Tap **📷 Photo**.
- [ ] Capture sheet shows that job's name in the context line.
- [ ] Submit → photo is stored against that job id (verify in admin).

## 6. Photo from Dwellings (Site Office model)

- [ ] Inside a job, tap **Dwellings**.
- [ ] List shows the real dwellings stored in `jobs/<jobId>/data.json`.
- [ ] Tap a dwelling → capture sheet opens with that dwelling pre-filled in area
      + `dwelling` metadata.
- [ ] Submit → photo record has `dwelling = "<dwelling name>"`.

## 7. Gallery filter

- [ ] Open Job → Gallery. Verify only the current job's photos show up.
- [ ] Tap category chips — counts update, filter applies.
- [ ] Tap a photo → full-screen viewer opens with category, notes, uploader,
      timestamp.

## 8. Admin ITP upload

- [ ] Open `/jobs/<jobId>` admin. Open a dwelling → ITP Photos tab.
- [ ] Upload a photo with a Rough-In stage.
- [ ] Photo appears in the Rough-In group with thumbnail.
- [ ] DELETE works.

## 9. Phil / Admin shared visibility

- [ ] Worker uploads a photo from Phil with `dwelling = "Unit 3"` and
      `category = 'itp'`.
- [ ] In admin, open Unit 3 → ITP Photos tab → photo is visible.
- [ ] Worker uploads a photo from Phil with just `area = "Level 3"` (no dwelling).
- [ ] In admin per-dwelling view: photo is **NOT** visible (admin filters by
      dwelling). This is a **known gap** — see `Remaining rollout blockers` in
      the photo rebuild report.
- [ ] Admin uploads ITP photo for Unit 1 with stage "AC Rough-In".
- [ ] In Phil → open the job → Gallery → photo is visible (category: ITP, area:
      Unit 1).

## 10. Delete permissions

- [ ] Worker A uploads a photo. Worker A opens the viewer → 🗑 button visible →
      delete succeeds.
- [ ] Worker B (different tradie, same job) opens that photo → 🗑 button **not**
      visible. Direct DELETE against the API returns 403.
- [ ] Admin can delete any photo on any job they have access to.

## 11. Failed upload retry

- [ ] Throttle network to "Offline" in DevTools, then submit a photo.
- [ ] Upload-queue snack shows "Upload failed. Retry before closing Phil — N
      photo not saved."
- [ ] Re-enable network. Tap **Retry**. Snack shows "Uploading…" then "✓
      uploaded".
- [ ] While in failed state, try to navigate away or refresh →
      `beforeunload` warning appears: "You have unsaved photos…"

## 12. Memory-only queue limitation

- [ ] Submit a photo while offline. Snack shows failed.
- [ ] **Close the Phil tab**. Reopen Phil — the failed photo is **gone**.
- [ ] Confirm the snack message warned about this before closing.

## 13. Large photo compression

- [ ] Upload a ~20 MP photo from a real phone.
- [ ] Network tab confirms the request body is well under 8 MB (compressed to
      ≤ 1600 px, ~ q0.82 JPEG).
- [ ] Thumbnail in gallery is the small thumb URL, not the full image.

## 14. Mobile camera capture

- [ ] On iOS Safari: tap **Take Photo** → native camera opens (not gallery).
- [ ] On Android Chrome: same.
- [ ] After capture, preview thumbnail appears in the strip within ~1 second.

## 15. Multi-photo upload

- [ ] Tap **From Gallery** → select 5 photos.
- [ ] All 5 appear in the strip with thumbnails.
- [ ] Submit button reads "Submit 5 photos".
- [ ] Submit → all 5 upload sequentially. Snack reports "5 uploaded".

## 16. Category persistence

- [ ] Pick the "Defect" category, take a photo, submit.
- [ ] Open Job → Gallery → photo has a red **DEFECT** badge.
- [ ] Filter by Defect → only this photo shows.

## 17. Hardening / API rejections

Tests for `api/photos.js` via curl or DevTools:

- [ ] `POST /api/photos?jobId=fake-job-id` as a tradie → 403 (no access).
- [ ] `POST` with no body → 400 "data required".
- [ ] `POST` with non-image bytes (e.g. base64 of "hello") → 415 "not a
      recognised image".
- [ ] `POST` with an image > 8 MB → 413.
- [ ] `POST` with `category: "not-real"` → silently coerced to `progress`
      (acceptable; server-side default).
- [ ] `DELETE /api/photos?jobId=X&id=Y` as a tradie who isn't the uploader and
      isn't admin → 403.
- [ ] `GET /api/photos?jobId=X` as an unauthenticated user → 401.

## 18. Hours / snags honesty (not photo, but in this audit)

- [ ] Save hours from Phil → entry persists in `jobs/<jobId>/hours.json` and
      survives a page reload.
- [ ] Submit a snag from Phil → snag appears in admin → Snags tab.
- [ ] Sign-out + sign-in does NOT show any "Demo User" persona on network error.
      Instead, a "Can't reach Phil" screen with a Retry button.

---

**Known limitations (documented, not bugs):**

- Phil has no per-day-task model yet. Today screen shows assigned jobs, not
  tasks. Photos cannot be attached to a specific task.
- Failed-upload retry queue is **in-memory only**. Closing the tab loses
  pending photos. UX warns the worker.
- Admin per-dwelling ITP gallery only shows photos with a matching `dwelling`
  field. A job-wide admin gallery is not yet built.
- HEIC photos are accepted by the API but the browser may not preview them
  before upload on Android. Recommend workers set their camera to JPEG.
