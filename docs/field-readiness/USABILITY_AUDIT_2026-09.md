# Usability audit + fixes — Phil (field) and BuhlOS (office), 2026-09-23

**Status:** audit done; a bounded fix set is in the PR that adds this file.
**Scope:** the live lean core only (docs/product/02-lean-reset.md): hours → approvals → hand-off,
basic jobs, photos, tag register, simple ITP, plus login/nav. Nothing hidden was un-hidden, no flag
or production configuration was changed.
**Pull served (03-lean-startup-loop.md):** owner request for a usability pass on the core loops —
a fix pass on shipped behaviour, no new feature.

## 1 · What is actually live (read 2026-09-23, not assumed)

Production flags = code default → `FLAG_*` env → `flags.json` override. Read directly (values,
read-only) from the production env and the `flags.json` blob:

| Flag | Prod | Effect on what users see |
| --- | --- | --- |
| jobs, hours, evidence, employees, gear, job_photos | ON (kill-switch defaults) | lean core |
| phil_sharpened | ON (env) | 5-slot Phil bar Today · Jobs · Capture · Hours · Gear; logging lives on the Hours tab |
| phil_job_rooms | ON (env) | **drove a dead in-job bar — see F1** |
| xero_connection, xero_payroll_export | ON (flags.json) | Xero batch panel on /hours/period |
| itp_simple, signup_link, job_materials_spend | ON (flags.json) | simple ITP link on the job, crew link, office materials ledger |
| invoice_capture | OFF | nothing |
| Timesheet email recipients | set since the 2026-08-16 rollout (not re-read for this audit) | "Send to Tia" on desktop period page + phone closeout |
| Push (VAPID) | **not configured** | every push silently no-ops — so UI copy may not promise one |

Uncertain, not verifiable from here: whether a real Xero organisation is connected in production
(the batch panel shows "not connected" or the batch flow depending on it).

## 2 · Workflow map (roles × device)

