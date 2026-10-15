# Shorter paths audit — 2026-10-15

**Type:** whole-app audit for work that goes the long way round, plus the first
batch of fixes. **Owner pull:** "I want to work faster and more efficiently —
find things that are stupid, going longer ways than they should."
**Date basis:** main @ `be86ece7` (#1106).

The audit traced the real daily loops in code (not from docs): the office home
→ jobs → job hub → builder; the weekly hours review → approve → pay period →
send; the field app open → log hours → open job → photo → ITP; and the
handler → `api/_lib` → Blob path behind each of those screens. Four passes ran
in parallel (office flows, hours/payroll, field flows, data layer); every
finding below was then verified by reading the cited code. Nothing was
device-walked — preview-verify the field items on the PR preview.

**Status key:** `FIXED` landed in the PR that adds this doc · `NEXT` a real,
scoped follow-up worth its own PR · `OWNER` needs a product decision first ·
`NOTE` observed, low value or out of scope.

---

## 1. Office

| # | Finding | Status |
|---|---------|--------|
| O1 | **No office screen could put a worker on a job.** The command centre said "assign workers so hours can be logged"; the hub's "Manage" link opened the employee register, whose drawer is read-only for assignments; the mobile exception pointed at a builder anchor (`#assigned-field-workers`) that never existed. The only writer of `assignedJobIds` was worker creation. `POST /api/crew?action=assign|unassign` existed with zero callers. | FIXED — the hub crew band (`JobCrewNames`) now lists everyone with an app login; Add/Remove writes through `/api/crew`, optimistic, then refreshes the band's count. The command-centre row opens the one crew-less job directly; the mobile exception opens the hub. |
| O2 | After the weekly closeout, "Open pay period" dropped the week: the board opens on **last** week, the period page defaults to **this** week, so the office landed on an empty period and paged back. | FIXED — board + wizard links carry `?period=week&anchor=<weekStart>`. |
| O3 | Evidence review breadcrumb went to Command Centre, not back to the job (the photos page already did it right). | FIXED — "← Job". |
| O4 | Hub "Open builder" and Site "Edit" were plain `<a>` → full page reload (shell + flags + session re-resolved); other hub links were `<Link>`. Same on the Labour card. | FIXED — client-side `Link`. |
| O5 | Labour card "Approve on the week board" landed on the board's default week, not the week holding the pending days. | FIXED — link carries the week of the oldest submitted day on the job. |
| O6 | Command centre blocks first paint on all eight reads, with two flag reads awaited **before** the snapshot even starts. | FIXED (flags now overlap the snapshot). NEXT: stream the pulse/week totals behind Suspense like the job hub does. |
| O7 | Builder publish checklist blocks a lean job (no areas/tasks = `error`), while the hub status pill publishes the same job in two clicks with no check. | OWNER — downgrade `no-areas`/`no-tasks` to warnings, or add "Create & publish" on the new-job form. Cites docs/job-lifecycle.md. |
| O8 | "Add worker" is a 4-step wizard for ~7 fields. | NEXT (M) — one scrollable form, same validation. |
| O9 | Builder Basics has two independent Save buttons (header save + client/contract section with its own save + refresh); the dirty guard fires between them. | NEXT (M). |
| O10 | Gear links (health-band "expired tags" chip, builder Deliver, nav) land on a "Coming soon" page since #946 parked the register. | OWNER — mount the register or stop rendering the chip while parked. |
| O11 | Builder "Materials spend" anchor only exists when `job_materials_spend` is on. | NOTE — flag-dark. |
| O12 | Employee register search/filter/open-drawer aren't in the URL (jobs list does this). | NEXT (S). |
| O13 | Hub crew names fetch the whole register after paint. | NOTE — kept (it is also now the assignment picker's data). |
| O14 | Blueprint create skips the IV number the blank form insists on. | NEXT (S) — add the field. |
| O15 | Supplier-invoice review has no "next" after confirm. | NOTE — `invoice_capture` is dark. |

## 2. Hours / payroll

| # | Finding | Status |
|---|---------|--------|
| H1 | Desktop closeout → wrong week on the period page (= O2). | FIXED |
| H2 | Every send/download waits up to 70 s after the last approval (`CDN_SETTLE_MS` quiet-window refusal), even though the on-screen rollup already uses a per-day verified read. | OWNER — this is the 2026-10-06 integrity rule; relaxing it to "wait only for a genuinely stale day" needs sign-off. |
| H3 | Desktop board: every per-day Approve/Reject/Reopen/Leave is a full page re-render (overview walk + payroll-runs + N cost-rate reads) with no optimistic state; the wizard and the phone already overlay + debounce. | NEXT (M) — patch local closeout state, reuse the 700 ms debounced refresh. |
| H4 | Send-back and Undo are one serial HTTP call per day; `api/time-entries-bulk-reject.js` has no callers. | NEXT (S) — wire bulk reject; parallel reopen with `appendAuditMany`. |
| H5 | Single-day approve did three serial store writes before answering (entry, audit, activity). | FIXED — audit + activity overlap after the entry write (as bulk approve already did). |
| H6 | Pay-period page fetched its own API over HTTP (two function hops, each walking the store). | FIXED — in-process reads. NEXT: derive readiness from the export's entries (one walk instead of two). |
| H7 | Today tab: five full store walks per view, over HTTP; the approver walk reads every day-file ever. | FIXED (in-process). NEXT: one `statuses=` call, date-bound the approver walk. |
| H8 | Desktop reject requires typing a reason; the phone and wizard offer chips/defaults. | NEXT (S). |
| H9 | Weekly page fetches cost rates one call per worker, serially after the overview. | NOTE — in-process + 5 s blob TTL make this cheap; one read-for-all is a small follow-up. |
| H10 | `/hours/approvals` re-walks all history on every action though the row is already removed locally. | FIXED (in-process). NEXT: drop the refresh. |
| H11 | Period table shows "No Xero id" with no path to fix it; the runs panel may read a file nothing writes. | NOTE — verify whether `payroll-runs.json` is still written. |

## 3. Field (Phil)

Field changes stay inside the ratified package: each one removes a tap or a
stale state from an existing flow and names the principle it serves. No
navigation or information architecture changed.

| # | Finding | Status |
|---|---------|--------|
| F1 | "Log hours now" on My Day landed at the **top** of the week history; the log sheet sits at the bottom of the current-week card (after the day rows), so logging a standard day was a scroll + 2 taps. | FIXED — the banner lands on the sheet (`?log=1`, same arrival rule as `?job=`). P6 (common case = one tap). |
| F2 | Friday backfill: after each save the sheet stays on the now-locked day; the worker scrolls up, taps the next row, scrolls down. | NEXT — advance to the next unlogged day after a save. Note: the sheet is keyed by date, so the success receipt must survive the remount; raise under governance §3 as a behaviour change. |
| F3 | A photo filed from the FAB never reached the page underneath: the job's "Today's captures" strip stayed stale until a pull-to-refresh. | FIXED — the launcher refreshes the page on a confirmed save. P7 (the surface matches the receipt). |
| F4 | The capture launcher re-fetches the jobs list and the full job detail on every open, even when the page already holds them. | NEXT (M) — seed from context. P8. |
| F5 | Job-page "Capture evidence" pre-tags Rough-in + the first area the worker never chose. | NEXT (S) — pass no context unless restored from the worker's own choice. P2/P7. Unverified whether field-created jobs carry areas. |
| F6 | Each photo in a batch reads the whole `jobs.json`. | NEXT (M) — one job read per batch. |
| F7 | Hours tab loads the entire history on every open and after every save. | NEXT (S) — range the read to the displayed weeks (cap already exists). |
| F8 | Start ITP → back to the list → find the row → open it → name an area. | FIXED — Start opens the new report. P6. NEXT: offer the job's existing area names as chips. |
| F9 | Site phone is three screens deep (hero address is plain text; the Site card is collapsed at the bottom). | OWNER — `tel:` on the hero address line touches the bible's "no icons next to the name" rule. |
| F10 | Capture receipt needs a Done tap. | NOTE — kept; the receipt is the only confirmation. |
| F11 | Leave: two date pickers for a one-day absence. | NOTE — not a finding: a blank "last day" already means one day. |
| F12 | Picking a job popped the empty Notes box open on every multi-job log. | FIXED — notes stay tucked under "More options". P10. |
| — | Verified fine: job picker defaults (last logged → sole job), day defaults to today, no confirm dialogs or hard reloads anywhere in `src/components/phil`. | — |

## 4. Data layer

Blob reads via `api/_lib/blob.js` ride a 5 s TTL + in-flight dedupe, so the
real costs are store **listings** (~1–2 s), **puts** (~1.4 s each, serial on
write paths) and **HTTP self-fetches** (one function wake per call).

| # | Finding | Status |
|---|---------|--------|
| D1 | Every office page mounts `useNavCounts`, which fires three API functions per full load, including the full approver walk. | NEXT (S) — pass server counts as props; or one cheap counts endpoint. |
| D2 | `walkAllEntriesForApprovers` fetches every day-file in history (~500, +50/week) for the approvals queue, the nav badge and the job Labour card. | NEXT (M) — date-bound the walk for `job-hours`; a status index for the queue. |
| D3 | Phil job page read the whole jobs list over HTTP for its header, then five more HTTP self-calls. | FIXED — in-process. |
| D4 | Pages #1096 missed still self-fetched over HTTP: period, today, approvals, More tab, office photos/plans/evidence, Phil jobs list, Phil photos. | FIXED — nine more handlers registered in `in-process-api.js`; ten pages switched. |
| D5 | Summary freshness probe (a listing) ran **before** the summary read on my-day, Phil jobs, Today and People. Same in the job-detail projection. | FIXED — both in parallel. |
| D6 | `time-entries-overview` started the entry listing after the reference reads and ran the leave listing serially at the end. | FIXED — both start with the reference reads. |
| D7 | Field "send day"/edit: two serial audit puts after the entry write (POST already overlapped them). | FIXED. |
| D8 | Single-day approve: three serial puts (= H5). | FIXED. |
| D9 | Closeout board re-renders after every row action (= H3). | NEXT |
| D10 | Evidence capture pays an audit read-modify-write **before** the data write. | NEXT (M) — mint the id first, overlap the writes. |
| D11 | Job save: one audit read+put per kind (status, basics, areas, tasks) on the same blob before the response. | FIXED — `appendAuditMany`, one read-modify-write (tested). |
| D12 | Serial prefixes in front of parallel work: command-centre flag awaits; `day-pulse` (jobs → listing → per-job data); `job-glance` (four serial reads). | FIXED. |
| D13 | Photos index bypassed the blob fast path (raw listing + fetch on every gallery open and upload). | FIXED — `readBlob`/`writeBlob`. |
| D14 | PG hours read: three serial queries per worker list. | NEXT (S) — one join. |
| D15 | User sweep/delete: N+1 with a serial inner loop. | NOTE — cron/rare. |

## 5. What this PR changes, in one breath

Office: crew is assigned on the job hub; closeout links land on the week you
reviewed; evidence review goes back to the job; hub links don't reload.
Field: "Log hours now" lands on the sheet; a filed photo shows on the page;
Start ITP opens the ITP; picking a job doesn't pop the notes box. Data: ten
pages read in-process; eight handlers stop doing their reads and writes one
after the other.

## 6. Verification

`npm run typecheck`, `npm run lint`, `vitest run` (all green; two tests
updated for the changed hrefs, one new test for the batched job audit),
`next build`, and the route-ownership / role-literal / read-flag guards.
Field-facing changes are to be preview-verified on the PR preview (`next dev`
can't run `api/*.js`).
