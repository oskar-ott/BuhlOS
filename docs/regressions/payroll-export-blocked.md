# Regression: the pay week cannot leave the building

**Symptom.** The office finishes reviewing the week and the payroll artifact
(the Send-to-Tia email, the PDF, the CSV, or the Xero batch) is either
**silently short** (real approved days missing, no error) or **refused**
(`payroll read refused — N day record(s) could not be read consistently …`)
with no retry that ever clears it. Either way pay is held up, and pay is the
one function of the app that must work every week.

**This has now happened three times**, with different root causes and the
same user-facing outcome, which is why this note exists — to hold the
failure-mode-agnostic guardrails and the process lesson in one place.

## Root causes so far

| When | PR | Root cause | One-line fix |
| --- | --- | --- | --- |
| 2026-08-24 (wk34) | #1036 | The office bulk-approved the week and generated the PDF minutes later. A just-overwritten day blob can keep serving its **previous** content from the CDN (Vercel documents up to ~60s), even with a cache-busting query. The stale read still said `submitted`; the approved filter dropped real hours **with no error**. Workers looked unpaid. | Verify every entry read against the blob's last-PUT time (`uploadedAt` from `list()`, API-fresh); a stale read retries, then the whole collection refuses with a 503 naming the days. |
| 2026-09-21 | #1049 | The #1036 guard compared the PUT time against the **handler's** `updatedAt`. Bulk approve/reject and the Xero export stamp took ONE timestamp before a slow sequential write loop, so the last entries stored a stamp up to a minute behind their own PUT. The guard read that as a stale CDN read and refused the pay week **permanently** (both values frozen in stored data; "wait a minute and retry" could never work). Six 503s over several hours. The hoist dated from 29 July — a month before the guard existed. | Stamp per entry at its own write; accept a blob settled longer than the propagation window; log the numbers behind a refusal. |
| 2026-10-05 | *(2026-10-09 hardening)* | The boss bulk-approved the week on the phone (07:34 UTC, 6:34pm Sydney) and tapped Send to Tia ~10s later. Three just-approved days still served their pre-approval copy from the CDN (Louis Kane 2 Oct, Stephen Mayne 1 Oct, Jonathan Borg 2 Oct) → 503. A second tap ~40s later was still inside the window for the last day approved — Louis's 2 Oct was still stale on the in-request retry ~60s after its PUT. Nobody tapped a third time; **the week never reached accounts**. Separately, two workers' Fridays had never been logged and the sheet said nothing about them — the phone showed "2 days never came in", a count with no names. The 2026-10-06 audit found two more holes in the same class: the phone finale opened (with a live "Send anyway") while its own approvals were still being written, and a send then **silently** leaves those days off; and the #157 compare-and-swap read the "current" revision through the same CDN, so an approval decided on a stale copy could write the old hours back over a correction made seconds earlier (the failure `api/_lib/leave.js` recorded live on 2026-07-25). | See "Guardrails" 9–14: sends wait the CDN window out by themselves; artifacts are only read from a quiet period; every read that is acted on is verified against the store's own metadata (byte size + PUT time); the CAS baseline is verified; the finale can't send while its approvals save; the sheet names everything it doesn't carry. |
| 2026-09-22 (audit) | *(this one)* | A read-only scan of every production day-file showed the handler stamp was the wrong signal entirely, not just for batches: it trailed the PUT by **up to 78s**, and sat within 2s of the 15s skew at the **90th percentile on ordinary single approvals**. The storage layer's own `__updatedAt` (written by `applyGuards` inside `writeBlob`, immediately before the put) trailed by **at most 3.1s**. Meanwhile seven hours walkers still took one `list({ limit: 5000 })` page and never followed the cursor — the store caps a page well below that, so the boards would one day have silently reported real days as "missing". | Guard on `__updatedAt` (handler stamps only as the legacy fallback); bound each content fetch (8s) so a stalled CDN connection cannot hang the send; paginate every `users/` walk through `listTimeEntryBlobs`; surface the engine's own refusal text on `/hours/period` instead of "Export API returned 503". |

## The structural problem

