# Supplier-invoice capture (`invoice_capture`)

> **Status: DARK, UNPROVEN.** Built 2026-09-15 as a complete first vertical
> slice behind a launch-gate flag (default off, admin-tier). It is **not** part
> of the ratified lean core ([product/02-lean-reset.md](product/02-lean-reset.md));
> it earns its place, or not, through the pull-based loop in
> [product/03-lean-startup-loop.md](product/03-lean-startup-loop.md). Nothing
> about it is visible anywhere while the flag is off.

## What it does

Wholesalers email supplier invoices to the office. When materials are bought,
the worker gives the wholesaler the job's **IV number** — the job's `code` in
`jobs.json` (`IV####`, created with the job) — and the wholesaler prints it
under a label of their own choosing (*Job Number*, *Job Reference*, *Customer
Reference*, *Order Number*, *Purchase Reference*, *Your Reference*, …).

With the flag on:

1. The office mailbox forwards qualifying emails to a BuhlOS inbound address
   (`invoices+<unguessable-token>@<inbound domain>`, Resend Inbound), or an
   office user uploads a PDF at `/invoices`.
2. BuhlOS records a durable receipt, fetches the PDF attachments through the
   Resend API (never from the webhook body), keeps every original in Blob, and
   writes the metadata to Postgres.
3. The PDF's text layer is read; supplier, supplier invoice number, date,
   document type, ex-GST / GST / total and the printed IV reference are
   extracted with provenance and confidence per field.
4. The IV reference is normalised **conservatively** and looked up **exactly**
   against live job codes. One job → *Matched — awaiting confirmation*. None,
   several, or a collision → *Needs review*. Never fuzzy, never auto-created.
5. Duplicates are caught three ways (provider identity, PDF checksum, supplier
   + supplier invoice number).
6. An office user reviews the PDF beside the extracted values, corrects
   anything, chooses a different job if needed, and **confirms**.
7. Only a confirmation creates a job-cost allocation: **+ex-GST** for an
   invoice, **−ex-GST** for a credit note, nothing for statements/quotes. The
   job hub's *Supplier invoices* card shows the sum of active confirmed
   allocations and links to the invoices behind it.