| Route | Who | Device | State |
| --- | --- | --- | --- |
| /phil/my-day (Today) | field, LH | phone | live — greeting, "Log hours now" banner, Do-this-now, quick tiles |
| /phil/jobs, /phil/jobs/[id] | field, LH | phone | live — all active jobs visible to everyone (#907); + New job |
| /phil/hours | field, LH | phone | live — THE log form (day dial, job dial, standard / custom / split), week history, Change/Fix |
| /phil/jobs/[id]/photos, /tags, /itp-reports | field, LH | phone | live |
| /phil/gear | field, LH | phone | placeholder "Gear — coming soon" (deliberate, #946) |
| /command-centre | admin | desktop + phone (MobileToday) | live |
| /hours/weekly | admin | desktop board / phone approval flow + closeout → Send or Xero finale | live |
| /hours/approvals | admin | desktop (phone: no tab links to it) | live |
| /hours/period | admin | desktop | live — downloads + Send to Tia + Xero batch panel |
| /v2/jobs, /v2/jobs/[id], /v2/jobs/new | admin | desktop + phone | live |

## 3 · Method and evidence

- Code maps of both surfaces (read-only), then a **real browser walkthrough** on a fully isolated
  local runtime: `vercel dev` (runs `api/*.js`) against a **local mock of the Blob API** (the real
  Blob store is shared with production, so it was never touched), synthetic users/jobs created
  through the app's own APIs, sessions minted for field (tradie, LH) and admin roles, production
  flag values mirrored. Phone = 375×812, desktop = 1280–1366 wide.
- Failure paths were forced by stopping the storage server mid-action.
- Limits: local runs were Blob-only (production reads hours from Postgres behind
  `supabase_read_hours`); no Xero org, no email provider (sends 503 locally — nothing was emailed);
  no real device, gloves, sunlight or bad signal. **Field evidence is still owed (§7).**

## 4 · Ranked findings

P0 = blocks or corrupts a core task · P1 = likely wrong result or false belief · P2 = friction.
"Seen" = reproduced in the browser; "code" = confirmed from source only.

| # | Workflow | Role / device | Problem | Evidence | Impact | Cause | Fix | Pri | Status |
|---|---|---|---|---|---|---|---|---|---|
| F1 | Any job page | worker / phone | Bottom bar shows Now · Work · Proof · Site; none respond; Today/Jobs/Hours/Gear gone — only "← All jobs" exits | seen | every job visit; can't reach Hours from a job | `phil_job_rooms` ON in prod but the rooms view left with #916 → pending stand-in bar with no-op buttons | resolver reports rooms off (no view exists); job page keeps the global bar | P0 | **fixed** |
| F2 | Log hours | worker / phone | Searching the job dial ("castle") leaves the pinned **"Sick day"** row in the highlighted band; tapping it logs sick leave | seen | wrong attribution to payroll | day types pinned above search results | search shows only matches, jobs first; day types only if searched | P0 | **fixed** |
| F3 | Log hours | worker / phone | The dial's highlighted band follows the spin, the pick follows taps: after a scroll "Monday" sits in the yellow band while "Today" is picked | seen (page scroll over the dial moved it) | worker believes the wrong day/job is picked | band always painted as "chosen" | yellow notch only on the actual pick; caption names the pick when spun away; picked row always bold | P1 | **fixed** |
| F4 | Log hours from a job | worker / phone | Job page "Log hours" → Today tab (no form there); copy says "Opens your Day tab — hours aren't logged per job" (false: hours are job-attributed, no "Day" tab) | seen | job context lost; extra navigation; re-pick job on a dial | stale link from before sharpened | → `/phil/hours?job=<id>`: lands on the form with that job picked; same for the jobs-list long-press | P1 | **fixed** |
| F5 | Log hours | worker / phone | Receipt: "sent for approval … The office will get a push when they review" — no job, no day; push not configured in prod | seen + prod env | wrong pick not caught; false promise | copy | receipt names day + job ("Wed 23 Sept · Smith Residence Rewire"), points at Change; no push claim; errors say retry is safe (idempotent) and drop "(HTTP 500)" | P1 | **fixed** |
| F6 | Pay hand-off | admin / desktop | Page says "no hours are sent anywhere from here" while offering **both** Send to Tia and Xero draft export; nothing says the week was already emailed | seen | double hand-off / double email to accounts | email send stamps nothing; copy predates both paths | truthful page copy; "use one hand-off per week" where both show; card shows real recipients and **"Already emailed Tue 22 Sept 4:32 pm by Tom to …"** from the existing audit journal; button → "Send again" | P1 | **fixed** |
| F7 | Pay hand-off | admin / phone | Closeout finale: "Sending to Tia · accounts" hard-coded; no sign the week already went; one tap re-sends | seen | double email; wrong belief about recipients | same | real recipient list; "This week was already emailed …" warning; button → "Send a second copy" | P1 | **fixed** |
| F8 | Xero batch | admin / desktop | After an export the row still says "Locked", Export stays enabled, Retry/Reconcile hidden until reload; "Network error — nothing was sent to Xero" claims what the client can't know; "(#249)" and "Commit an immutable payroll run / Lock payroll" wording | code | confusion at the money step; implies BuhlOS runs payroll | child refreshes only itself | parent list re-reads after export/retry/reconcile and after a dropped connection; plain draft-timesheet wording | P1 | **fixed** (not browser-tested: no Xero locally) |
| F9 | Reject / send back | admin / desktop | Blank reason: error set behind the modal (invisible); API failure closed the modal and lost the typed reason; a stalled request left "Sending back…" forever with Cancel disabled | seen (stall) + code | stuck or lost work | page-level error, no timeout | in-dialog error, reason kept, confirm disabled until reason typed, 20 s request timeout on approve/reject | P1 | **fixed** |
| F10 | Reject copy | admin | "They'll get a push notification with the reason" | code + prod env | false promise | push unconfigured | "They'll see the reason and a Fix button in their app" | P1 | **fixed** |
| F11 | Phone approvals | admin / phone | Summary tile stayed "0/3 approved" while the list said "1 of 2 approved" | seen | untrustworthy numbers | tile read server props only | tile derives from the same local state; labelled "crew approved" | P2 | **fixed** |
| F12 | Find a job | admin / desktop | Search ignores the IV number (the way everyone names jobs) | code | slow find | filter fields | name / address / ref / **IV code** | P2 | **fixed** |
| F13 | Find a job | admin / desktop | "Archived" filter always empty; its comment points at a legacy page that redirects back | code | archived jobs unreachable | page strips archived rows | archived rows load only for the Archived view | P2 | **fixed** |
| F14 | New job | admin / desktop | Create disabled with no reason shown; double-Enter could create twice; duplicate IV only as a generic error | code | abandoned or duplicate jobs | validation shown only after a click that can't happen | click reveals errors + focuses the field; in-flight latch; duplicate IV/name shown on the field naming the other job | P2 | **fixed** |
| F15 | Command centre | admin | "Rejected days" row says "Approve" and links to a page that doesn't list rejected days; phone rows show ISO dates "(2026-09-21)" | seen + code | dead end | wrong href | "Review" → the weekly board week; human dates | P2 | **fixed** |
| F16 | Jobs / My Day failure | worker / phone | Failed jobs read shows "Couldn't load" **and** "No jobs assigned yet"; failed hours read still shows "0 of 3 logged" and "Nothing's chasing you" (error at the bottom) | code | false all-clear | empty ≠ failed not distinguished | failure leads the screen; no count, no all-clear, no "no jobs"; empty state points at + New job | P1 | **fixed** |
| F17 | Hidden-feature traces | worker / phone | "Materials & job history aren't connected yet" on every Today; "Material requests aren't in the app yet" on every job | seen | noise; breaks the lean-reset no-trace rule | leftover explainers | removed | P2 | **fixed** |
| F18 | Tag register | worker / phone | Save errors and "Uploading photo…" render **under** the full-screen sheet; "Take a photo" tappable mid-upload | code | tap "Save", nothing seems to happen | page-level notice | error + progress inside the sheet; photo input disabled while busy | P1 | **fixed** |
| F19 | Log hours | worker / phone | Copy "use Split across jobs **above**" (it's below); 409 "status shown above" (not shown); "Done" link ~20 px tall; dial caption 11 px | seen + code | small confusions, missed taps | copy / CSS | corrected; Done 44 px; caption 12 px (field floor) | P2 | **fixed** |
| F20 | Gear tab | worker / phone | Permanent "Gear — coming soon" in one of five nav slots; a calibration alert links to it | seen | dead end | deliberate owner call (#946) | **not changed** — owner decision (§6) | P2 | open |
| F21 | Day dial | worker / phone | A vertical swipe that starts on the dial spins it instead of scrolling the page | seen (mouse wheel) | slower, surprising; with F3 fixed it can no longer mis-pick silently | owner-directed dial (#998) | **not changed** — field-validate (§6) | P2 | open |
| F22 | My Day | worker / phone | "Log hours now" appears twice (banner + tile); "Synced" pill reflects only `navigator.onLine` | seen / code | noise; possible false reassurance | design | not changed | P2 | open |
| F23 | Phone approvals | admin / phone | "Approve" on a worker card approves the whole week in one tap (30 s undo) | code | accidental approval possible | design | not changed (undo exists; field-validate) | P2 | open |

## 5 · Phil changes — governing principle and UI slot (governance §4)

| Change | Serves | UI slot |
| --- | --- | --- |
| F1 job page keeps the global bar | P9, P12, P8 (≤1-gesture recovery) | **Removes** the 4 dead in-job room buttons; restores the ratified 5-slot bar on job screens. No new slot. `phil_job_rooms` stays in the registry and prod env; the resolver ignores it until a rooms view exists (restore both together). Recommend the owner removes `FLAG_PHIL_JOB_ROOMS` from prod env. |
| F2/F3 honest dial + search | P7, P12, P6 | Existing job/day picker slot — no new control |
| F4 Log hours from the job | P13, P14, P6 | Existing "Log hours" quick action — href + reason only |
| F5 receipt names day + job | P7, P14 | Existing success notice |
| F16 failure ≠ empty | P7, P9 | Existing notice moved to the top; empty state suppressed |
| F17 no-trace | P10 (adding requires removing) + lean-reset rule | **Removes** two explainer slots |
| F18 tag sheet errors | P7, P9 | Existing sheet |
| F19 targets / type floor | P8 | Existing controls |

No navigation philosophy was changed. The rooms experiment (#133) is not decided by this — it had
no view to judge since #916.

## 6 · Still open

**Defects that still block a core task**
- None found that block the lean core once F1–F19 ship — with the caveat that the Xero batch path
  (F8) and email sends were only verified in unit tests and against a 503, never against a live
  Xero organisation or provider.
- Pre-existing: `tests/playwright/smoke/job-builder.spec.ts` never fills the IV number that
  NewJobForm has required since #1051, so that smoke can't create a job.

**Needs real field validation before changing**
- F21 day-dial scroll capture, F23 one-tap week approve, F22 duplicate "Log hours now", the
  Gear placeholder slot (F20), and whether workers read the new dial caption/notch at arm's length
  in sunlight.

**Intentionally outside the lean product** (pull-not-push — not built)
- Material requests, job history, a gear register on Phil, an offline write outbox, push
  notifications (needs VAPID keys — an owner configuration step, not code).

## 7 · Field-validation script (one field worker, one office user, ~20 min each)

**Field worker (apprentice or tradie, own phone, on site, gloves on if normal):**
1. From Today, open the job you're on today and tap Log hours. *Observe:* does it land on the form
   with that job already picked? Time to logged.
2. Log yesterday instead of today. *Observe:* how they change the day; whether they ever believe a
   different day is picked than the one ticked.
3. Pick a different job by searching its IV number, then its street. *Observe:* hesitation at the
   dial; any tap on a row they didn't mean.
4. After logging, ask "which job and day did that go to?" *Observe:* whether they read it off the
   receipt.
5. Put the phone in airplane mode, log a day, then turn signal back on and retry.
   *Observe:* do they trust "trying again won't log it twice"? Check the office sees one entry.
6. Add a test tag from a sticker photo. *Observe:* do they see progress and any error.

**Office user (boss/admin, phone first, then desktop):**
1. On the phone, approve one worker's week and send one day back with a reason.
   *Observe:* do they find the reason box, and do the numbers on the tile match the list?
2. Open the closeout send screen for a week that was already emailed. *Observe:* do they notice
   "already emailed" and choose not to send, or deliberately send a second copy?
3. On desktop /hours/period: "what will accounts get, and has it gone?" *Observe:* whether the
   one-hand-off note and recipient line answer that without help.
4. Find a job by IV number; open an archived job; create a job with a duplicate IV.

**What justifies the next round:** any worker picking the wrong day/job at step 2–3, anyone who
can't say where the hours went at step 4, or an office user who would email and Xero-export the
same week → rework that screen. Zero such events across two workers and one office user →
persevere and move to the dial-scroll (F21) and one-tap-approve (F23) questions.
