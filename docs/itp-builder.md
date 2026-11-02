# ITP builder (Phil) — photos by area, made into a PDF

*Flag: `itp_simple` (launch-gate, default OFF). Routes:
`/phil/jobs/[jobId]/itp-reports` (list) and
`/phil/jobs/[jobId]/itp-reports/[reportId]` (builder). API: `api/itp-simple.js`.
Design source of truth: the ITP builder design canvas (boards 1–13); this
page records what was built from the 2026-11-02 developer handoff.*

## What it is

A worker photographs a job **area by area without typing**, and nothing they
take is lost silently. They then make one or more plain PDFs and send them to
the office, by email, or save them to the phone. No templates, checklists,
pass/fail, hold points, signatures, reviewer assignment, admin approval,
analytics, offline queue, reordering or moving photos between areas — the
heavy office ITP system (`itp` flag) stays hidden and separate.

Constitution: P5 (capture before structure — "Just take photos", names
later), P7 (every tile and badge says only what the app knows), P8 (nothing
locks; failures are shown, never hidden), P9/P10 (PDF state lives in the dock,
no new tabs or job-screen sections), P11 (site words: no *submit*, *upload*,
*sync*, *delivered*), P12 (remove arms first and names what goes).

## Screens

- **List** — intro "ITPs — Photos by area, made into a PDF.", cards newest
  first (title · "n areas · n photos" · one badge), dock **Start an ITP**
  ("Named with today's date. Rename any time."). One tap creates
  `ITP · {Ddd D Mon}` in the device timezone and opens the builder.
  Badge priority: any PDF out of date › last send › last made › No PDF yet.
- **Builder** — title (pencil → ITP sheet), area cards in capture order,
  each with its own **Photos** button (camera) and a 3-column tile grid.
  Empty report: "Where are you?" (Camera / Camera roll · Recent names ·
  Something else + dictate) and the dock's **Just take photos** / *or pick
  from camera roll*. Mid-walk the dock shows the PDF badge + **Make the PDF**
  / **PDFs · n**, and **New area**.
- **Sheets** (one at a time, over a scrim; Close / scrim / swipe / back
  gesture / Escape dismiss; dismissing disarms): New area · Area (add from
  camera roll, rename, remove) · Photo (caption, remove) · This ITP (rename,
  Sent list, delete) · Make a PDF (tick areas, name follows the ticks) ·
  PDFs · n (Open, Send, Make again, rename via the name) · Rename PDF ·
  Send this ITP (office / Email it / Save to phone) · Leave guard.
- **Walkthrough** — four steps, shown once per person when the ITP list
  opens (never on the builder); again from the account screen's Help card
  ("How ITPs work"). Skip / Got it set the flag locally at once and sync it
  when online; if the list can't load, it isn't shown and is tried next time.

## Uploads (the honesty rules)

- Pending photos live in a client queue **outside** the refetched report
  (`src/domains/itp-simple/upload-queue.ts`) and are merged into the render,
  so a refetch can never drop a tile.
- One at a time, in the order taken; nothing locks the screen. The dock
  reads "Saving 1 of 3".
- Over 8 MB is caught on the phone → "Over 8 MB · Not added" + Clear, never
  sent. Photos are downscaled (max 2048px JPEG) before upload so the request
  stays under the serverless body cap on 4G.
- The response decides the tile: fetch threw / offline → **Not sent**
  (amber) + the sync banner ("No signal. 3 photos are still on this phone —
  keep this screen open.") + Retry all in the dock; a non-2xx → **Didn't
  save** (red) with Retry on the tile.
- Leave guard on back / any in-app link / page unload while anything is
  Waiting, Saving, Not sent or Didn't save. A closed tab or killed app can't
  be caught — the honest limit without an offline queue.
- An area tapped into existence shows at once; its tiles wait for the server
  id. If the area creation fails, the tiles read Didn't save and Retry
  re-creates it.

## PDFs and sending

- **Several PDFs per ITP** (`itp_simple_pdfs`): each has its areas, a name
  ("All areas" or the ticked names until typed over), a snapshot of what it
  printed and a content fingerprint. **Out of date** = the live fingerprint of
  *its own* areas differs (photos added, removed or re-captioned); renaming
  an area or the PDF never makes it stale.
- **Make again** keeps the areas and name and replaces the file (the open
  "keep both?" decision is drawn as replacing). **Rename** re-renders the
  header and file name from the snapshot, so the photo pages don't change.
- One PDF holds 120 photos; the cap applies per PDF, the ITP itself has no
  cap. From 100 photos the dock counts towards it.
- **Send** (`?action=send`): a stale PDF is made again first. Sent from
  `BuhlOS Reports <reports@buhlos.com>` (`ITP_EMAIL_FROM` overrides; SPF +
  DKIM on buhlos.com are an ops task), reply-to = the office address, subject
  `{PDF name} — {job address}`, the optional note, "n areas · n photos ·
  made {date}", the PDF attached — or a download link above 20 MB, and the
  email says so. Every send is logged (`itp_simple_sends`, failures too) and
  feeds the Sent list, the badges and the "Used on this job" chips.
  **"Sent" means the mail service accepted it — never delivered or read.**
- **Office address**: the `itp_simple.officeEmail` feature setting (Owner
  Console). Blank → "Send to office" is hidden; Email it and Save remain.
- **Save PDF to phone**: `navigator.share({ files })` where supported, else a
  download.

## Backend

| Piece | Where |
| --- | --- |
| Tables | `supabase/migrations/20260718100000_itp_simple_reports.sql` (reports, areas, photos) + `20261102100000_itp_simple_pdfs_and_sends.sql` (pdfs, sends, per-person prefs) |
| Store | `api/_lib/itp-simple-store.js` |
| Pure helpers | `api/_lib/itp-simple-model.js` (fingerprint, default name, snapshot), `api/_lib/itp-simple-pdf.js` (composer), `api/_lib/itp-simple-email.js` (message) |
| Handler | `api/itp-simple.js` — the action table is in its header comment |
| Client contract | `src/domains/itp-simple/schema.ts`, `model.ts`, `upload-queue.ts` |
| UI | `src/components/phil/itp/` |

Binaries (photos, PDFs) stay in Vercel Blob under `jobs/<jobId>/itp-simple/`.
The legacy `pdf_url` / `pdf_generated_at` on the report are still stamped with
the latest PDF.

## Open decisions (from the handoff — not built either way)

- Replies to reports@buhlos.com go to the office (built) or the worker?
- Email it: any address (built), or only addresses saved on the job/client?
- Make again: replace the file (built) or keep both?
- Should the office copy also attach to the job in BuhlOS?
- Office address not set: hide Send to office (built) or show a hint?
- Company logo on the PDF header — none is stored, so the header has no logo.

## Field test

The handoff's six claims (Q1–Q6: camera-roll picks belong to the job, names
come from chips, failed photos get noticed, placeholder names get fixed,
remove is found by tapping the photo, gloved thumbs hit the dock) each fall
in a day on site; fallbacks are listed in the handoff. Record outcomes per
`docs/phil-field-validation.md`.
