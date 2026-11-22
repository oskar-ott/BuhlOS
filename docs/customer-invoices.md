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
| Invoice permissions, client link, defaults | [#1149](https://github.com/oskar-ott/BuhlOS/issues/1149) | **Planned, not built** |
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

**No Xero call exists anywhere in this feature yet.** The card says so on
screen ("This is the plan only. Nothing is sent to Xero from here yet.") and
shows no Send button, no Invoiced and no Paid figure.

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

### Testing

| What | Where |
| --- | --- |
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
