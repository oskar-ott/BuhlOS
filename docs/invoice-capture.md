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
   (`invoices@<inbound domain>`, or `invoices+<token>@<inbound domain>` when a
   token is configured; Resend Inbound), or an
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
| Job hub card | `JobSupplierInvoicesCard` ("Materials used": category breakdown + lines) on `/v2/jobs/[jobId]` | rendered only when the flag is on for the viewer — no card, no fetch otherwise |
| Money card | `api/job-profitability.js` adds the job's confirmed allocations to the Materials figure (`supplierInvoices` in the response; `materialSource` `'invoices'` when only invoices carry it) — owner direction 2026-09-23 | flag on for the viewer; off ⇒ `supplierInvoices: null`, no store read |
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

Statuses: `received → processing → matched | needs_review | duplicate | failed`
(a matched invoice may also be *booking soon* or *held* — see Auto-booking),
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

### Evidence placement — no IV number printed (owner direction 2026-09-24)

Wholesalers print the IV number; a boutique supplier has nowhere to put one.
When a document carries **no** IV reference, `api/_lib/invoices/placement.js`
places it from what it does print, and says which evidence it used
(`match_status = 'inferred'`, `match_reason.source = 'evidence'`):

| Evidence | Strength | How |
| --- | --- | --- |
| Delivery / ship-to / site address is one job's `siteAddress` | **strong** | street number + street name compared after normalising abbreviations, units (`6/10` → 10) and ranges (`494-504` contains 494); the delivery block is read after its label (`Deliver To`, `Ship to`, `Site address`, `Site:` …), billing addresses never count |
| The job's site address appears anywhere in the text | strong | same key, whole-text |
| The job's name (≥ 5 chars, not generic) appears in the text or a customer reference | medium | "Your ref: Birdwood level 2" |
| The job's `ref` appears | medium | |

Rules: an IV number always wins (evidence fills only its absence); deleted
jobs are never candidates; **one strong candidate** or **one candidate at
all** = placed; anything else = ambiguity, sent to review with the candidates
offered as "the document mentions each of these — choose the right one".
Placed documents land `matched` like an IV match and wait for a person's
Confirm — unless the owner knob **Book evidence placements too**
(`autoConfirmInferred`, default off) is on, in which case a **strong** (address)
placement passes the IV checks and books itself after the grace window like any
other clean invoice; a name-only placement never books itself. The AI rung (opt-in)
also returns the delivery address and customer references for this. Migration
`20260924120000_supplier_invoice_inferred_match` adds the status value.

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
- **Scoping:** only mail addressed to the configured inbound address is
  processed — `invoices@<INVOICE_INBOUND_DOMAIN>` (owner choice 2026-09-16:
  `invoices@buhlos.com`), or `invoices+<INVOICE_INBOUND_TOKEN>@…` when a token
  is set (compared in constant time). Everything else is recorded as
  `ignored`. Authentication is the Svix signature, never the address; the
  sender address is **not** treated as proof of anything, and every document
  is confirmed by a person before it costs anything. Trade-off of the plain
  address: anyone who learns it can put a PDF into the review queue (never
  into a job cost) — add `INVOICE_INBOUND_TOKEN` if that ever becomes a
  nuisance; the address on `/invoices` updates automatically.
- **Quarantine (documented exception to fail-closed):** a correctly signed
  delivery to the right address while the flag is **off** is recorded by
  email id as `quarantined` — nothing fetched, nothing stored, nothing shown —
  so no email is lost. The sweep re-ingests quarantined and stalled receipts
  once the flag is on.
- **Fast ack:** the webhook records the receipt, downloads PDFs and photos
  (≤10 MB each, ≤10 per email, sniffed by bytes) within a 20 s budget, then —
  when exactly one document arrived, the common case — reads and matches it
  inline within a further 25 s budget so the office sees it matched within
  seconds. Anything else (several documents, a slow read, a timeout) is left
  `received` for the inbox (`process-pending`, 10 at a time) or the 15-minute
  sweep (20 at a time), with backoff and at most three attempts before a row
  is parked `failed` (retryable).

