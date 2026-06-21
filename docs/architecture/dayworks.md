# Daywork register (#370)

> Status: **domain foundation + admin API + read-only register, real.** Schema +
> types + pure logic ([`src/domains/dayworks/`](../../src/domains/dayworks/)), the
> server endpoint [`api/dayworks.js`](../../api/dayworks.js) (job-scoped +
> cross-job rollup, tier-gated on `assignedJobIds`), and the read-only admin
> register pages (`/v2/jobs/[jobId]/dayworks` + the cross-job `/v2/dayworks`
> rollup, loaded by [`src/server/dayworks/register.ts`](../../src/server/dayworks/register.ts))
> are shipped. The **on-glass drawn signature** and the **Phil docket-create UI**
> remain follow-ups (see §Deferred); a typed supervisor name signs today.

## Why

Daywork is the most perishable money in construction. 100 Arthur St's terms
require day-labour sheets signed DAILY by the builder's supervisor — unsigned
dockets age into disputed invoices ("we never authorised that"). The product
had nothing: no docket, no signature, no register, no payment-risk view. This
foundation models the docket and the rules that protect the money.

## Model

A **`Daywork`** docket lives per job (proposed `jobs/<jobId>/dayworks.json`):
description, labour lines (worker × hours), material lines, photos, a sequential
`ref` (`DW-001`…), a `status` (`unsigned → signed → invoiced`), an optional
`signature`, a manual `invoiceRef`, and amendment lineage. Hard rules:

- **Unsigned saves freely** — a docket without a signature is `unsigned`, never
  blocked, never faked. No signature image is ever synthesised.
- **Sequential refs are gap-safe** — `nextDayworkSeq` mints `max(seq) + 1`, not
  array length, so a deleted docket never lets a later one reuse its ref.
- **Forward-only pipeline** — `canTransition` allows create → unsigned → signed
  → invoiced; there is no un-signing.
- **Unsigned-aging is payment risk** — `isUnsignedAging` flags an unsigned
  docket older than 24h (injected `nowMs`, deterministic). Signed dockets never
  age.
- **Signed/invoiced is immutable** — `isImmutable`; changes go through a linked
  amendment (`buildAmendmentSeed` back-links `amendmentOfId`, resets to
  `unsigned`, drops the signature; the original is never mutated).
- **Commercial, not payroll** — `linkedTimeEntryIds` is a one-way
  cross-reference; nothing in this domain writes to time-entries. The production
  hours loop is untouched.

## Pure helpers

[`service.ts`](../../src/domains/dayworks/service.ts): `nextDayworkSeq`,
`formatDayworkRef`, `canTransition`, `dayworkAgeMs`, `isUnsignedAging`,
`isImmutable`, `assertAmendmentAllowed`, `buildAmendmentSeed`,
`compareForRegister` (unsigned-aging first), `summariseRegister`. 23 tests.

## Deferred (follow-ups)

- **Admin API + register** — ✅ SHIPPED. `api/dayworks.js` (job-scoped GET/POST +
  sign/invoice/amend PATCH + cross-job rollup, tier-gated on `assignedJobIds`,
  audit on create/sign/status-change/amend) and the read-only register pages
  (`/v2/jobs/[jobId]/dayworks` + the cross-job `/v2/dayworks`, sidebar "Dayworks";
  loader `src/server/dayworks/register.ts`). `api/*.js` is preview-only-verifiable
  (render-tested presenters + API/loader unit tests cover the logic).
- **Job attention surface count** — the unsigned-aging count is on the register
  + rollup, but NOT yet wired into the job-hub attention surface
  (`/v2/jobs/[jobId]`); deferred to avoid colliding with the in-flight job-hub
  work (#366).
- **On-glass drawn signature** — build ONCE, coordinated with the signature
  platform (#328) / ITP completion signatures (#295). The `DayworkSignature`
  shape and the sign transition are modelled here; the canvas capture is the
  follow-on. Until then a signed docket is one with a typed supervisor name +
  server stamps — never a faked image.
- **Phil docket-create UI** — gated by the #132 job-screen review wave. The API
  already accepts field-tier creates on assigned jobs, so the Phil entry is a
  front-end follow-on once the freeze clears.
- **Invoice / Xero** — `invoiceRef` is manual; no integration (Xero is Epic 8).
