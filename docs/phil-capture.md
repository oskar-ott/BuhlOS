# Phil Capture (photo / evidence) — shipped-state reference

> **Purpose:** an honest description of the Phil field-worker **Capture**
> feature as it actually exists on `main` — what is real, what is intentionally
> not connected, the metadata it records, and how it is tested. Written so a
> reviewer or operator can tell a built feature from a placeholder without
> reading the source.

| | |
| --- | --- |
| **Feature** | Phil photo/evidence Capture ("the shutter") |
| **Status** | `MERGED` / shipped (Phase D2–D5). This doc + the entry-point tests below add coverage and documentation only — they do **not** change capture behaviour. |
| **Surfaces** | Phil (mobile/field). Admin review is a separate surface (`/v2/jobs/[jobId]/evidence`). |
| **Re-verify** | `main` moves fast. Confirm with `git log` + the tests in [§ Tests](#tests) before relying on a line here. |

Capture is **real**: a field worker takes a photo, it is uploaded to Vercel
Blob, and an evidence record with full job context + worker identity is
persisted server-side. The UI **never** shows "saved" unless the server
confirmed the write. There is **no faked persistence anywhere** in this path.

---

## 1 · Entry points

Capture is reachable in one or two taps from anywhere in Phil:

| Entry | Where | Behaviour |
| --- | --- | --- |
| **Capture FAB** | Centre of the bottom nav (`PhilTabBar`), every Phil screen. `aria-label="Capture"`. | Opens the global **capture launcher**. On a job home it already knows the job (skips the picker); elsewhere it asks which job. |
| **On-page CTA** | "Capture evidence" button in the job detail capture block (`#phil-job-capture`). | Opens the evidence **capture sheet** directly for that job. |
| **Deep link** | `/phil/jobs/<id>?capture=<token>` | The launcher's "Take a photo / evidence" option routes here; the job page auto-opens the sheet (`autoCaptureToken`). A fresh token re-opens it on a repeat launch. |

The launcher (`PhilCaptureLauncher`) also offers plain-English **observation
logging** (note / blocker / need material / question / etc. → `POST
/api/observations`); that is a separate loop and is out of scope for this doc.

---

## 2 · The capture flow (photo / evidence)

`CapturePhotoPicker` → `CaptureSheet` → two-step upload:

1. **Pick** — native `<input type="file" accept="image/*" capture="environment">`.
   Camera opens by default; gallery is the automatic fallback. Preview +
   "Retake" + file-size shown.
2. **Resize** — client-side `resizeImageToDataUrl(file, 1920, 0.7)` (~300–700 KB
   target) so the upload is fast on a site connection.
3. **Upload photo** — `POST /api/photos?action=upload-evidence-photo` writes the
   binary to **Vercel Blob** and returns `{ id, url, capturedAt }`.
4. **Create evidence** — `POST /api/evidence?jobId=<id>` writes the metadata row
   to `jobs/<id>/data.json` (referencing the uploaded photo), and returns the
   canonical item (no read-after-write lag).

Two steps are intentional: the binary must land before the metadata row
references it.

### Honest states

`ready → uploading → pending_sync → (success) | failed`

- The sheet **closes on first tap** of Submit; the result lands as a banner on
  the job page (success **or** failure with the message).
- **Failure is shown, success is not faked.** A "saved" banner only appears
  after `createEvidence` returns `ok`. A failed photo upload or failed evidence
  write surfaces an error; the worker can retry.
- `uploading` and `pending_sync` are **client-only** states — the server never
  persists them. **There is no offline queue:** capture needs a live
  connection. The UI does not pretend otherwise.

---

## 3 · Metadata recorded

The server (`api/evidence.js`) sets identity + timestamps from the session; the
client supplies context. Mapped against the candidate field list:

| Field | Source | Real? |
| --- | --- | --- |
| `id` (`ev_…`) | server | ✅ |
| `jobId` | client/route | ✅ |
| `kind` (`photo`/`note`) | client | ✅ |
| `photoId`, `photoUrl` | photo upload | ✅ (Blob) |
| `note` (≤ 280) | client | ✅ optional |
| `stage` (`roughIn`/`fitOff`), `areaId`, `taskId` | client pickers (validated against the job) | ✅ optional |
| `capturedById` / `capturedByName` / `capturedByRole` | **server, from session** | ✅ worker identity |
| `capturedAt` | server | ✅ |
| `clientCapturedAt` | client | ✅ (offline-reconciliation hook) |
| `source` (`phil`/`admin`/`system`) | server (role-derived) | ✅ `phil` for field |
| `status` | server (`submitted` on create) | ✅ |
| `auditLogIds` | server (dual audit-write) | ✅ |
| `createdAt` / `updatedAt` | server | ✅ |
| `thumbnailUrl` | — | ⛔ schema-supported, **not generated** by the current sheet |
| `exifLocation` | — | ⛔ schema/API-supported, **not captured/sent** by the current sheet (client resize re-encodes the image) |

The Phil worker never sees raw field names or the observation type taxonomy —
only plain labels.

---

## 4 · Permissions (enforced server-side)

| Caller | GET (list) | POST (create) | Review |
| --- | --- | --- | --- |
| Unauthenticated | 401 | 401 | — |
| `client` role | 403 | 403 | — |
| `tradie` (field) | own captures only | assigned jobs only (`canWrite`) | — |
| LH / admin | all on job | per role | admin only |

A worker opening a job they're not assigned to gets a friendly "not assigned to
you" card, not a save path.

---

## 5 · What is NOT built (capture scope)

Deliberately out of scope — do not mistake these for shipped:

- **Offline capture / background sync.** `pending_sync` is a UI state, not a
  queue. No connection → no capture.
- **In-app photo edit / annotation / markup.** Recapture replaces; there is no
  drawing or measure.
- **Thumbnails / EXIF location.** Schema/API support them; the current sheet
  does not produce them.
- **Worker-side gallery management** beyond the job's "Today's captures" strip
  (own captures). No multi-select, delete, or bulk actions for the worker.
- **AI / OCR / takeoff / material counting** on captures.

Admin-side review (mark reviewed / reject + reason / un-review, history) **is**
built (D4/D5) at `/v2/jobs/[jobId]/evidence`.

---

## 6 · Tests

**Normal CI (every PR, no browser, no secrets, no data):**

- `philCapture.test.ts` — launcher decision logic (`launchableJobs`,
  `launcherDecision`, `captureHref`, `philJobDetailId`, `buildObservationPayload`).
- `evidence.test.ts` — schema, the `canTransition` state machine, format
  helpers, and every client wrapper incl. `uploadEvidencePhoto` error paths
  (mocked Blob).
- `PhilCaptureLauncher.render.test.tsx` — launcher chooser SSR.
- **`PhilTabBar.render.test.tsx`** *(added with this doc)* — locks the global
  **Capture FAB** as a named button, the four field tabs + hrefs, and that the
  launcher stays closed until tapped. This is the one capture affordance that
  previously had no automated guard.
- `npm run check:smoke-list` — proves the smoke specs (incl. `phil.spec.ts`)
  compile/discover.

**Credentialed Preview Smoke (manual `workflow_dispatch` only — never in normal CI):**

- `tests/playwright/smoke/phil.spec.ts` proves, in a real mobile browser, that
  the field worker can:
  - open the **global Capture launcher** from the bottom-nav FAB *(added)*; and
  - open the **on-page capture sheet** with the job's context *(added)*.
  - Both are **non-mutating**: they open and close the launcher/sheet (a
    read-only `GET /api/jobs` at most) and **never upload a photo or write
    evidence**, so Preview Smoke leaves the (possibly production-shared) Blob
    untouched. A real end-to-end capture-persistence run is intentionally left
    to a supervised manual session.

---

## 7 · Cross-references

- Spec / plan: [rebuild-audit/29-phase-d3-phil-capture-spec.md](./rebuild-audit/29-phase-d3-phil-capture-spec.md),
  [rebuild-audit/24-phase-d-jobs-evidence-plan.md](./rebuild-audit/24-phase-d-jobs-evidence-plan.md),
  [rebuild-audit/28-d2-d3-d4-evidence-qa-checklist.md](./rebuild-audit/28-d2-d3-d4-evidence-qa-checklist.md)
- Field readiness: [field-readiness/ROLL_OUT_STATUS.md](./field-readiness/ROLL_OUT_STATUS.md),
  [field-readiness/KNOWN_LIMITATIONS.md](./field-readiness/KNOWN_LIMITATIONS.md)
- Code: `src/components/phil/PhilTabBar.tsx`, `PhilCaptureLauncher.tsx`,
  `CaptureSheet.tsx`, `CapturePhotoPicker.tsx`, `src/domains/evidence/*`,
  `api/evidence.js`, `api/photos.js`, `api/_lib/blob.js`
