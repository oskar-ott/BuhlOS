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
| Send to Xero as a draft | [#1150](https://github.com/oskar-ott/BuhlOS/issues/1150) | **Planned, not built** |
| Invoiced and paid on the job | [#1151](https://github.com/oskar-ott/BuhlOS/issues/1151) | **Planned, not built** |
| BuhlOS-issued IV numbers | [#1152](https://github.com/oskar-ott/BuhlOS/issues/1152) | **Planned, not built** |

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

**Nothing is sent to Xero by this feature yet.** The card says so on screen
("This is the plan only. Nothing is sent to Xero from here yet.") and shows no
Send button, no Invoiced and no Paid figure. The Xero set-up below (#1149)
only *reads* from Xero.

### On the job page

`/v2/jobs/[jobId]`, directly under the Money card, admin tier only, rendered
only while `customer_invoices` is on for the viewer:

- **Contract · Planned · Still to invoice.** Contract is the job's existing
  contract value (edited on the Money card). Planned is the gross of the
  planned stages. Still to invoice is contract less what has been *sent*
  (nothing can be sent yet, so today it equals the contract), with "$X not yet
  planned" beneath.
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
on with zero policies. The migration already carries the columns and tables the
send (#1150) and the paid status (#1151) will use, so those parts need no
second migration; nothing writes them yet. See the
[RLS matrix](architecture/supabase-rls-access-matrix.md).

Nothing is stored on the job record or in Blob, so `jobs.json`,
`jobs-summary.json` and the backup manifest are untouched.

### Turning it on

1. Apply `20261122100000_customer_invoices.sql` to the dev Supabase project,
   then production. An operator step, owner-approved each time.
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

The `invoice_export` / `invoice_status` sync-log types are **not** added yet:
the sync health panel lists every type, so adding them now would show
"Invoice send: last success never" to anyone with the Xero connection on. They
arrive with the send (#1150).

### Turning it on

As for the schedule, plus: `xero_connection` on, then **Reconnect** Xero from
`/settings/integrations/xero` so the invoice permission is granted, then
choose the three defaults in the Invoices panel.

## Testing (schedule and Xero set-up)

| What | Where |
| --- | --- |
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

The last one runs only against a throwaway local Postgres and is skipped in CI:

```
CUSTOMER_INVOICES_PG_TEST=1 SUPABASE_ENV=local SUPABASE_PROJECT_REF=localstack \
SUPABASE_DB_URL=postgres://…@localhost:<port>/<db> \
  npx vitest run src/domains/customer-invoices/customer-invoices-store.pg.test.ts
```

The database needs every file in `supabase/migrations` applied in order and a
`buhl` row in `public.tenants`. Before the migrations, create an `auth` schema
with `auth.jwt()` and `auth.uid()` and the roles `anon`, `authenticated` and
`service_role` (the same recipe as the workshop-stock store test).
