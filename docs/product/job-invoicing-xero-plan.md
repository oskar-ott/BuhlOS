# Job invoicing into Xero — build plan

**Status: PLAN, approved by the owner 2026-11-22. Written 2026-11-22. This is the plan, not a record of what is built: [../customer-invoices.md](../customer-invoices.md) tracks what has merged. Issues: #1147 (A), #1148 (B), #1149 (C), #1150 (D), #1151 (E), #1152 (F).**

## 1. Context

**The pull (owner, 2026-11-22):** BuhlOS already collects hours per job and
supplier invoices per job. The one thing ServiceM8 still does for the business
is raise customer invoices for a job and push them to Xero. Commercial jobs are
paid in stages over months, so each stage needs its own invoice. The owner wants
to raise those in BuhlOS, land them in Xero, see when they are paid, and see
whether the job is making or losing money. ServiceM8 can then be dropped.

**Owner decisions already made:**

| Question | Answer |
| --- | --- |
| How stage amounts are set | Mixed: some jobs have a schedule agreed up front, some are claimed monthly |
| What lands in Xero | A **draft**. The office approves and emails it from Xero, as now |
| Invoice number in Xero | Job number + stage: `IV3345-1`, `IV3345-2` |
| Retention | Sometimes. Optional per job |
| Where new IV numbers come from | BuhlOS, from the 7000 range (`IV7001` up), so it can run beside ServiceM8 |

