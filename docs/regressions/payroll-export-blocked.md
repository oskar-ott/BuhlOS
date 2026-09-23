# Regression: the pay week cannot leave the building

**Symptom.** The office finishes reviewing the week and the payroll artifact
(the Send-to-Tia email, the PDF, the CSV, or the Xero batch) is either
**silently short** (real approved days missing, no error) or **refused**
(`payroll read refused — N day record(s) could not be read consistently …`)
with no retry that ever clears it. Either way pay is held up, and pay is the
one function of the app that must work every week.

**This has now happened twice**, with different root causes and the same
user-facing outcome, which is why this note exists — to hold the
failure-mode-agnostic guardrails and the process lesson in one place.

## Root causes so far

| When | PR | Root cause | One-line fix |
| --- | --- | --- | --- |
| 2026-08-24 (wk34) | #1036 | The office bulk-approved the week and generated the PDF minutes later. A just-overwritten day blob can keep serving its **previous** content from the CDN (Vercel documents up to ~60s), even with a cache-busting query. The stale read still said `submitted`; the approved filter dropped real hours **with no error**. Workers looked unpaid. | Verify every entry read against the blob's last-PUT time (`uploadedAt` from `list()`, API-fresh); a stale read retries, then the whole collection refuses with a 503 naming the days. |
| 2026-09-21 | #1049 | The #1036 guard compared the PUT time against the **handler's** `updatedAt`. Bulk approve/reject and the Xero export stamp took ONE timestamp before a slow sequential write loop, so the last entries stored a stamp up to a minute behind their own PUT. The guard read that as a stale CDN read and refused the pay week **permanently** (both values frozen in stored data; "wait a minute and retry" could never work). Six 503s over several hours. The hoist dated from 29 July — a month before the guard existed. | Stamp per entry at its own write; accept a blob settled longer than the propagation window; log the numbers behind a refusal. |
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

## Not built, by decision (still open)

- **No override.** A refusal still has no "send anyway" path. Deliberate:
  a payroll artifact must never be quietly short. If a CDN-stale read lasts
  past the ~12s retry budget the office waits a minute and retries; the
  message says so. Revisit only with field evidence that the wait itself is
  costing pay.
- **The emailed PDF does not partition subcontractor rows** out of the wages
  sheet (the Xero batch path does). No subcontractor exists in production
  today; when one is onboarded this needs an owner call on what the sheet
  shows for them.
- **Vercel Blob has no origin read for public blobs.** The newer SDK's
  `get({ useCache: false })` bypasses the CDN only for private stores, so a
  stale-CDN window cannot be read around; retry + honest refusal is the
  ceiling until the store is private or hours move to Postgres (#152).

## How to re-check production before changing the guard

Read-only scan (no writes): list every `users/*/time-entries/*.json`, fetch
each, and compare `uploadedAt` (listing) against `__updatedAt` and against
the newest handler stamp. Report the distribution of both gaps and every
record over the skew. Run it whenever the skew, the retry budget or the
settled window is about to change — evidence outranks reasoning here too.