The pay week is produced by ONE row engine (`api/_lib/payroll-inputs.js`
`collectRows`) that every artifact — CSV, PDF, Send-to-Tia email, Xero batch
create/lock — reads through. That is the right shape: one engine means one
guarantee. But it also means a defect in the engine, or in the guard around
it, stops **every** artifact at once, and there is deliberately no override:
a payroll artifact is complete or it does not exist.

That makes the guard's inputs load-bearing. The guard asks "is the content I
fetched at least as new as the blob's last PUT?" and the answer is only as
honest as the stamp it compares. Incident 2 was the guard trusting a stamp
that a writer controlled; the audit found that stamp was marginal even when
writers behaved. The storage layer already stamps every document at the
moment it stores it, and that is now the stamp the guard trusts.

## Why the second bug was allowed to exist

- **The fix for incident 1 was designed and merged the same evening**, under
  incident pressure, with tests for the synthetic scenario only. It introduced
  a **fail-closed** guard whose safety depended on an invariant — "every
  writer stamps immediately before it stores" — that was never stated, never
  enforced, and never checked against the writers that already existed.
- **No one measured.** The 15s skew was reasoned ("ms–seconds"), not
  measured. One read-only scan of production data (the scan in this audit
  took a minute) would have shown the handler stamps sitting at 13s p90 and
  22 records from the very night of incident 1 already over the line.
- **The refusal logged nothing.** For four weeks the guard was one slow
  batch away from blocking pay, and when it did, the only signal in
  production was `POST /api/time-entries-email 503`. Diagnosis needed a code
  read.
- **Fail-closed with no measurement is a bet.** Refusing is the right default
  for pay — but a refusal that no retry can clear is a different failure than
  a short artifact, and the design did not distinguish them.

## Guardrails now in place

1. **The freshness signal is the storage stamp** (`__updatedAt`), set by the
   same code that performs the put. No handler, present or future, can trail
   it. Handler stamps remain only as the fallback for legacy raw-put rows.
2. **The skew is measured, not reasoned:** 15s against a measured 3.1s
   worst case on 331 production day-files (2026-09-22). Re-measure with the
   read-only scan before ever tightening it.
3. **A settled blob is never refused:** past the 5-minute propagation
   window a trailing stamp is a fact about the write, not the read; it is
   accepted and logged.
4. **Every content fetch is bounded (8s)** and a stalled fetch counts as
   unreadable and retries — the send can no longer hang until the function
   times out.
5. **Every refusal logs the numbers** (which blob, its PUT, the stamp it
   compared, the gap, the skew) so the next block is a log query, not a code
   read.
6. **Every `users/` walk pages to the end** through
   `api/_lib/time-entry-blobs.js`. The silent 5000-cap class is closed
   across the hours surfaces, not just the payroll engine.
7. **Tests pin the pair that separates the two incidents** — the same gap
   with different recency must give opposite verdicts — plus the exact
   production record shape from incident 2 (handler stamp a minute stale,
   storage stamp fresh, blob just written) which must be INCLUDED, and a
   two-page listing whose second page must be seen.
8. **The period page shows the engine's own refusal text**, naming the
   worker-days, instead of a bare status code.

Added 2026-10-09, after the 5 Oct week that never went (the third incident):

9. **A refusal says when it clears, and the send waits it out by itself.**
   A refusal of days written inside the CDN window carries `code: 'settling'`
   + `retryAfterMs` (and `Retry-After`); both send surfaces
   (`src/components/admin/sendPeriodTimesheets.ts`, the one send path) show
   "still saving — it sends by itself in about N seconds" and re-send, up to
   three times (~2 minutes after the last change — twice the ~60s staleness
   production showed). A 'settling' refusal happens before anything is
   composed, so a re-send can never produce a second email.
10. **Artifacts are only read from a quiet period.** The emailed sheet, a
    CSV/PDF download and a Xero batch create/lock (`collectRows({ quiet: true })`)
    are refused — fast, before a single day is fetched — while ANY day-file in
    the period was written in the last 70s. This closes, for every client, the
    case no stale-read check can see: approvals still being written (a bulk
    approve writes a day every few seconds, so mid-batch there is always a fresh
    write in range). The /hours/period json preview is exempt: it is refreshable
    and verifies every read instead.