**Hypothesis (lean loop, one line for every PR body):** *We believe the office
will raise the next real stage invoice from BuhlOS instead of ServiceM8. We'll
know it's true if one real stage invoice is raised in BuhlOS, approved in Xero
and shown as paid in BuhlOS, without opening ServiceM8.* Rung 2 of the ladder
(a pulled feature), tracked under Epic 8 (#184).

## 2. What exists and what is missing

**Reuse as it is** (all proven live on the Demo Company for payroll):

- Xero login, encrypted token storage, automatic token refresh: `api/_lib/xero/oauth.js`, `token-store.js`, `api/xero/connect.js`, `callback.js`, `status.js`, `disconnect.js`
- The API client `xeroFetch` in `api/_lib/xero/client.js`. It already reaches the Accounting API (`ACCOUNTING_BASE`), handles 401 refresh, short 429 waits, typed errors, and pulls Xero's validation messages out of a 400
- The write pattern in `api/_lib/xero/timesheet-export.js`: record "pending" **before** calling Xero, keep an unchangeable attempt record, read the result back from Xero and compare, never send twice
- The sync log and its health panel: `api/_lib/xero-sync-log.js`, `api/_lib/xero/sync-log-bridge.js`, `XeroSyncHealthPanel`
- The supplier-invoice Postgres pattern: `api/_lib/invoices/store.js` and `supabase/migrations/20260915100000_supplier_invoices.sql`
- The job Money card `src/components/admin/JobMoneyCard.tsx`, the profitability API `api/job-profitability.js`, the PDF report `api/_lib/job-report-pdf.js`

**Missing** (this plan builds it):

- Permission to touch invoices. Today's connection has payroll and read-only settings scopes only
- Any customer-invoice data. The old progress-claims feature was deleted on 2026-07-27. Only three unused number fields are left on the job (`claimedToDate`, `paidToDate`, `oldestClaimDays`); this plan does not use them
- A way to send custom headers from `xeroFetch` (needed for Xero's `Idempotency-Key`)
- Any scheduled check of Xero. No Xero cron exists
- Server-issued IV numbers. Today the office form requires a typed number and the phone works out "next 7000 number" from the worker's own job list only, which can clash

**Facts checked against Xero's documentation on 2026-11-22:**

- Scopes changed in 2026. The scope for invoices is now `accounting.invoices` (the older `accounting.transactions` is deprecated and refused for apps created after 2 March 2026; the BuhlOS Xero app was created in July 2026). Contacts need `accounting.contacts.read`. Accounts, tax rates and organisation are covered by `accounting.settings.read`, which is already granted. Scopes are additive: sending the user through connect again adds the new ones
- `PUT /Invoices` only creates; `POST` creates or updates. Use **PUT** so a send can never overwrite
- A draft needs only `Type`, `Contact.ContactID` and one line. Send **only** `ContactID` in `Contact`; anything else edits the contact in Xero
- `InvoiceNumber` must be unique for sales invoices. Negative lines are allowed (Xero's own example has one), so "less retention" can be a line
- `Url` shows in Xero as "Go to BuhlOS"
- `GET /Invoices?IDs=a,b,c&summaryOnly=true` returns `Status`, `AmountDue`, `AmountPaid`, `AmountCredited`, `FullyPaidOnDate` for many invoices in one call
- A draft can be deleted in Xero (`DELETED`); an approved one can be voided (`VOIDED`)
- `GET /Contacts?searchTerm=…&summaryOnly=true` searches names
- Invoice webhooks exist, but polling is enough at this volume

**Not yet confirmed, must be checked in the proving run (§8):** the exact JSON
envelope Xero accepts on PUT (the payroll run found the docs wrong on this once),
whether an invoice sent without `DueDate` picks up the contact's default terms,
how long an `Idempotency-Key` is remembered, and the deep-link format for opening
an invoice in Xero.

## 3. What the office will see

Everything is on the existing job page, admin tier only. A leading hand never
sees it.

**Job page, Money card, new "Getting paid" section** (hidden while the flag is off):

- Four figures: **Contract · Invoiced · Paid · Still to invoice**. If retention applies: **Retention held**
- A list of stage invoices. Each row: number, title, amount ex GST, a status, and a link to open it in Xero
- Statuses: Planned · Sending · Draft in Xero · Awaiting payment · Part paid · Paid · Overdue · Voided · Deleted in Xero · Couldn't send (with Xero's reason in words)
- **Add stage:** title, amount as dollars *or* % of contract, optional planned date, optional extra lines (e.g. an approved variation). A fixed-schedule job adds all its stages up front; a monthly-claim job adds one each month
- **Send to Xero:** opens a preview of exactly what will be sent (client, number, date, due date, lines, less retention, GST, total, reference). One button, labelled "Send to Xero as a draft". After it lands the row shows Xero's invoice number and totals
- **Client in Xero:** pick the client's Xero contact once per job (search box). Pre-filled from the last job with the same client name
- **Retention:** optional % on the job. Each invoice gets a "Less retention" line. A "Release retention" action raises the held amount later
- **Check Xero now** button, plus "Last checked 12 minutes ago"

**Settings → Xero, new "Invoices" panel:** sales account, GST rate, payment
terms (days). Each is picked from a list read live from Xero. If the connection
lacks invoice permission the panel says "Reconnect to Xero to allow invoices"
with the button.

**Job cost report (PDF):** a new Invoicing section listing each stage invoice
and its paid state.

**New jobs (last part):** the IV field becomes optional. Leave it blank and
BuhlOS issues the next `IV7xxx`. The phone's "Custom" number comes from the
server instead of the phone's own guess.

## 4. Rules the build follows

1. **Xero owns the invoice once it is sent.** BuhlOS drafts it. Approval, emailing, payments, credit notes and statements stay in Xero. BuhlOS shows Xero's figures, never its own guess, for anything already sent (no invented numbers, P7)
2. **Draft only.** BuhlOS never approves, emails, voids or deletes in Xero
3. **A send can never duplicate.** Three independent guards: the row is locked to "sending" before the call; the invoice number is unique in Xero; an `Idempotency-Key` is sent. Before any second attempt BuhlOS first looks the number up in Xero and adopts what it finds
4. **"Sent" means read back and matched.** After Xero accepts, BuhlOS reads the invoice back and compares client, status, lines and subtotal. A mismatch is shown, not hidden
5. **A sent stage is frozen in BuhlOS.** To change it, edit or delete the draft in Xero; BuhlOS picks that up. A stage whose draft was deleted in Xero stays in the list as history, and "Raise again" makes a new stage with the next number (numbers are never reused)
6. **Money is whole cents** in the new tables. Contract value stays where it is on the job (dollars, converted the same way `api/job-profitability.js` already does)
7. **Data kept from Xero is minimal:** contact id + name, account code + name, tax type + name + rate, invoice id, number, status, totals, dates. No addresses, emails, bank details
8. **Audit entries carry no amounts** (the journal is readable below admin tier), matching `invoice.*` verbs today
9. **Dark until proven.** One flag for the whole surface; a second for IV numbering

## 5. Design

### 5.1 Names

User-visible: "Getting paid", "stage invoice". The nav item "Invoices" already
means supplier invoices and keeps that meaning. Internal name everywhere:
`customer-invoices` / `customer_invoices`.

### 5.2 Flags

| Flag | Kind / target | Gates |
| --- | --- | --- |
| `customer_invoices` | launch-gate / admin-tier | The Money-card section, the API, the settings panel, the cron, and the request for invoice scopes at connect |
| `job_code_auto` | launch-gate / global | Server-issued IV numbers on every job-create path |

Expiry about 2027-02-20 (the 90-day convention). Crons use `isFlagOn`, never
`isFlagEnabled` (an admin-tier flag is always false with no viewer).

### 5.3 Database (additive migrations, RLS on with zero policies, `tenant_id` on every table)

The five invoice tables ship together in `20261122100000_customer_invoices.sql` (part B), so parts C–E need no further migration. The two IV-number tables ship in their own migration with part F, which is independent.

- **`customer_invoice_settings`** — one row per tenant + Xero organisation: `sales_account_code`, `sales_account_name`, `tax_type`, `tax_name`, `tax_rate_bp`, `payment_terms_days`, `version`
- **`customer_invoice_job_profiles`** — one row per job (`job_legacy_id`): `xero_contact_id`, `xero_contact_name`, `external_tenant_id`, `retention_bp` (0 = none), `version`
- **`customer_invoices`** — one row per stage:
  - identity: `id`, `job_legacy_id`, `kind` (`stage` | `retention_release`), `sort_order`, `seq` (null until sent; unique per job), `invoice_number` (null until sent; unique per tenant)
  - content: `title`, `basis` (`amount` | `percent`), `percent_bp`, `lines jsonb` (`[{description, amountCents}]`), `gross_cents`, `retention_bp`, `retention_cents`, `net_cents`, `planned_date`, `invoice_date`, `due_date`, `reference`
  - state: `state` (`planned` | `sending` | `sent` | `failed` | `cancelled`), `content_hash`, `version`
  - Xero mirror: `external_tenant_id`, `xero_invoice_id`, `xero_status`, `xero_subtotal_cents`, `xero_tax_cents`, `xero_total_cents`, `xero_amount_due_cents`, `xero_amount_paid_cents`, `xero_amount_credited_cents`, `xero_fully_paid_on`, `xero_updated_at`, `last_checked_at`, `drift jsonb`
- **`customer_invoice_attempts`** — unchangeable (update-refusing trigger, copied from `tg_ts_attempt_immutable`): `invoice_id`, `content_hash`, `request_hash`, `idempotency_key`, `xero_invoice_id`, `correlation_id`, `http_status`, `outcome` (`accepted` | `rejected` | `error` | `blocked` | `adopted`), `error_category`, `error_detail`, actor
- **`customer_invoice_events`** — append-only, **no foreign key to attempts** (the pending event is written before the attempt exists; payroll learned this the hard way): `created`, `edited`, `pending`, `accepted_by_xero`, `verified_against_xero`, `drifted`, `rejected`, `retry_required`, `adopted`, `status_changed`, `cancelled`
- **`job_code_counters`** + **`job_code_claims`** (IV numbering): an atomic `update … set next_value = next_value + 1 returning`, and a unique `(tenant_id, code)` claim row. Postgres, because `jobs.json` has no compare-and-swap and can be read up to a minute stale

Docs to update with the migration: `docs/architecture/supabase-rls-access-matrix.md`, `docs/architecture/data-ownership-map.md`.

### 5.4 Server

New files under `api/_lib/customer-invoices/`:

- `amounts.js` — pure cents maths: % of contract, retention, net, invoiced / paid / still-to-invoice / retention-held totals
- `payload.js` — pure: a stage + job + profile + settings → the Xero body, a content hash, and named blockers ("No client linked in Xero", "No sales account chosen", "Job has no IV number", "Contract value missing for a % stage", "Amount is zero", "Connected to a different Xero organisation than this job's client")
- `store.js` — Postgres store in the shape of `api/_lib/invoices/store.js`, with `expectedVersion` compare-and-swap in the shape of `api/_lib/workshop-stock/store.js`
- `xero-send.js` — send / retry / check, modelled line for line on `runWorkers` and `reconcile` in `api/_lib/xero/timesheet-export.js`
- `xero-status.js` — the poll: batches of 40 ids through `GET /Invoices?IDs=…&summaryOnly=true`, maps `/Date(ms)/` dates, writes the mirror columns and a `status_changed` event when anything moved

The Xero body:

```
PUT {ACCOUNTING_BASE}/Invoices      header  Idempotency-Key: <attempt key>
{ "Invoices": [ {
    "Type": "ACCREC", "Status": "DRAFT", "LineAmountTypes": "Exclusive",
    "Contact": { "ContactID": "<linked contact>" },
    "InvoiceNumber": "IV3345-2", "Reference": "<job code + name, editable>",
    "Date": "YYYY-MM-DD", "DueDate": "YYYY-MM-DD",
    "Url": "<APP_BASE_URL>/v2/jobs/<jobId>",
    "LineItems": [
      { "Description": "...", "Quantity": 1, "UnitAmount": 12000.00, "AccountCode": "200", "TaxType": "OUTPUT" },
      { "Description": "Less retention (5%)", "Quantity": 1, "UnitAmount": -600.00, "AccountCode": "200", "TaxType": "OUTPUT" }
    ] } ] }
```

One handler, `api/customer-invoices.js`, in the shape of `api/invoices.js`
(auth → flag 404 → admin 403 → store 503; `?action=` routing; stable
`{ error: code }`; `withErrorCapture`):

| Call | Does |
| --- | --- |
| `GET ?jobId=` | profile, stages, totals, Xero readiness (connected / right scopes / settings complete) |
| `POST ?action=stage-add` / `stage-edit` / `stage-remove` / `stage-reorder` | planned stages only |
| `PUT ?action=profile` | contact link, retention % |
| `GET ?action=contacts&q=` | live Xero contact search, returns id + name only |
| `GET` / `PUT ?action=settings`, `GET ?action=settings-options` | defaults; options read live from Xero `Accounts` (revenue) and `TaxRates` |
| `POST ?action=preview` | the exact body and blockers; writes nothing |
| `POST ?action=send` | the guarded send |
| `POST ?action=retry` | look up by number first, adopt or re-send |
| `POST ?action=refresh` | poll this job's open invoices now |
| `POST ?action=raise-again` | new stage copied from one deleted or voided in Xero |
| `GET ?action=poll` | cron (`requireCron` + `isFlagOn`), hourly, `maxDuration: 60` |

Changes to existing files:

- `api/_lib/xero/config.js` — add `INVOICE_SCOPES = ['accounting.invoices', 'accounting.contacts.read']`, `hasInvoiceScopes(granted)`, and change `scopesFor({ write })` to `scopesFor({ timesheets, invoices })`
- `api/xero/connect.js` — evaluate `customer_invoices` beside `xero_payroll_export`
- `api/_lib/xero/client.js` — `xeroFetch` accepts `opts.headers` (pass-through to `rawFetch`); guard the unguarded `res.headers.get`
- `api/_lib/xero-sync-log.js` + `src/domains/xero/sync-log.ts` — add `invoice_export` and `invoice_status` to the two mirrored type lists; register retry handlers in a new `api/_lib/customer-invoices/sync-bridge.js`, required from `api/xero-sync-log.js` (handlers only exist in a function that loads the bridge)
- `src/domains/xero/sync-log.ts` — map `XeroError` categories to the operator-text keys. Today only `rate_limit` matches, so most failures show no explanation
- `api/_lib/audit-log.js`, `src/domains/audit-log/schema.ts`, `format.ts`, `audit-log.test.ts` (the four lists, all sorted) — verbs `customer_invoice.stage_added`, `.stage_edited`, `.stage_removed`, `.profile_updated`, `.settings_updated`, `.sent_to_xero`, `.send_retried`, `.raised_again`, and `job.code_issued`; target `customer_invoice`. An unknown verb is dropped silently, so the tests must assert each one lands
- `api/job-profitability.js` — add nullable `customerInvoices: { invoicedCents, paidCents, draftedCents, stillToInvoiceCents, retentionHeldCents, asOf }`; mirror in `src/domains/jobs/profitability-client.ts` with `.nullable().default(null)`
- `api/_lib/job-report-pdf.js` — `input.invoicing` and a `heading('Invoicing')` block after Materials
- `vercel.json` — one cron entry and a `functions` line
- `api/_lib/feature-flags.js` (REGISTRY + FLAG_PRESENTATION), `feature-flags.d.ts`, `docs/feature-flags.md`

### 5.5 Screens

- `src/domains/customer-invoices/schema.ts` + `client.ts` — own zod contract and client (not an extension of `JobSchema`)
- `src/components/admin/customer-invoices/JobGettingPaidSection.tsx` — rendered by `JobMoneyCard` when the server page passes `customerInvoicesEnabled` (resolved in `src/app/v2/jobs/[jobId]/page.tsx` beside `invoicesEnabled`). Fires `JOB_MONEY_CHANGED_EVENT` after any change so the card's figures refresh
- `StageEditor.tsx`, `SendToXeroPreview.tsx` (the `Modal` / `Drawer` primitives), `XeroContactPicker.tsx`
- `src/components/admin/XeroInvoiceSettingsPanel.tsx` on `src/app/(admin)/settings/integrations/xero/page.tsx`
- No new route and no nav entry, so middleware, the nav and the route-ownership guard are untouched. `docs/route-ownership.md` gets one API row
- Lint traps: no `style=` attribute; no function called `confirm`; every user-visible name says BuhlOS

### 5.6 IV numbers

- `api/_lib/job-codes.js` — `issueNextCode(sql, { existingCodes })`: seeds the counter on first use from the highest `IV7xxx` already in `jobs.json` or the claims table (never below 7001), increments atomically, skips any number already on a job, writes the claim
- `api/_lib/job-create.js` `createJob` — when `code` is omitted and `job_code_auto` is on, issue one. This covers the office form, the phone, and the (dark) ServiceM8 sync in one place. The existing format and clash checks stay as a backstop
- If Postgres is unavailable the create fails with a plain message and typing a number still works. A job is never created with a made-up number
- `api/jobs.js` PUT — admin may set `code` **once**, only while it is empty, issuing the next number (for older jobs with none)
- `src/components/admin/NewJobForm.tsx` — IV field optional, with "Leave blank for the next BuhlOS number". After create the issued number is shown large (it gets read out at the wholesaler counter)
- `src/components/phil/PhilNewJobSheet.tsx` + `philNewJobForm.ts` — "Custom" asks the server; `nextFree7000` is retired. This is field-visible, so that PR loads the Phil constitution first, cites P7 (truthful numbers) and P10 (no new slot: the number shows where the code already shows), and is preview-verified
- Supplier-invoice matching (`api/_lib/invoices/iv-match.js`) needs no change: it matches any `IV` + 4 digits

## 6. Every awkward case, and what happens

| Case | Behaviour |
| --- | --- |
| Xero not connected, or connected without invoice permission | Section shows the stages but Send is replaced by "Connect Xero" / "Reconnect to allow invoices" |
| Settings incomplete | Send blocked with a link to the settings panel |
| Job has no client linked | Send blocked; the picker opens |
| Xero rejects the invoice | Row shows "Couldn't send" with Xero's own sentence; an attempt and a sync-log item are recorded; Retry available |
| Network drops after Xero accepted | Row stays "Sending". Retry looks the number up in Xero first and adopts the invoice instead of sending again |
| Two people press Send at once | The second gets "already sending"; one invoice |
| Xero is busy (429 with a long wait) | Marked retry-required and listed on the sync health panel |
| Office edits the draft in Xero | Next check updates BuhlOS to Xero's totals and notes "Changed in Xero" |
| Office deletes the draft in Xero | Row becomes "Deleted in Xero", drops out of the totals, "Raise again" offered |
| Invoice voided in Xero | Row becomes "Voided", drops out of the totals |
| Part payment, credit note | Amount paid, credited and still due come straight from Xero |
| Contract value changes | Unsent % stages recalculate; sent ones do not |
| Stages add up to more than the contract | A plain warning, not a block (variations are real) |
| No contract value | Dollar stages work; % stages are blocked with the reason |
| Xero reconnected to a different organisation | Invoices sent to the old one are labelled and no longer polled; new sends need the client linked again |
| Job finished or closed | Invoicing still works (final claims and retention come late) |
| Postgres unreachable | 503 with a plain message; nothing half-written |

## 7. Build order (six pull requests, each dark, each passing `npm run check:full-ci`)

**Before anything: flag expiries.** Three unrelated flags expire on 2026-11-30
(`supabase_dual_write`, `admin_flags_readout`, `job_materials_spend`). CI goes
red for every PR from 1 December until each is extended with its decision
written in `docs/feature-flags.md`, or removed. This needs the owner's call and
a small PR of its own first.

| PR | Contents | Proves |
| --- | --- | --- |
| **A. Decision record** | `docs/architecture/customer-invoicing-boundary-adr.md` (rules in §4; the payroll ADR only covers timesheets, so the Constitution Gate needs this before an accounting write). `docs/customer-invoices.md` skeleton. Issues filed under Epic 8 in the nine-section format | — |
| **B. Stages, no Xero** | `customer_invoices` flag, the migration, `amounts.js`, `store.js`, handler (stage + profile calls), schema + client, the Getting-paid section with planned stages and Contract / Still to invoice | The schedule is usable on a real job |
| **C. Xero plumbing** | Scopes + connect + reconnect notices, `xeroFetch` headers, contact search and link, settings panel, the sync-log error-text fix (the two invoice sync-log types move to D, so no trace shows on the sync health panel before a send exists) | A reconnect grants the new permission; contacts and accounts read live |
| **D. Send as draft** | `payload.js`, `xero-send.js`, preview / send / retry / raise-again, the preview drawer, row history | A draft lands in the Demo Company and reads back matched |
| **E. Paid status** | `xero-status.js`, cron, refresh, statuses and drift, profitability fields, Money-card figures, PDF section | Approve and pay in the Demo Company; BuhlOS shows it |
| **F. IV numbers** | `job_code_auto` flag, counter tables (their own migration), `job-codes.js`, create paths, set-once on PUT, office and phone forms | Two creates at once get different numbers |

B, C and F do not depend on each other. D needs B and C. E needs D.

**Deliberately not in this plan** (build only when asked for): approving or
emailing from BuhlOS, a list of unpaid invoices across all jobs, overdue items
in "Needs you", credit notes raised from BuhlOS, a variations register, Xero
webhooks, Xero tracking categories per job, attaching a claim PDF.

## 8. Going live

1. Apply the migration to the dev Supabase project, then production. Operator step, owner-approved each time
2. Turn `customer_invoices` on as owner preview. Reconnect to the **Demo Company (AU)**; the consent screen should now list invoices and contacts
3. **Proving run on the Demo Company.** Hard stop before the first PUT: show the owner the exact body, send only on an explicit yes. Then check each of these live, because the payroll run found seven surprises the docs did not predict:
   - the body envelope is accepted; a second PUT with the same key does not create a second invoice
   - sending a number that already exists is refused, and what the message says
   - the read-back shape for a single invoice, and the date format
   - what `DueDate` does when omitted
   - edit, delete, approve, part-pay, pay and void the draft in Xero, running "Check Xero now" after each
   - the "Go to BuhlOS" link in Xero, and the link from BuhlOS into Xero
   - a retention line, and a retention release
4. The owner connects the **real** organisation (only the owner can log in to Xero), picks the sales account, GST rate and terms
5. First real stage invoice on a real job at its next claim date. It lands as a draft, so it is reviewed in Xero before the client sees anything
6. Review at the Tuesday closeout: keep, adjust, or hide the flag again
7. After merge: wiki sync (API-and-Integration-Map, a new Job-invoicing page)

Open checks before step 4: whether the Supabase project has point-in-time
recovery (the credential ADR asks for it before irreplaceable money rows; planned
stages exist only in BuhlOS), and that the Demo Company has not reset (it does
about every 28 days).

## 9. How each part is verified

- **Pure maths and payload:** unit tests in `src/domains/customer-invoices/` — % and retention rounding to the cent, totals, every blocker, hash stability
- **Send service:** fake SQL + fake `xeroFetch`, copied from `src/domains/xero/xero-timesheet-export.test.ts` — pending-before-PUT order, accepted then verified, rejected with reason, timeout then adopt-by-number (never a second PUT), concurrent send, read-back mismatch → drifted
- **Poll:** fake responses for every status, deleted and voided, part-paid, batch splitting, wrong-organisation skip
- **Handler:** copied from `src/domains/invoices/invoices-api.test.ts` — flag off → 404 on every path, no session → 401, leading hand → 403, cron with and without the secret, cron with the flag off → skipped
- **Client:** `xero-client.test.ts` gains header pass-through; `sync-log.test.ts` mirror pin gains the two types
- **Screens:** `*.render.test.tsx` for the section (every status), the preview, the settings panel, flag-dark states
- **Audit:** each new verb asserted present in the journal (silent drop otherwise)
- **IV numbers:** counter seeding, skip-existing, concurrent issue against a real local Postgres (the `INVOICES_PG_TEST=1` style)
- **End to end, locally:** the workshop-stock harness recipe (`scripts/qa/workshop-stock-e2e/harness.js`): the real handler against an embedded Postgres with a stub Xero, beside `next dev`. Preview deployments cannot reach Postgres and may share the production Blob store, so no write testing on a preview
- **Live:** the proving run in §8
- **Every PR:** `npm run check:full-ci`, plus a full `tsc` after editing tests