### What arrives that is not a PDF invoice (owner direction 2026-09-22)

Wholesaler mailboxes carry far more than tax invoices. Every case has a
defined outcome; nothing is silently dropped, and nothing is booked without a
person unless the auto-booking checks pass on a real invoice.

| Arrives | Outcome |
| --- | --- |
| PDF tax invoice / invoice / credit note | Captured, read, matched (the normal path). |
| PDF delivery docket, order confirmation, remittance advice, purchase order, pro-forma / "this is not a tax invoice" | Read, recognised by its own heading (`extract.js` type rules; an invoice heading always outranks a docket heading on the same page), then **set aside**: status `excluded`, `excluded_reason = not_an_invoice:<type>`, event `auto_excluded`. Visible under the Excluded filter and counted in the Monday digest ("Set aside"). Restore + correct the type if the reader was wrong. |
| Statement / quote | Read and sent to review as before (not allocatable) — statements are the office's reconciliation aid. |
| Photo or scan (JPEG/PNG/WebP, not inline signature images under 40 KB) | Captured as a document of `kind = image`, shown on the review screen as a picture, review reason `image_only` — the office enters the details by hand, then Confirm as usual. |
| Email with no attachment, or only a "view your invoice" link | One review item per email carrying the https links found in the body (≤5) and a text excerpt (≤1500 chars), reason `no_attachment` — but only when the subject/body looks invoice-related (auto-replies and chatter are ignored, recorded `ignored`). The office opens the link, downloads the PDF and **attaches** it on the review screen (`POST ?action=attach`), which reads and matches it straight away. |
| Outlook "forward as attachment" (.eml), zip, other file types | Same review item, reason `forwarded_as_attachment` / `zip_attachment` / `unsupported_attachment`, with the fix spelled out. |
| No IV number at all (a boutique supplier) | Placed by evidence — delivery address = a job's site (strong) or the job's name / ref printed (medium) — as `inferred`, evidence shown, a person confirms (or the owner knob lets strong ones book themselves). Two candidates → review with both offered. See "Evidence placement". |
| A printed IV number that matches no job (typo) | Review as before, plus up to three **"Did you mean…?"** jobs whose code is one digit off (adjacent swap or single-digit change, unique codes only). One click chooses the job; the printed reference is never rewritten. |
| An office job created without an IV number | Cannot happen for new jobs: the office New-job form requires `IV####` (the server already validates the format and refuses duplicates). Older jobs without a code can still be chosen by hand. |
- **Limits:** manual upload ≤3 MB (the serverless JSON body cap minus base64
  overhead); attachment ≤10 MB; ≤40 pages read.
- Logs carry counts and stable codes only — no addresses, subjects, secrets
  or content.

### Line items and the materials breakdown (owner pull 2026-09-24)

"See all the materials used on a job and a breakdown — cable, fixings,
lights; when an invoice comes in a lot of detail is pulled, not just the
number and the total."

- **Reading** (`api/_lib/invoices/lines.js`, pure): on invoices, tax invoices
  and credit notes, every printed row that ends in money between the column
  header (or the heading) and the totals block becomes a line — quantity and
  unit (first cell, a middle cell pair after a product code, or the last
  cell), unit price (the money cell before the total, else derived), line
  total, and wrapped descriptions folded in. The sum is checked against the
  printed ex-GST subtotal: `lines_consistent` true / false (`lines_include_gst`
  when they add up to the inc-GST total instead / `lines_do_not_add_up`). The
  **subtotal is still what books**; lines are the breakdown, never the cost.
- **AI rung** (opt-in as before): now also returns lines with categories. The
  model's lines replace the rules' **only** when the rules' do not add up and
  the model's do; its category fills a line the rules left `other`.
- **Filing** (`api/_lib/invoices/categories.js`): a fixed site-language
  taxonomy — cable, conduit & ducting, fixings & fasteners, switchgear &
  protection, boards & enclosures, lighting, power points & switches, data &
  comms, consumables, tools, testing & safety, freight & delivery, other —
  by keyword rules in priority order (a cable tie is a fixing; a conduit
  saddle is conduit). Sources: `rule` / `learned` / `ai` / `manual`.
