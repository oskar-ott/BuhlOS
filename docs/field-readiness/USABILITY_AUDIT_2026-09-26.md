# Usability audit + fixes — Phil (field) and BuhlOS (office), 2026-09-26

**Status:** audit done; the bounded fix set is in the PR that adds this file.
**Builds on:** the 2026-09-23 pass (PR #1056, `USABILITY_AUDIT_2026-09.md` in that PR — F1–F19 fixed,
F20–F23 left for field validation). Nothing from that pass is re-reported here.
**Scope:** the live lean core only (docs/product/02-lean-reset.md). No flag or production
configuration was changed; nothing hidden was un-hidden.
**Pull served (03-lean-startup-loop.md):** owner request for a second usability pass on the core
loops — fixes to shipped behaviour, no new feature.

## 1 · What is live (read 2026-09-26, not assumed)

Production flags = code default → `FLAG_*` env → `flags.json` override. Env read via `vercel env ls
production` (names only); `flags.json` values as read on 2026-09-23 (not re-read — the Blob store is
shared with production and was not touched).

| Flag | Prod | User-visible effect |
| --- | --- | --- |
| jobs, hours, evidence, employees, gear, job_photos | ON (kill-switch defaults) | lean core |
| phil_sharpened | ON (env) | 5-slot Phil bar Today · Jobs · Capture · Hours · Gear |
| phil_job_rooms | ON (env) | ignored by the resolver since #1056 (no rooms view exists) |
| xero_connection, xero_payroll_export, itp_simple, signup_link, job_materials_spend | ON (flags.json, 09-23 read) | Xero batch panel, simple ITP, crew link, materials ledger |
| invoice_capture, receipt_capture | OFF | nothing |
| supabase_read_hours (+ dual-write, admin/phil task+evidence reads) | ON (env) | hours display read from Postgres |
| Push (VAPID) | **not configured** (`/api/notifications?action=public-key` → 503) | no push is ever sent |

Stale memory corrected on the way: PRs #994 (Today-view kill) and #1022 (pay-period redesign) were
never merged — `main` still has the This week · Today · Pay period tabs and the batch panel.

## 2 · Workflow map (role × device)