11. **Every read that is acted on is verified against the store itself.**
    `api/_lib/source-freshness.js` `contentVerdict` holds the fetched body
    against the store's own metadata (list()/head(): exact byte `size` + PUT
    time). Size is decisive while a stale copy is physically possible (inside
    the 5-minute suspect window) and is then accepted-and-logged, never a
    permanent block (lesson of 2026-09-21). Inside the CDN window the stamp bar
    is tight (5s, against the measured 3.1s), so two writes seconds apart are
    still told apart; past it the historic 15s skew applies.
12. **No write is decided on a stale copy, and none can silently overwrite
    another.** Every hours write path — create's "does this day exist?", edit,
    approve, reject (+undo), reopen, amend, bulk approve/reject, Xero export
    stamping, draft delete — reads through `readEntryVerified`
    (`api/_lib/time-entries.js` → `blob.js` `readBlobVerified`: head()/list()
    + body + verdict, retry, then refuse). `writeEntry(…, { basedOn })` makes
    that verified version the compare-and-swap baseline; a writer without one
    has its baseline verified inside `writeBlob` (`verifyCurrent`) — an honest
    conflict, never an overwrite. A day that can't be confirmed is a retryable
    409 (`code: 'stale_read'`) — never decided on, never a 404. The residual
    race is the put's own latency (~1.4s): Vercel Blob has no conditional put.
13. **The phone finale can't send while its approvals are saving.** It takes
    the review sheet's per-worker in-flight set and shows a disabled "Saving
    approvals…" until every approve / send-back / fix / undo has landed
    (server-side, guardrail 10 covers every other client).
14. **The sheet names everything it doesn't carry.** The emailed PDF, the email
    body (and its subject line), the approved Download PDF and the send
    receipts carry "Not on this sheet": every worker-day with no approved hours
    and why — waiting for approval, sent back for a fix, not sent in (draft),
    nothing logged, or on approved leave (`api/_lib/not-on-sheet.js`, built
    from the payroll read's own verified entries and the boards' own
    missing-day rule, `api/_lib/missing-days.js`). A finished week with nothing
    outstanding says "Nothing left off". The phone finale names the same days
    before the send. A sheet is complete, or it says exactly what it is
    missing — it can no longer be short by surprise.

## Not built, by decision (still open)

- **No override.** A refusal still has no "send anyway" path. Deliberate:
  a payroll artifact must never be quietly short. Since 2026-10-09 the send
  surfaces wait a settling refusal out by themselves (guardrail 9); a
  download that lands inside the window answers with the seconds to wait.
  Revisit only with field evidence that the wait itself is costing pay.
- **The emailed PDF does not partition subcontractor rows** out of the wages
  sheet (the Xero batch path does). No subcontractor exists in production
  today; when one is onboarded this needs an owner call on what the sheet
  shows for them.
- **Vercel Blob has no origin read for public blobs.** The newer SDK's
  `get({ useCache: false })` bypasses the CDN only for private stores (checked
  in @vercel/blob 2.8.0: it appends `cache=0` only when `access === 'private'`),
  so a stale-CDN window cannot be read around; verification + retry + honest
  refusal + waiting it out is the ceiling until the store is private or hours
  move to Postgres (#152). The same limit means there is no conditional put:
  guardrail 12's compare-and-swap narrows a lost update from the CDN window
  (~60s) to the put's own latency (~1.4s), it cannot make it zero.
- **The audit journals and `users.json` still read-modify-write through the
  CDN.** Guardrail 12 hardens the hours day-files (the pay data); the shared
  append-only journals (`audit/<yyyy-mm>.json`, per-user
  `time-entries-audit/`) and `users.json` (hourly rates) keep the older CAS
  read. Tracked as follow-ups.

## How to re-check production before changing the guard

Read-only scan (no writes): list every `users/*/time-entries/*.json`, fetch
each, and compare `uploadedAt` (listing) against `__updatedAt` and against
the newest handler stamp. Report the distribution of both gaps and every
record over the skew. Run it whenever the skew, the retry budget or the
settled window is about to change — evidence outranks reasoning here too.