Two different numbers, never combined: the **supplier invoice number** (the
supplier's own document id) and the **IV job reference** (the BuhlOS job code).
They are separate columns, separate fields, separate labels everywhere.

## Surfaces

| Surface | Where | Gate |
| --- | --- | --- |
| Inbox | `/invoices` (`src/app/(admin)/invoices/page.tsx`, `InvoiceInboxClient`) | admin tier + flag (404 off) |
| Review | `/invoices/[invoiceId]` (`InvoiceReviewClient`) | admin tier + flag |
| Job hub card | `JobSupplierInvoicesCard` on `/v2/jobs/[jobId]` | rendered only when the flag is on for the viewer — no card, no fetch otherwise |
| Nav item | `Invoices` in the Jobs group (`src/components/admin/nav.ts`) | hidden by `AdminShell` while off |
| Office API | `api/invoices.js` | admin tier + flag (404 off); every mutation audited |
| Inbound webhook | `POST /api/inbound/invoices` (`src/app/api/inbound/invoices/route.ts` → `api/_lib/invoices/webhook.js`) | Svix signature; flag off ⇒ **quarantine** (see below) |
| Sweep cron | `GET /api/invoices?action=sweep` every 15 min (`vercel.json`) | `CRON_SECRET`; no-op while the flag is off |

## Data (Supabase-first; migration `20260915100000_supplier_invoices.sql`)

| Table | Role |
| --- | --- |
| `supplier_invoices` | the record: supplier, **supplier_invoice_number**, document type, date, money (integer cents), **iv_reference_raw / _normalised**, match, status, review reasons, extraction provenance, duplicate link, source |
| `supplier_invoice_documents` | the original PDF: sha256, size, Blob pathname/url (server-only), provider email+attachment ids (unique) |
| `supplier_invoice_allocations` | confirmed job cost, **signed cents**; partial unique index = one active allocation per invoice |
| `supplier_invoice_attempts` | every processing run with outcome + stable failure code |
| `supplier_invoice_events` | append-only per-invoice history |
| `supplier_invoice_inbound_events` | one row per Svix message id (replay guard), status `received / quarantined / processed / ignored / failed` |

Tenant-scoped (`tenant_id`, single tenant `buhl` today), RLS on with no
policies (service-role only, house pattern), additive and reversible (drop
statements in the migration header). PDFs live in Blob under
`invoices/<tenant>/<invoice>/…` with Blob's random suffix; the URL is never
sent to a browser — the only read path is the authenticated proxy
`GET /api/invoices?action=document&id=…`. Applied to the **dev** project
(`frovgpywsopbeuekijmo`) on 2026-09-15; **not** applied to production — that
is a release step (`docs/supabase-environment.md` workflow).

Statuses: `received → processing → matched | needs_review | duplicate | failed`,
then the office's `confirmed | excluded | archived`, with `restore` back to
review. `api/_lib/invoices/state.js` is the transition table.

## Exact matching & normalisation (`api/_lib/invoices/iv-match.js`)

- Source of truth: `jobs.json[].code`. Jobs with no code, a malformed code or a
  delete tombstone are not eligible. If two live jobs carry one code, matching
  for that code is **blocked** (`ambiguous`) — the create-time uniqueness rule
  is re-checked, not assumed.
- Normalisation: trim, uppercase, and collapse one separator (space, hyphen,
  dot, colon, hash) between `IV` and the four digits. Nothing else. `IV41` is
  malformed, not `IV0041`; `INV0041` is not an IV reference.
- Candidates come from **labelled** lines first (the wholesaler label
  vocabulary above; a line that names the *supplier's* document — *Tax Invoice
  No*, *Credit Note No*, *Statement* — is never a job reference), then from any
  well-formed `IV####` token in the text as weaker evidence.
- One distinct labelled reference → look it up. Several distinct references
  (labelled, or unlabelled with none labelled) → `multi_reference`, review.
- The match reason is stored (`match_reason`): raw, normalised, label, source,
  line, field, match count, warnings (complete / archived / on-hold / draft
  jobs still match but the reviewer is warned).

## Money (`api/_lib/invoices/money.js`)

Integer cents everywhere. The three printed figures are reconciled: all three
present → consistent iff within 1 cent; two present → the third is derived by
exact arithmetic and labelled `derived`; fewer → unknown. **GST is never
assumed to be 10%.** An inconsistent or missing ex-GST figure blocks
confirmation until the office corrects it. Allocation = `+subtotal` (invoice /
tax invoice), `−subtotal` (credit note), none otherwise. The job figure is
`sum(active allocations)` — computed on read, never cached.

## Duplicates (`api/_lib/invoices/dedupe.js`)

1. Same Svix message id → replay, ignored. Same (received email id, attachment
   id) → the unique index refuses a second document; ingest is a no-op.
2. Same PDF bytes (sha256) as an earlier invoice → `duplicate` of the earliest.
3. Same supplier key **and** supplier invoice number (both known) → `duplicate`.
   A number alone is never identity; two suppliers can both issue `1001`.
4. Confirm is idempotent (one active allocation per invoice, enforced by the
   database); re-clicks return the same allocation. Reassign, exclude and
   archive reverse the active allocation inside one transaction.

## Extraction (`api/_lib/invoices/extract.js`, `pdf-text.js`, `ai-extract.js`)

Order: PDF text layer (`unpdf`, lines re-assembled by position) → optional AI
rung → manual entry. Scanned PDFs have no text layer: they go straight to
*Needs review* with the reason *no readable text*, the PDF intact — **no OCR
is built** (the repo has none for PDFs and this adds no paid dependency).

**AI rung (opt-in, off by default).** `INVOICE_AI_EXTRACTION=1` plus the
existing `ANTHROPIC_API_KEY` sends the PDF's *text* (never the bytes, ≤12k
chars) to the same provider `api/plans.js` already uses, with a strict
tool-schema, to fill fields the rule parser left empty. It never decides the
IV match and never confirms anything. Privacy/cost: invoice text is business
data and each call costs tokens — turning it on is the owner's decision.

**Real supplier samples are still required.** The rule parser was written
against fake fixtures (`src/domains/invoices/test-helpers/fixtures.ts`). To
validate it, the office should provide sanitised PDFs (private details
blacked out) of: one tax invoice from each major wholesaler used, a credit
note, a statement, an invoice with a mistyped IV number, and an email with
several attachments (invoice + logo + T&Cs). Anything it misreads is a parser
fix behind the existing tests, not a design change.

## Inbound email

- **Provider:** Resend Inbound (the repo already sends through Resend).
  `email.received` webhooks carry metadata only; the email and attachments are
  fetched from `GET /emails/receiving/{id}` and
  `GET /emails/receiving/{id}/attachments/{aid}` (short-lived `download_url`).