- **Learning**: the office re-files a line on the review screen
  (`PUT ?action=line`); the choice is stored in `supplier_line_categories`
  per supplier + description key and wins on every later invoice
  (`learned`). An any-supplier fallback (`supplier_key ''`) is supported.
- **Measures** (`api/_lib/invoices/measure.js`, pure; owner follow-up
  2026-09-24 "click on cable and see exactly how much cable"): a line's
  quantity × the length or pack size printed in its description becomes a
  measure — metres (`3 roll` of `… 100M ROLL` = 300 m; `50 m` stays 50 m) or
  pieces (`5 pk` of `… PK100` = 500 pcs) — with the working shown. Only an
  explicit token counts (100M, 2.5 mtr, PK100, Box 50, x100); a millimetre
  size or a dimension (`200MM`, `10x75`) never does. Lines without one are
  reported as unmeasured, not guessed.
- **Surfaces**: review screen "Line items" card (qty with its measure,
  description, unit, total, category select, the add-up check); job hub
  "Materials used" card (`GET ?action=job-materials`) — total from confirmed
  invoices, a bar per category, then **click a category** for "450 m of cable
  across 2 products" and a product per line (same supplier + description
  key: cost, printed quantities, measure, invoice count), then **click a
  product** for the invoice lines behind it (date, qty = measure, supplier,
  amount linked to the invoice). By-supplier line; invoices whose lines could
  not be read listed as **unitemised** so the breakdown never claims more
  than it knows. Credit notes count negative.
- **Data**: migration `20260924100000_supplier_invoice_lines` —
  `supplier_invoice_lines`, `supplier_line_categories`,
  `supplier_invoices.lines_total_cents / lines_consistent`. RLS on.

### Statement check (owner direction 2026-09-23)

A supplier statement is the supplier's list of what we owe. When one is read
(`document_type = statement`, still not allocatable), the pipeline parses its
invoice / credit lines (`api/_lib/invoices/statement.js`: a reference token +
an amount, dates and IV codes excluded, balance/ageing/payment lines skipped)
and compares them with **this supplier's captured documents** by invoice
number (punctuation-insensitive, never fuzzy). The result is stored on the
statement row as `matchReason.statement` and shown as a "Statement check"
card: how many listed invoices are captured (linked), which are **not
captured** (reference, date, amount — ask the supplier to resend, or upload),
and any amount that differs from what was captured. A statement with
uncaptured invoices carries the review reason `statement_missing_invoices`.
Nothing is booked from a statement.
### Stray replies (owner direction 2026-09-23)

Resend receiving takes **every** email for `buhlos.com`, so a reply to
`timesheets@buhlos.com` (or `office@`, `pay@`, `onboarding@`, `noreply@` —
`INBOUND_FORWARD_LOCAL_PARTS` overrides the list) used to be recorded
`ignored` and never seen. The webhook now **forwards** such emails — body,
attachments (≤10, ≤5 MB each, ≤8 MB total), the original sender as reply-to —
to the accounts recipient list (the same list the pay-run and the digest go
to), from `INBOUND_FORWARD_FROM` (default `EMAIL_FROM`), and records the
receipt `forwarded` (migration `20260923100000_supplier_invoice_inbound_forwarded`).
A failed forward is recorded `ignored` with `failure_code forward_failed:<why>`
and counted by the mid-week alert. Anything else addressed to the domain stays
`ignored` — nobody has a mailbox there. `api/_lib/invoices/forward.js`.

### Alerts between Mondays (owner direction 2026-09-23)

Every 15-minute sweep evaluates a health snapshot (`store.healthSnapshot`) and
emails the accounts list when a person is needed — **at most once a day per
condition set** (state in blob `invoices/alert-state.json`, so a redeploy never
re-alerts; a cleared condition set resets it so the next new problem alerts at
once). Conditions (`api/_lib/invoices/alerts.js`): the Resend key rejected
(`provider_auth` during re-ingest), documents `failed` after three attempts,
documents waiting more than two hours to be read, quarantined emails older than
a day, failed forwards in the last day, and **quiet**: no supplier email for
`alertQuietDays` days (owner knob, default 7, 0 = never) after the first one
ever arrived. The Monday digest is unchanged.