| Route | Who | Device | State |
| --- | --- | --- | --- |
| /v2/login | everyone | any | live — office form; "On the tools?" → email + PIN pad; self-serve PIN reset (#1042) |
| /phil/my-day | field, LH | phone | live — greeting, yellow "Log hours now" banner, needs-you, quick tile |
| /phil/jobs, /phil/jobs/[id] | field, LH | phone | live — every active job (#907), + New job, finished jobs via search |
| /phil/hours | field, LH | phone | live — THE log form + 2 week cards + Change / Fix |
| /phil/jobs/[id]/photos · /tags · /itp-reports | field, LH | phone | live (ITP metadata is Supabase-first — not runnable locally) |
| /phil/gear | field, LH | phone | placeholder (#1034, owner call pending) |
| /command-centre | admin | desktop + phone (MobileToday) | live |
| /hours/weekly | admin | desktop board / phone stepper + closeout finale | live — **opened on LAST week while titled "this week"** |
| /hours/approvals | admin | desktop | live — no tab highlighted |
| /hours/period | admin | desktop | live — opened on THIS week; links back to the board dropped the week |
| /hours/today | admin | desktop | live (tab "Today") |
| /v2/jobs, /v2/jobs/[id], /v2/jobs/new | admin | desktop + phone | live |

## 3 · Method and evidence

- Three read-only code audits (office hours, Phil hours + home, capture/photos/tags/ITP + office
  jobs) ran in parallel against `origin/main` (a51e8093), then a **real browser walkthrough** on a
  fully isolated local runtime: a Node harness that serves `api/*.js` with the Vercel `(req, res)`
  shape and proxies pages to `next dev`, storage pointed at a **local mock of the Blob HTTP API**
  (the production store was never touched — the first attempt with `vercel dev` reached the real
  store read-only and was stopped before any write), synthetic users (boss, tradie, apprentice,
  LH) seeded, jobs created through the app's own New-job sheet and API, sessions via the real
  login screens. Phone = 375×812, desktop = 1366×900.
- Failure paths forced with a storage outage switch on the mock (the Blob SDK retries a 503 with
  backoff, so the field's 10 s write timeout fires — the copy for that case is honest).
- Limits: Blob-only locally (production reads hours from Postgres); no Supabase, so the ITP list
  could only be verified in its failure state; no Xero org, no mail provider; no real device,
  gloves, sunlight or bad signal. **Field evidence is still owed (§7).**

## 4 · Ranked findings

P0 = blocks or corrupts a core task · P1 = likely wrong result or false belief · P2 = friction.
"seen" = reproduced in the browser; "code" = confirmed from source.

| # | Workflow | Role / device | Problem | Evidence | Impact | Cause | Fix | Pri | Status |
|---|---|---|---|---|---|---|---|---|---|
| U1 | Log / change / fix hours | worker / phone | Every refusal (400 too-far-back, 403 closed job, 409, 5xx) read **"request failed … trying again is safe"** — the server's reason was dropped and the retry claim was false for 4xx | code (`src/lib/http.ts` used `statusText`, empty over HTTP/2) | worker retries a 400 forever, or logs to the wrong job | message built from status text | server `error` text surfaces; one mapper turns the known refusals into site language and only claims "safe to retry" for signal/5xx; a closed-job 403 says "pick another job" | P0 | **fixed** |
| U2 | Sent-back hours | worker / phone | A day rejected more than 7 days ago never showed on My Day ("Nothing's chasing you"); its week stayed folded on Hours — the only sign was a 6 px dot | code | rejection missed; pay blocked | 7-day entries window; fold rule | My Day reads 28 days; a week holding a sent-back day opens unfolded | P0 | **fixed** |
| U3 | Home screen | worker / phone | Saturday, Sunday and public holidays nagged: amber **"Due · Today's not logged yet"** chip and the yellow banner | seen (Saturday) | false pressure; contradicts the "no daily nag" directive | `todayEntry === null` | Due chip only on an unlogged work day; banner only while a work day this week is unlogged; public holidays excluded from "N of M days" (same table the office uses) | P1 | **fixed** |
| U4 | Hours tab on a failed read | worker / phone | My Day promised "you can still log hours on the Hours tab" while that tab showed only "API returned 500" and no form | code | can't log at all while the read is down | form unmounted on error | the Hours tab keeps the log form under a plain warning; the server's 409 still guards duplicates | P1 | **fixed** |
| U5 | Fix / split a callback day (#1060) | worker / phone | Split and Fix sheets only offered the default live list — a closed job found by search couldn't be split against; a rejected callback day couldn't be re-sent to its (now closed) job | code | callback hours mis-attributed or stuck | sheets got `assignedJobs`, not the dial's discovered set | the log sheet's discovered jobs feed both sheets; the My Day fix card loads the entry's own closed job by id ("… · Closed") | P1 | **fixed** |
| U6 | Capture from the job page | worker / phone | A failed upload closed the sheet, showed "…Tap Retry" with **no Retry button**, and the photo was lost on the next navigation; three doors to the same camera on one screen (quick action → scrolled to a second card; FAB opens a third screen) | seen + code | photo lost; extra tap on the common path | close-on-tap + banner-only error; duplicate card | on failure the sheet reopens with the photo and the error (Save = retry); the quick action opens the sheet in one tap; the duplicate card is gone; failure copy says what to do | P1 | **fixed** |
| U7 | Job page | worker / phone | "Rejected hours aren't shown on the job screen. Check your Hours tab…" on **every** job | seen | permanent explainer (P11) | bridge reported rejected hours as "unknown" | not-configured on the job page (they live on Hours / My Day, P9) | P1 | **fixed** |
| U8 | Find a finished job | worker / phone | With 0 or 1 jobs there was no search box, so a closed job (a callback) couldn't be found — a worker whose only job closed saw "No jobs yet" | code | callback job unreachable | search gated on 2+ jobs | search always shown once the list loaded; empty copy points at it | P1 | **fixed** |
| U9 | Capture sheet / gallery / ITP list | worker / phone | Traces of hidden or deleted features: "No areas configured for this job" on every capture; "Snag & ITP photos are office-side" + Snag/ITP category options in the gallery; ITP load failure showed raw `[supabase-env] MISSING_ENV…` **and** "No ITPs on this job yet" | seen | noise; failure ≠ empty (P7); breaks the no-trace rule | leftovers | removed; ITP failure is one plain notice and no empty state | P1 | **fixed** |
| U10 | Offline / sync | worker / phone | "Changes won't send until you're back on signal" implied a queue (none exists); "Synced" pill next to "Couldn't load your hours" | code | false reassurance | copy; `navigator.onLine` only | honest copy ("nothing is queued"); no Synced pill when the read failed | P1 | **fixed** |
| U11 | Change / fix an old day | worker / phone | "Change" and the fix sheet appeared on days older than the 14-day window; the PATCH always failed | code | dead-end taps | window only checked on create | pill hidden outside the window; the fix slot says "Too far back to fix from your phone — ask the office" | P2 | **fixed** |
| U12 | Sick / holiday / TAFE days | worker / phone | Receipt said "Wrong day or job? Use Change these hours" (no such button for day types); "Weekend day — all hours count as overtime" under a sick day | code | contradictory copy | unconditional lines | both lines only for worked days | P2 | **fixed** |
| V1 | Weekly board ↔ pay period | admin / desktop + phone | The board opened on **last** week under the title "Hours · this week" / tab "This week"; the period page opened on **this** week; "Open weekly closeout" / "Open pay period" dropped the week; the phone "Hours for payroll — 2 timesheets" card opened last week's empty board | seen | boss lands on the wrong week; "Nothing to review" with days waiting | different defaults; anchor-less links | both default to the last complete week; every link carries the week; title says "this week / last week / week of …"; tab renamed "Weekly" and lit on /approvals; the phone card opens the week of the oldest waiting day and says "days" | P1 | **fixed** |
| V2 | Failed load | admin / phone + desktop | Phone board on a failed week read still showed "0 of 0 crew approved · all clear" and "Nothing to review — every submitted week is cleared"; desktop board and approvals queue showed "No hours" / "No entries" under the error; Command Centre said **"All clear"** beside "Couldn't load every signal" (and missed the missing-days failure entirely); Today tiles showed confident zeros; office jobs list said "No active jobs" under "Couldn't load jobs" | code | payroll closed out on nothing reviewed | empty ≠ failed | every empty/all-clear state gated on no fetch error; "Can't say yet" card on the Command Centre | P0 | **fixed** |
| V3 | Phone "Send to Tia" | admin / phone | While the "already emailed?" check was loading or failed, Send was live with no warning — a double email one tap away | code | duplicate hand-off | `lastSent` read only when ready | "Checking…" (disabled) while loading; "couldn't check" notice + a second explicit "Send anyway" tap when unknown | P1 | **fixed** |
| V4 | Phone review stepper | admin / phone | Approve fired and the stepper advanced immediately — a double tap approved the **next** worker; end screens counted failures as reviewed | code | accidental approval; false "all cleared" | fire-and-forget | approval awaited ("Approving…"), failures stay on the worker; end screens count successes only | P1 | **fixed** |
| V5 | Unmapped Xero workers | admin | Finale said "Add the ID in Employees on desktop" — Employees has no Xero field; findings and "No Xero id" cells had no link to the real page | code | export blocked with no path to the fix | wrong pointer | links to /settings/integrations/xero everywhere the block is named; period page shows "N of M workers not linked" | P1 | **fixed** |
| V6 | Payroll batch panel | admin / desktop | Delete and Unlock were one tap beside Lock; a dropped connection showed nothing; "exporting" rendered raw; ISO dates; "immutable" copy | code | destructive by accident; silent failure | no confirm/catch | two-step confirm (as Lock); "Couldn't reach the server — nothing changed" catch; "Sending to Xero…"; human dates | P1 | **fixed** |
| V7 | Approvals queue / board | admin / desktop | One shared "approving" id re-enabled another row's Approve mid-request (double post) | code | 409 noise; confusion | shared state | per-row busy set; "Approve all" disables its rows | P2 | **fixed** |
| V8 | Phone approvals | admin / phone | Undo/Fix text buttons ≈18–30 px; whole sentences at 9–10 px; the review sheet had no visible close and a stray backdrop tap lost a typed send-back note | code | missed taps, unreadable | CSS | 44 px targets; ≥12 px body text; visible X; backdrop ignored while typing | P2 | **fixed** |
| V9 | Status words | both | rejected = "Rejected" / "Sent back" / "Fix needed" / "was sent back" depending on screen | code | the same day reads differently on the two phones | ad-hoc labels | office chips/pills say "Sent back", the action says "Send back"; Phil's `STATUS_WORDS` already says "Fix needed" for the worker | P2 | **partly fixed** (office side) |
| V10 | Command Centre + My Day | admin + worker | "Notifications" card promised digests and **stale-snag** alerts on a channel that is not configured in production ("tell the office" after the tap) | seen + prod env | false promise; deleted-feature trace | card ignorant of server state | card asks the server up front and renders nothing when push is unconfigured; snag wording gone | P1 | **fixed** |
| V11 | Job status | admin | "Draft" hid the job from every phone with no confirm; the menu said "Complete" while the pill said "Finished" | code | crew lose a live job by mis-click | confirm set | Draft asks first; menu item "Mark finished"; aria label matches the pill | P1 | **fixed** |
| U13 | Day dial | worker / phone | With "Today" (the first item) picked the centred band leaves up to two blank rows above it — dead screen on the most common path | seen | looks unfinished at arm's length | wheel geometry (owner-directed dial, #998) | **not changed** — a top-anchored band variant is a visible change to the ratified wheel; owner / field call (§6) | P2 | open |
| U14 | Hours week card | admin / phone | Workers with **no hours** in an open week sit under "Approved · N ready" and count toward "N of M crew approved" | seen | misleading progress | zero-hours = payroll-ready | not changed — the closeout model's definition; needs an owner decision on what "ready" means for a worker who logged nothing | P2 | open |

## 5 · Phil changes — governing principle and UI slot (governance §4)

| Change | Serves | UI slot |
| --- | --- | --- |
| U1 site-language refusals + honest retry claim | P7, P11 | existing error notice |
| U2 28-day window; sent-back week opens | P9, P7 | existing needs-you hero + week card fold state — no new slot |
| U3 no weekend/holiday nag | P7, P10, P11 (owner directive 2026-08-08) | **removes** a false Due chip / banner on non-work days |
| U4 log form survives a failed read | P5, P13, P7 | existing "Log your day" card |
| U5 closed jobs in split / fix sheets (#1060) | P13, P14 | existing sheets, no new control |
| U6 one capture door; failure reopens the sheet with the photo | P6, P10, P7, P9 | **removes** the duplicate "Capture evidence" card; the Quick action becomes the button |
| U7 no rejected-hours explainer | P11, P10 | **removes** a limitation line |
| U8 search always present | P9 (a closed job is findable), docs/job-lifecycle.md | existing search input |
| U9 no-trace: areas box, gallery notice + category, ITP failure ≠ empty | P7, P10, lean no-trace rule | **removes** three traces |
| U10 offline copy + pill | P7, P8 | existing banner / pill |
| U11 no dead Change / Fix outside the window | P7, P12 | existing pill / slot |
| U12 day-type copy | P7 | existing lines |

No navigation philosophy changed; no new top-level section anywhere.

## 6 · Still open

**Defects that still block a core task**
- None found in the lean core once U1–U12 / V1–V11 ship — with the caveats that the ITP list,
  the Xero batch path and email sends were verified only in unit tests and in their failure
  states (no Supabase, Xero or mail provider locally).
- #1034 Gear tab placeholder (owner decision A/B still owed).

**Needs real field validation before changing**
- U13 (dial dead space), U14 (what "ready" means for a zero-hours worker), the 2026-09-23 F20–F23
  set, and whether the new refusal sentences (U1) are read and acted on at arm's length.

**Intentionally outside the lean product** (pull-not-push — not built)
- An offline write outbox (#143), push notifications (an owner VAPID configuration step, not
  code), material requests / job history, per-worker capture move/undo.

## 7 · Field-validation script (one field worker, one office user, ~20 min each)

**Field worker (tradie or apprentice, own phone, on site):**
1. Monday morning after a full week: open Today. *Observe:* is there a Due chip or yellow banner?
   (There should be none on a Saturday/Sunday; on Monday only if Friday is missing.)
2. Log Friday to a job that has since been finished (the office marks one finished first). Then
   split Thursday between that job and a live one. *Observe:* can they find the finished job in
   the split sheet; do they read "· Closed" on it.
3. Ask the office to send back a day from two weeks ago while the phone is closed. Reopen Today.
   *Observe:* does the "needs a fix" card appear; does the Hours week open on its own.
4. Force a refusal: try to log a day 3 weeks back. *Observe:* what they say the message means and
   whether they retry.
5. On the job page, take a photo with the phone in airplane mode. *Observe:* does the sheet come
   back with the photo and the error; do they tap Save again once signal returns; one photo lands.

**Office user (boss/admin, phone first, then desktop):**
1. Tuesday: open Command Centre on the phone, tap "Hours for payroll". *Observe:* does it land on
   the week with the waiting days.
2. Approve one worker's week in the stepper and double-tap Approve on purpose. *Observe:* does the
   second worker get approved (it must not).
3. With the phone offline, open the weekly board. *Observe:* do they believe "all clear" or see the
   load failure (there must be no all-clear).
4. Desktop: from the board, "Open pay period"; from the period page, "Open weekly closeout".
   *Observe:* same week both ways?
5. Set a job to Draft. *Observe:* the confirm; do they read what it does to the crew.

**What justifies the next round:** any worker who retries a refused day, can't find a finished job
in a sheet, or loses a photo; any boss who approves the wrong worker or lands on the wrong week →
rework that screen. Zero such events across two workers and one office user → persevere and take
the U13 / U14 questions to the owner.