- **Verification:** Svix headers (`svix-id`, `svix-timestamp`,
  `svix-signature`) over the **raw** body with `RESEND_INBOUND_WEBHOOK_SECRET`;
  5-minute timestamp tolerance; constant-time compare. This is why the
  webhook is a Next route handler (`request.text()`) rather than an `api/*.js`
  function (whose body arrives pre-parsed).
- **Scoping:** only mail addressed to `invoices+<INVOICE_INBOUND_TOKEN>@…` is
  processed; the token is compared in constant time; everything else is
  recorded as `ignored`. The sender address is **not** treated as proof of
  anything.
- **Quarantine (documented exception to fail-closed):** a correctly signed
  delivery to the right address while the flag is **off** is recorded by
  email id as `quarantined` — nothing fetched, nothing stored, nothing shown —
  so no email is lost. The sweep re-ingests quarantined and stalled receipts
  once the flag is on.
- **Fast ack:** the webhook records the receipt, downloads PDFs (≤10 MB
  each, ≤10 per email, sniffed as PDF by bytes) within a 20 s budget, and
  returns 200. Extraction happens later: when the inbox is opened
  (`process-pending`), or on the 15-minute sweep, with backoff and at most
  three attempts before a row is parked `failed` (retryable).
- **Limits:** manual upload ≤3 MB (the serverless JSON body cap minus base64
  overhead); attachment ≤10 MB; ≤40 pages read.
- Logs carry counts and stable codes only — no addresses, subjects, secrets
  or content.

### External steps still required (none performed by the PR)

1. **Resend:** add the receiving (sub)domain — e.g. `inbound.buhlos.com` — and
   its MX record. Do **not** touch the office domain's MX.
2. **Resend:** Webhooks → Add Webhook → URL
   `https://<production host>/api/inbound/invoices`, event `email.received`;
   copy the signing secret.
3. **Vercel env (Production, and Preview for testing):**
   `RESEND_INBOUND_WEBHOOK_SECRET`, `INVOICE_INBOUND_TOKEN` (a long random
   string, e.g. `openssl rand -hex 16`), `INVOICE_INBOUND_DOMAIN` (the
   receiving domain), optional `INVOICE_INBOUND_LOCAL_PART` (default
   `invoices`). `RESEND_API_KEY` already exists.
4. **Office mailbox:** a forwarding rule for wholesaler emails to
   `invoices+<token>@<domain>` (the exact address is shown on `/invoices` once
   configured).
5. **Supabase production:** apply migration `20260915100000_supplier_invoices`
   through the documented workflow.
6. **Owner Console:** preview the feature (`Preview for me`) before `Live`.

## Security

Admin tier on every read and write (`requireAuth` + `isAdminRole`); flag 404s
before role checks so a disabled feature leaks nothing; every row is
tenant-scoped through the store; the client can never confirm onto a job the
server did not match (`job_mismatch`), and deleted jobs are refused; PDF bytes
are sniffed, filenames sanitised (basename, no control characters, bounded);
no arbitrary URL is ever fetched server-side (attachments come from the
provider's authenticated API); the document proxy is authed, `no-store`,
`nosniff`; the webhook reads no session; stable error codes only; audit
entries carry supplier / number / IV / job but never amounts (the per-invoice
money history lives in `supplier_invoice_events`).

## Deliberately deferred (later possibilities, not unfinished controls)

Paying invoices, AP approval, bank reconciliation, Xero bills or payment
status, purchase orders, general expenses, stock allocation, splitting one
invoice across jobs (the allocation table is ready: drop the one-active index
and add a per-invoice sum check), automated bookkeeping, replacing Xero,
reading the whole mailbox with broad OAuth, auto-creating jobs from unknown
IV references, PDF OCR, feeding the Money card's Materials figure from
confirmed invoices, and a global-search entry for invoices.

## Tests

`src/domains/invoices/*.test.ts` (matching, money, extraction, duplicates,
state machine, Svix verification, pipeline, webhook, the full API handler with
signed sessions and an in-memory store, a real pdf-lib → unpdf round trip),
`src/components/admin/invoices/invoices.render.test.tsx`, the optional
`invoices-store.pg.test.ts` against the dev project (`INVOICES_PG_TEST=1`),
and `tests/playwright/smoke/invoices.spec.ts` (gating always; the upload →
confirm story when `SMOKE_INVOICE_CAPTURE=1` on a preview with the flag on).