### External steps still required (none performed by the PR)

1. **Resend:** enable receiving on `buhlos.com` (already a verified sending
   domain; it has no MX record today, so nothing else receives mail there) and
   add the MX record Resend shows. Do **not** touch the office email domain.
2. **Resend:** Webhooks → Add Webhook → URL
   `https://<production host>/api/inbound/invoices`, event `email.received`;
   copy the signing secret.
3. **Vercel env (Production, and Preview for testing):**
   `RESEND_INBOUND_WEBHOOK_SECRET`, `INVOICE_INBOUND_DOMAIN` (`buhlos.com`);
   optional `INVOICE_INBOUND_TOKEN` (a long random string, e.g.
   `openssl rand -hex 16`, turns the address into `invoices+<token>@…`) and
   `INVOICE_INBOUND_LOCAL_PART` (default `invoices`). `RESEND_API_KEY` already
   exists and must be a full-access key (it reads received emails).
4. **Office mailbox:** a forwarding rule for wholesaler emails to
   `invoices@buhlos.com` (the exact address is shown on `/invoices` once
   configured).
5. **Supabase production:** apply migration `20260915100000_supplier_invoices`
   through the documented workflow.
6. **Owner Console:** preview the feature (`Preview for me`) before `Live`.

## Auto-booking (owner decision 2026-09-22)

Set-and-forget needs the normal case to book itself and a person to see only
exceptions. A **clean** invoice books itself after a grace window; everything
else waits for a person. The rules are deterministic and recorded on the
invoice (`auto_confirm_checks`), so every automatic booking is explainable.

All of these must hold (`api/_lib/invoices/auto-confirm.js`):

| Check | Why |
| --- | --- |
| tax invoice, invoice or credit note | statements and quotes never book |
| IV reference read from a **labelled** field | the wholesaler wrote it deliberately |
| exactly one job carries the code and it is **active** | complete / on-hold / draft / archived stay human |
| ex-GST, GST and total all **printed** and reconciled | nothing derived, nothing from AI |
| supplier invoice number and a date within the lookback | old or partial documents stay human |
| not a duplicate | existing rules |
| supplier has a previously **human**-confirmed invoice | trust is earned per supplier; the first is always reviewed |
| supplier not set to "always review" | revocable per supplier from the review screen |
| ex-GST under the cap | big ones get eyes |
| credit note: supplier already has a confirmed invoice on that job | a credit with nothing to credit is suspicious |
| nobody has edited or held it | a person's edit means a person finishes it |

**Flow.** After extraction a matched invoice is evaluated and marked eligible
or not. With the owner knob **on**, an eligible invoice gets
`auto_confirm_at = now + grace` and shows as *Booking soon* with a countdown
and a **Hold** button; the 15-minute sweep books everything past its
deadline (claiming clears the deadline first, and the one-active-allocation
index makes a double booking impossible). With the knob **off** (default,
review-only mode) the verdict is still recorded and the inbox says "would
book itself", so the office can see how often the rules would fire before
trusting them. Any correction, job change, hold or status change clears the
deadline. Automatic bookings carry `confirmed_by = BuhlOS (auto)` and reverse
exactly like human ones (Move / Exclude / Archive).

**Owner knobs** (`/owner` → settings, `invoice_capture.*`): `autoConfirm`
(off), `autoConfirmCapDollars` (5000), `autoConfirmGraceHours` (12),
`autoConfirmLookbackDays` (90).

**The digest is the oversight.** Every Monday 07:30 Sydney
(`GET /api/invoices?action=digest`, cron) the accounts recipient list — the
same list timesheets go to, managed on `/settings` — gets one email: captured
/ booked automatically / booked by a person / waiting on you / failed, each
booking with a link, plus a health section (failed reads, documents stuck
unread for a day, no supplier mail for 14 days). No recipients → no email.

Rollout: review-only for two weeks, then knob on with a low cap, then raise.

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
