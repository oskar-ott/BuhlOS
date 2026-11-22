# Customer stage invoices (job invoicing into Xero)

**What this is:** raising a job's stage invoices in BuhlOS, landing each one in
Xero as a draft, and showing on the job what has been invoiced and paid.

**Governing documents:**
[architecture/customer-invoicing-boundary-adr.md](architecture/customer-invoicing-boundary-adr.md)
(the rules) · [product/job-invoicing-xero-plan.md](product/job-invoicing-xero-plan.md)
(the build plan).

**Not the same as** [invoice-capture.md](invoice-capture.md), which reads
*supplier* invoices coming in. The office nav item "Invoices" means supplier
invoices and keeps that meaning. This feature is called "Getting paid" on the
job page.

## Status

| Part | Issue | State |
| --- | --- | --- |
| Boundary record | [#1147](https://github.com/oskar-ott/BuhlOS/issues/1147) | Written |
| Stages on the job page, no Xero | [#1148](https://github.com/oskar-ott/BuhlOS/issues/1148) | **Built, dark** behind `customer_invoices`. Never used on a real job |
| Invoice permissions, client link, defaults | [#1149](https://github.com/oskar-ott/BuhlOS/issues/1149) | **Built, dark** behind `customer_invoices`. Proven against a stand-in for Xero only — **never run against real Xero** |
| Send to Xero as a draft | [#1150](https://github.com/oskar-ott/BuhlOS/issues/1150) | **Built, dark** behind `customer_invoices`. Proven against a stand-in for Xero only — **never run against real Xero**. The proving run on the Demo Company (plan §8) is still owed, with a hard stop before the first create |
| Invoiced and paid on the job | [#1151](https://github.com/oskar-ott/BuhlOS/issues/1151) | **Built, dark** behind `customer_invoices`. Reads only. Proven against a stand-in for Xero only — **never run against real Xero** |
| BuhlOS-issued IV numbers | [#1152](https://github.com/oskar-ott/BuhlOS/issues/1152) | **Built, dark** behind its own flag, `job_code_auto`. Starts at IV4000. See [job-numbers.md](job-numbers.md) |

Each part updates its own row, and adds its section below, in the PR that
builds it. Nothing in this document describes behaviour that is not merged.

## The pull and the hypothesis

Owner pull, 2026-11-22: creating job invoices and pushing them to Xero is the
last thing ServiceM8 does for the business.

*We believe the office will raise the next real stage invoice from BuhlOS
instead of ServiceM8. We'll know it's true if one real stage invoice is raised
in BuhlOS, approved in Xero and shown as paid in BuhlOS, without opening
ServiceM8.*

## What is built: the stage schedule (#1148)

The schedule itself never calls Xero. A planned stage is sent to Xero from the
same card (see "the send" below); the Xero set-up (#1149) only *reads*. What
has been approved and paid comes back from Xero (see "invoiced and paid"
below).

### On the job page

`/v2/jobs/[jobId]`, directly under the Money card, admin tier only, rendered
only while `customer_invoices` is on for the viewer:

- **Contract · Planned · Sent to Xero · Still to invoice.** Contract is the
  job's existing contract value (edited on the Money card). Planned is the
  gross of the stages not yet in Xero. Sent to Xero is the gross of the stages
  that are (before retention). Still to invoice is contract less what has been
  sent, with "$X not yet planned" beneath.
- **Stages.** Each is a name, an amount as dollars *or* a % of the contract,
  optional extra lines (e.g. an approved variation), and an optional date it is
  expected to be invoiced. A fixed schedule is all its stages added up front; a
  monthly claim is one stage added each month.
- **Retention.** An optional % per job. Each stage shows its gross, the
  retention taken off, and what would be invoiced.
- Planned stages can be edited and removed. A removed planned stage is deleted
  (it was never sent); a job-level event records that it existed.

Honesty rules the card keeps:

- A figure that cannot be worked out is a dash with the reason, never `$0`. A
  % stage on a job with no contract value reads "needs a contract value".
- Planned stages adding up past the contract is a warning, not a block.
- A failed read says so and offers a retry. Only a 401/403/404 hides the card.

### API

`api/customer-invoices.js`. Session required; `404` while the flag is off for
the viewer (so below the admin tier it is invisible); `403` behind that as
defence in depth; `503 store_unavailable` / `store_unprovisioned` when Postgres
cannot be reached or has no tenant row.

| Call | Does |
| --- | --- |
| `GET ?jobId=` | the job's profile, stages (each with what it works out to and its display status) and totals |
| `POST ?action=stage-add` `{ jobId, stage }` | add a planned stage |
| `POST ?action=stage-edit&id=` `{ stage, expectedVersion }` | replace a planned stage's content |
| `POST ?action=stage-remove&id=` `{ expectedVersion }` | remove a planned stage |
| `PUT ?action=profile` `{ jobId, retentionBp, expectedVersion }` | set the job's retention % |

Every mutation is validated (zod, unknown fields refused), is a
compare-and-swap on the row's `version` (`409 stale_version` when someone else
saved first; `409 stage_not_editable` once a stage has left `planned`), writes
a per-invoice event and an audit entry (`customer_invoice.stage_added`,
`.stage_edited`, `.stage_removed`, `.profile_updated`; never an amount), and
answers with the job's whole refreshed payload.

Money is integer cents. Percentages are basis points (500 = 5%). Rounding is
half-up to the cent, in integer arithmetic
(`api/_lib/customer-invoices/amounts.js` `portionCents`).

### Data

Postgres, migration `20261122100000_customer_invoices.sql`: five tables, RLS
on with zero policies. That migration already carries the columns and tables
the send (#1150) and the paid status (#1151) use. The paid status adds one
column in a second, small migration,
`20261123100000_customer_invoices_replaced_by.sql`. See the
[RLS matrix](architecture/supabase-rls-access-matrix.md).

Nothing is stored on the job record or in Blob, so `jobs.json`,
`jobs-summary.json` and the backup manifest are untouched.

### Turning it on

1. Apply `20261122100000_customer_invoices.sql`, then
   `20261123100000_customer_invoices_replaced_by.sql`, to the dev Supabase
   project, then production. An operator step, owner-approved each time.
2. In the Owner Console, set **Customer stage invoices** to owner preview (or
   Live for the office).
3. Open any job. "Getting paid" appears under the Money card.

Without step 1 the card shows "The invoice records can't be reached right
now" rather than failing silently.

Preview deployments cannot reach Postgres, so this cannot be exercised on a
Vercel preview.

## What is built: the Xero set-up (#1149)

Everything an invoice needs to know before it can be sent. **Every Xero call
here is a GET.** It has been proven end to end against a stand-in for Xero's
API (real token store, real shared client, real handler, real local Postgres)
— not against Xero itself. The first real run is the proving run in the build
plan (§8).

### Permission

While `customer_invoices` is on for the connecting admin, `/api/xero/connect`
also asks Xero for `accounting.invoices` and `accounting.contacts.read`. These
are Xero's 2026 granular scopes; the older `accounting.transactions` is
deprecated and refused for newer apps. A default connect is unchanged, and the
payroll write scope stays independent (`xero_payroll_export`).

A connection made before the flag was on does not have them. BuhlOS detects
that **from the stored connection, before calling Xero**, and every dependent
surface says "Xero is connected, but without permission for invoices" with a
Reconnect button. Reconnecting adds the new permission to the ones already
granted.

### Where a job stands with Xero

`GET /api/customer-invoices?jobId=` now carries `xero`:

| Field | Meaning |
| --- | --- |
| `state` | `connected` · `missing_permission` · `reconnect_required` · `connecting` · `disconnected` · `not_configured` · `unavailable` (the connection couldn't be read; the schedule still loads) |
| `organisationName` | the connected Xero organisation |
| `settingsComplete` | sales account, tax rate and payment terms are all chosen for that organisation |
| `client.linked` / `client.name` | the job's client is linked to a Xero contact; the name is Xero's |
| `client.otherOrganisation` | the link was made while a different organisation was connected |
| `client.suggestion` | the contact another job with the same client name uses — offered, never applied |

No Xero call is made to answer this.

### The job's client

On the Getting paid card, under the retention line:

- **Link client** opens a search of the connected organisation's contacts,
  starting from the job's client name. Results are id and name only; archived
  contacts are left out. Nothing is cached.
- Picking one stores the contact id, **Xero's own name for it** (the server
  re-reads the contact; a name sent by the browser is refused) and the
  organisation it belongs to.
- If another job with the same client name is already linked, that contact is
  offered as "Use this contact". A person still applies it.
- A new client is added in Xero, not here. BuhlOS never creates or edits a
  contact.
- If Xero is later connected to a different organisation, the link is flagged
  and must be made again.

### Invoice defaults

`/settings/integrations/xero` gains an **Invoices** panel (rendered only while
`customer_invoices` and `xero_connection` are both on):

- **Sales account** — active revenue accounts that have a code
- **Tax rate** — active rates usable on sales, with Xero's own percentage
- **Payment terms** — whole days, 0–365; an invoice's due date is its date plus this

The two lists are read live from Xero when the panel opens. On save the server
reads them again, refuses a choice Xero no longer offers, and stores Xero's
names and rate. Defaults belong to one Xero organisation; another organisation
starts empty. A saved choice that has since been archived in Xero stays visible
and is labelled as gone.

### API added

| Call | Does |
| --- | --- |
| `GET ?action=contacts&q=` | live contact search → `[{ id, name }]`; fewer than 2 letters answers empty without calling Xero |
| `PUT ?action=contact-link` `{ jobId, contactId, expectedVersion }` | link; `404 contact_not_found`, `409 contact_not_active` |
| `PUT ?action=contact-unlink` `{ jobId, expectedVersion }` | remove the link (retention is kept) |
| `GET ?action=settings` | readiness + the saved defaults for the connected organisation |
| `GET ?action=settings-options` | live: `{ accounts, taxRates }` |
| `PUT ?action=settings` `{ salesAccountCode, taxType, paymentTermsDays, expectedVersion }` | save; `409 account_not_in_xero` / `tax_rate_not_in_xero` |

A Xero failure answers `{ error: "xero_<category>" }`: `409` when not
connected or a reconnect is needed (with `reason: "missing_invoice_scope"` for
the permission case), `429` when Xero is rate-limiting, `502` otherwise. Never
the exception text.

Audit: `customer_invoice.profile_updated` for a link or unlink,
`customer_invoice.settings_updated` for the defaults.

### Shared Xero code changed

- `api/_lib/xero/config.js` — `INVOICE_SCOPES`, `hasInvoiceScopes()`,
  `scopesFor({ timesheets, invoices })` (`write` still works as the old name
  for `timesheets`)
- `api/_lib/xero/client.js` — `xeroFetch` accepts `headers` (for the
  `Idempotency-Key` the send will need). The connection's own headers
  (token, tenant, content negotiation) cannot be overridden, and a retried
  request resends the same headers and body
- `src/domains/xero/sync-log.ts` — `taxonomyFor()` now finds the raw
  categories the client throws (`validation`, `auth`, `server`, …). Before,
  only `rate_limit` matched, so most payroll sync failures showed no
  explanation on the sync health panel

The `invoice_export` / `invoice_status` sync-log types are not added by this
part: the sync health panel lists every type, so adding them here would show
"Invoice send: last success never" to anyone with the Xero connection on.
`invoice_export` arrives with the send (#1150) and `invoice_status` with the
paid status (#1151), and each shows on the panel only once it has been used.

### Turning it on

As for the schedule, plus: `xero_connection` on, then **Reconnect** Xero from
`/settings/integrations/xero` so the invoice permission is granted, then
choose the three defaults in the Invoices panel.

## What is built: the send (#1150)

**The one write to Xero.** "Send to Xero" on a planned stage creates a
**draft** sales invoice. BuhlOS never approves, emails, edits, voids or
deletes an invoice in Xero, and has no route that could (ADR rule 2).

It has been proven end to end against a stand-in for Xero's API (real token
store, shared client, send service, handler, sync log and local Postgres) —
**not against Xero itself**. Before any real use: the proving run on the Demo
Company (plan §8), stopping for the owner's yes before the first create.

### What the office sees

- **Send to Xero** appears on a planned stage once the job is ready: Xero
  connected with invoice permission, the three defaults chosen, the client
  linked in the connected organisation, and the job has an IV number.
- It opens a **preview of exactly what will be created**: who it goes to, the
  invoice number, date, due date, account and tax, every line, the retention
  taken off, the subtotal, and the GST and total Xero is *expected* to add
  (labelled an estimate). The date and the reference can be changed. Anything
  stopping the send is named with what fixes it, and the button is not offered.
- The button says what it does: **Send to Xero as a draft**.
- A sent row shows its number, **Xero's** subtotal, GST and total (labelled as
  Xero's), its dates, the retention held, and **Open in Xero**. It can no
  longer be edited or removed here.
- **Retention held so far** shows once any sent stage held some back, with
  **Release retention**: that adds a planned release stage, sent like any other
  (one line, nothing taken off).

### The invoice BuhlOS creates

`PUT {ACCOUNTING_BASE}/Invoices` (create-only; never the create-or-update
`POST`) with header `Idempotency-Key`:

| Field | Value |
| --- | --- |
| `Type` / `Status` | `ACCREC` / `DRAFT` — always |
| `Contact` | `{ ContactID }` only, so the contact can't be edited as a side effect |
| `InvoiceNumber` | `<job code>-<n>`, e.g. `IV3345-2`; `n` counts the job's stages in the order they are **sent** |
| `Reference` | job code + job name, or what the office typed (e.g. a PO or claim number) |
| `Date` / `DueDate` | the send date (Sydney) or the one chosen; date + payment terms |
| `LineAmountTypes` | `Exclusive` — amounts are ex GST, Xero works out the tax |
| `LineItems` | the stage (worded "… (20% of contract)" for a % stage, with the job and site), each extra line, then `Less retention (5%)` as a **negative** line; all on the default account and tax rate |
| `Url` | the job's page — shows in Xero as "Go to BuhlOS" |

### It can never go twice

Three independent guards, plus a rule for retries:

1. **The claim.** Before Xero is called the row moves `planned → sending` in
   one guarded transaction that also allocates the number (serialised per job
   by an advisory lock; the unique indexes are the backstop). A second request
   loses here and never reaches Xero.
2. **The number** is unique in Xero for sales invoices.
3. **The `Idempotency-Key`** is derived from the stage and its exact body, so
   the same request replays instead of creating again.
4. **Any second attempt looks the number up first** (`GET
   /Invoices?InvoiceNumbers=`) and adopts what it finds.

### "Sent" means read back and matched

The `pending` event is written **before** the call. Each call to Xero is one
immutable attempt row with its outcome. After Xero accepts, the invoice is read
back and compared (type, number, contact, draft status, subtotal, line
amounts). A mismatch — or a read-back that fails — still records the invoice
(it exists) with the difference named on the row: "What is in Xero doesn't
match what BuhlOS sent." Xero's figures are the ones stored and shown.

### When it doesn't land

| What happened | The stage | What the office is offered |
| --- | --- | --- |
| Xero refused it (bad account, etc.) | `failed`, with **Xero's own sentence** | **Try again** (after fixing the cause — a retry uses the current account and tax defaults) · **Edit and resend** |
| Xero was busy, or the connection needs a reconnect | `failed`; nothing was created | **Try again** |
| **No answer** (timeout, network, 5xx, or a 200 with no invoice) | stays `sending`: "BuhlOS didn't hear back from Xero, so this invoice may or may not be there." | **Check Xero** — a look-up. Found and ours → adopted, nothing sent twice. Not there → sent again with the same idempotency key |
| The number is already used in Xero by something else (or by ours, since deleted or voided) | `failed` as number taken | **Use the next number** — the stage is cancelled *keeping* its number, and a planned copy takes the next one |

- **Edit and resend** puts the stage back to planned (its number released, its
  frozen figures cleared) **only after Xero confirms it holds nothing under
  the number**. If Xero has the invoice after all, it is adopted instead.
- A retry sends the **frozen** amounts: a contract value changed since the
  first attempt does not change the invoice.
- A stage claimed while one Xero organisation was connected can only be
  resolved against that organisation.
- Every outcome is recorded on the Xero sync log as `invoice_export`
  (operation `inv:<stage id>`), so a failed or unconfirmed send shows on the
  sync health panel, whose **Retry** travels the same look-up-first path. The
  panel shows a "Stage invoices" line only once something has been recorded.

### API added

| Call | Does |
| --- | --- |
| `POST ?action=preview&id=` `{ invoiceDate?, reference? }` | what would be sent + every blocker; writes nothing, calls Xero for nothing |
| `POST ?action=send&id=` `{ expectedVersion, invoiceDate?, reference? }` | the send. `409 { error: "blocked", blockers }` when it can't go |
| `POST ?action=retry&id=` | look up, then adopt or send again |
| `POST ?action=reset&id=` | back to planned once Xero confirms nothing is there |
| `POST ?action=raise-again&id=` | only for a number-taken stage: burn the number, add a planned copy |
| `POST ?action=retention-release` `{ jobId, amountCents, title? }` | a planned release stage; `409 exceeds_retention_held` |

`send` / `retry` / `reset` answer the job's refreshed payload plus `send: {
outcome, invoiceNumber, verified, mismatches, category, detail }` — outcome
`sent` · `adopted` · `failed` · `unknown` · `reset`.

Audit: `customer_invoice.sent_to_xero`, `.send_failed`, `.send_retried`,
`.send_reset`, `.raised_again` — with the invoice number, never an amount.

### Not yet confirmed against real Xero

To check in the proving run, because the payroll run found the documentation
wrong more than once:

- the request envelope `{ "Invoices": [ … ] }` on `PUT` is accepted
- the wording of the duplicate-number refusal (the code looks for "must be
  unique" / "already exists")
- how long an `Idempotency-Key` is honoured, and that a replay returns the
  first invoice
- whether `GET /Invoices?InvoiceNumbers=` returns deleted and voided invoices
- the "Open in Xero" link format
  (`go.xero.com/AccountsReceivable/View.aspx?InvoiceID=…`)
- that "Go to BuhlOS" appears in Xero from `Url`

## What is built: invoiced and paid (#1151)

After a stage is sent, the office approves it, emails it and records the
payment **in Xero**. BuhlOS asks Xero what happened and shows it on the job.
**Every Xero call here is a GET.** Proven end to end against a stand-in for
Xero's API (real token store, shared client, status service, handler, sync log
and local Postgres) — **not against Xero itself**.

### What the office sees

On the Getting paid card, once anything has been sent:

- **Approved in Xero · Paid · Owing.** Approved is ex GST and counts invoices
  the office has approved; drafts are named beside it, not added in. Paid and
  Owing are GST-inclusive, exactly as Xero reports them (Paid also shows its
  ex-GST share). Owing says how many are overdue.
- "These are Xero's figures, last checked 12 minutes ago. BuhlOS checks every
  hour." with **Check Xero now**, which asks straight away and says what it
  found.
- Each sent row shows Xero's status: **Draft in Xero · Awaiting payment · Part
  paid · Paid · Overdue · Voided · Deleted in Xero**, with what has been paid
  and what is owing, or "Paid in full on …". The due date is Xero's, so a due
  date changed in Xero is the one shown.
- **Changed in Xero.** If the office edits the invoice in Xero, BuhlOS shows
  Xero's figures and says "This invoice has been changed in Xero since BuhlOS
  sent it." Putting it back clears the note.
- **Deleted or voided in Xero.** The row stays as history, struck through, and
  drops out of every total, so the amount is back in Still to invoice. **Raise
  again** adds a planned copy; sending it takes the *next* number. The old
  number is never reused. It can be raised again once (removing the planned
  copy allows it again).
- If Xero has nothing at all under the stored id, the last figures Xero gave
  are kept and the row says so. No status is invented.

On the **Money card**: "Money in: $X invoiced · $Y paid · $Z owing", and
**Cash so far** = paid (ex GST) less labour and materials to date. The
contract margin above it is unchanged. Cash so far names uncosted labour when
there is some, and is left out (with the reason) when a paid amount can't be
split into ex GST. The **job report PDF** gains an Invoicing section with each
sent invoice and the same totals.

When the invoice records can't be read, both say so. That is never shown as
nothing invoiced.

### How it keeps up

- **Hourly**, `GET /api/customer-invoices?action=poll` (`vercel.json`, minute
  5; `CRON_SECRET`; a no-op while the flag is off, checked with `isFlagOn`
  because a cron has no viewer). It asks about every sent invoice in the
  connected organisation that is not settled: drafts and approved invoices
  every hour, a paid invoice once a day for 60 days after payment (a payment
  can be removed), a voided or deleted one never. Oldest check first, 40 ids
  per request (`GET /Invoices?IDs=`), stopping cleanly at 45 seconds with the
  rest left for the next run.
- **Check Xero now** asks about every sent invoice on that one job, whatever
  its status.
- An invoice the list answer leaves out is asked for on its own before
  anything is concluded.
- A failed read **changes nothing**. The figures stay as they were, with their
  age shown. The hourly check answers `200 { ok: false, error }` and records
  one open item on the Xero sync log (`invoice_status`, operation
  `invstatus:poll`); the next good run closes it. The sync health panel's
  **Retry** runs the check again. The panel shows "Invoice payment checks"
  only once a check has been recorded.
- When Xero is not connected, or the invoice permission is missing, the hourly
  check is skipped with the reason. That is not a failure and is not logged;
  the connection panel already says it.

### What counts as what

| Xero says | BuhlOS shows | In the job's totals |
| --- | --- | --- |
| `DRAFT`, `SUBMITTED` | Draft in Xero | Sent to Xero; "still a draft" |
| `AUTHORISED`, nothing paid, not past due | Awaiting payment | Approved; Owing |
| `AUTHORISED`, some paid | Part paid | Approved; Paid; Owing |
| `AUTHORISED`, money owing, past Xero's due date (Sydney date) | Overdue | as above, counted overdue |
| `PAID` | Paid | Approved; Paid |
| `VOIDED`, `DELETED` | Voided / Deleted in Xero | none |

Paid is Xero's `AmountPaid`. A credit note applied in Xero lowers Owing but is
not counted as money paid.

### API added

| Call | Does |
| --- | --- |
| `POST ?action=refresh` `{ jobId }` | Check Xero now. Answers the job's refreshed payload plus `refresh: { checked, changed, notFound }`. `409` / `502` `xero_<category>` when Xero can't be read |
| `GET ?action=poll` | the hourly check. Cron only: `401` without the secret, `503` in production with none configured. `{ skipped: "flag_off" }` while dark |
| `POST ?action=raise-again&id=` | now also for a sent stage Xero shows deleted or voided |

The job payload gains `statusAsOf` (the oldest check among its sent invoices),
`totals.draftedCents / invoicedCents / paidCents / paidIncGstCents /
dueIncGstCents`, and per stage `xeroAmountPaidCents`, `xeroAmountDueCents`,
`xeroDueDate`, `xeroFullyPaidOn`, `lastCheckedAt`, `canRaiseAgain`,
`replacedById`. `GET /api/job-profitability` gains `customerInvoices` (null
while the flag is off for the viewer).

Audit: `customer_invoice.status_checked` when a person presses Check Xero now
(counts only, never an amount). The hourly check is not a person's action and
is not journalled; each change it finds is a `status_changed` event on the
invoice.

### Data

`20261123100000_customer_invoices_replaced_by.sql` adds one column,
`customer_invoices.replaced_by_id` (the planned stage a deleted or voided
invoice was raised again as). Everything else the check writes was already in
the first migration.

### Not yet confirmed against real Xero

- `GET /Invoices?IDs=` with 40 ids, and that it returns amounts and dates
  without `summaryOnly` (the check deliberately does not send `summaryOnly`)
- whether that list returns deleted and voided invoices (the single read
  covers it if not)
- the shape of `FullyPaidOnDate`
- that an unknown invoice id answers 404

## Testing

| What | Where |
| --- | --- |
| The status check against a stand-in Xero in which the test plays the office: approve, pay, edit, void, delete, vanish, Xero down | `src/domains/customer-invoices/xero-status.test.ts` |
| Check Xero now, the hourly check (cron gate, flag off, sync log + its Retry) and raising a dead invoice again | `src/domains/customer-invoices/customer-invoices-status-api.test.ts` |
| Every row state after a send, the money-in strip, the Money card line | `src/components/admin/customer-invoices/paid-status.render.test.tsx` |
| Which invoices the hourly check asks about; mirror writes; raise again (local Postgres, skipped in CI) | `src/domains/customer-invoices/customer-invoices-status.pg.test.ts` |
| Money in on the Money card and the job report | `src/domains/jobs/job-profitability-api.test.ts`, `job-report-pdf.test.ts` |
| What goes to Xero and what must come back: blockers, lines, body, hashes, read-back compare | `src/domains/customer-invoices/payload.test.ts` |
| The send service against a stand-in Xero that times out, refuses and loses answers — "never two invoices" | `src/domains/customer-invoices/xero-send.test.ts` |
| The send routes: gating, double press, outcomes, sync log + its Retry, reset, raise again, retention release | `src/domains/customer-invoices/customer-invoices-send-api.test.ts` |
| The preview and every row state | `src/components/admin/customer-invoices/send.render.test.tsx` |
| The send's SQL incl. real concurrent claims (local Postgres, skipped in CI) | `src/domains/customer-invoices/customer-invoices-send.pg.test.ts` |
| Readiness, contact / account / tax mappers (data minimisation), error text | `src/domains/customer-invoices/xero-lookups.test.ts` |
| The Xero routes: gating, readiness, search, link, defaults, audit | `src/domains/customer-invoices/customer-invoices-xero-api.test.ts` |
| Client line, contact picker, Invoices panel — every state | `src/components/admin/customer-invoices/xero-setup.render.test.tsx` |
| Scopes at connect; caller headers on the shared client | `src/domains/xero/xero-oauth.test.ts`, `xero-client.test.ts` |
| Settings and suggestion SQL (local Postgres, skipped in CI) | `src/domains/customer-invoices/customer-invoices-settings.pg.test.ts` |
| Money maths and the display status | `src/domains/customer-invoices/amounts.test.ts` |
| Typing boundary (dollars → cents, % → basis points), labels, error words | `src/domains/customer-invoices/format.test.ts` |
| The handler: gating, validation, totals, conflicts, audit journal | `src/domains/customer-invoices/customer-invoices-api.test.ts` |
| The card and the stage editor, every state | `src/components/admin/customer-invoices/getting-paid.render.test.tsx` |
| The real SQL and the migration's constraints | `src/domains/customer-invoices/customer-invoices-store.pg.test.ts` |

The `.pg.test.ts` files run only against a throwaway local Postgres and are
skipped in CI. For example:

```
CUSTOMER_INVOICES_PG_TEST=1 SUPABASE_ENV=local SUPABASE_PROJECT_REF=localstack \
SUPABASE_DB_URL=postgres://…@localhost:<port>/<db> \
  npx vitest run src/domains/customer-invoices/customer-invoices-store.pg.test.ts
```

The database needs every file in `supabase/migrations` applied in order and a
`buhl` row in `public.tenants`. Before the migrations, create an `auth` schema
with `auth.jwt()` and `auth.uid()` and the roles `anon`, `authenticated` and
`service_role` (the same recipe as the workshop-stock store test).
