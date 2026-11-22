# Job invoicing, part 2: small jobs, job data and variations — research and plan

**Status:** plan, written 2026-11-22 before the build. What is actually built
is recorded in [../customer-invoices.md](../customer-invoices.md); if the two
disagree, that document wins.

**Builds on** [job-invoicing-xero-plan.md](job-invoicing-xero-plan.md) (parts
A–F: stage invoices into Xero as drafts, paid status, BuhlOS job numbers) and
is bound by the same rules:
[../architecture/customer-invoicing-boundary-adr.md](../architecture/customer-invoicing-boundary-adr.md).
Nothing here changes that boundary: BuhlOS drafts, Xero owns the invoice.

## 1. The pull

Owner, 2026-11-22, in his words:

- invoicing "for jobs big and small";
- for small jobs, "a full itemised invoice ... by manually creating it";
- "use the data collected like hours materials ... to create an invoice while
  being able to change to prices for markups etc";
- "the creation of variations";
- "for the larger jobs where they are realised in stages this just a invoice
  with the total not a detailed invoice".

So there are two kinds of invoice, and both stay:

| Kind | For | What the client sees |
| --- | --- | --- |
| **Stage invoice** (built, parts B–E) | bigger jobs paid in stages | one line: the stage and its amount, plus any variation billed with it, less retention |
| **Itemised invoice** (this plan) | small jobs, do-and-charge work | every charge with a quantity and a unit price |

**Hypothesis:** *the office will raise a small job's invoice from BuhlOS, from
the hours and materials already on the job, instead of re-typing them into
ServiceM8 or Xero. We'll know it's true when one real small job is invoiced
this way and the hours and materials on it are not typed a second time.*

## 2. What was researched

Three things, on 2026-11-22: what an electrical business owner needs from
invoicing (law, common practice, what the trade tools do), exactly what Xero
accepts on an itemised invoice, and what BuhlOS already holds.

### 2.1 Law

- **Tax invoice (ATO).** Must show "tax invoice", the seller and ABN, the
  date, a description of each item *including quantity (if applicable) and
  price*, and the GST. At $1,000 or more it must also identify the buyer.
  GST can be shown as one total; per-line GST is not required.
  ([business.gov.au](https://business.gov.au/finance/payments-and-invoicing/how-to-invoice),
  [ATO](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/tax-invoices))
  The heading, ABN and GST are Xero's invoice template; **the quantity and
  price per item is the part BuhlOS must get right.**
- **Payment claims (SA).** Under the Building and Construction Industry
  Security of Payment Act 2009 (SA), s 13(2), a payment claim must identify
  the work, state the amount claimed, and **state that it is made under the
  Act**. There is no prescribed form, so an invoice can be one if it carries
  those three things. Owner-occupier domestic work is excluded (s 7(2)(b)).
  ([the Act](https://www.legislation.sa.gov.au/_legislation-documents/lz/c/a/building-and-construction-industry-security-of-payment-act-2009/current/2009.77.un.rtf))
  This is a reading of the Act, not legal advice.
- **Retention** is set by the contract, typically around 5%, part released at
  practical completion and the rest after the defects period. No SA statutory
  rule was found.

### 2.2 Common practice

- **Materials are billed at a sell price, not cost.** The Master Electricians
  2025 benchmark has most contractors marking materials up 21–50%
  ([source](https://www.masterelectricians.com.au/?p=41841)). Every trade tool
  keeps cost and sell apart, lets the markup be changed per line, and never
  prints the cost.
- **Nearly half charge a service or call-out fee**, more than half charge
  travel, about two-thirds have an after-hours rate (same benchmark). These
  are standing charges a business adds again and again.
- **What goes wrong** is consistent across the trade tools' own material:
  invoices raised late, hours and parts never billed, costs that arrive after
  the invoice has gone, and variations done but never claimed.
- **A variation** is recorded with a number, a description, who asked for it,
  the price, and whether it is approved, and is agreed in writing *before* the
  work. Doing the work with the builder's knowledge does not by itself create
  a right to be paid.
- **Markup is not margin.** A 30% markup is a 23% margin.

### 2.3 What the trade tools do (ServiceM8, simPRO, Tradify, Fergus, AroFlo)

- Pull **un-invoiced** time and costs from the job, with a **cut-off date**,
  and mark each one invoiced so it cannot be billed twice (Tradify, Fergus,
  AroFlo).
- A **default materials markup** with a per-line override (ServiceM8, AroFlo).
- A choice of **each item listed, or one summarised line** (Tradify,
  ServiceM8).
- Flag **costs added after invoicing** (Fergus).
- Variations with **approved / declined** and a **revised contract value**,
  billed on the claim or alone (simPRO, Fergus).

### 2.4 What Xero accepts (developer.xero.com)

- A line has a description (up to 4,000 characters), quantity, unit amount,
  account and tax type. A **negative unit amount is allowed**; a negative
  quantity is not.
- **A line with only a description is allowed**, so wording (what the work
  was, a payment-claim statement) can sit on the invoice with no amount.
- **GST is worked out per line, rounded to the cent, then added up.**
- Which way Xero rounds an exact half cent on a line is **not documented**.
  BuhlOS rounds half away from zero and compares what Xero stored on the
  read-back, so a difference is seen, never assumed away. Settling this is on
  the proving-run list (§8).
- The idempotency key is only held for 6 minutes. The existing "look the
  number up in Xero before any retry" already covers that.

### 2.5 What BuhlOS already holds

- **Hours** per job, per worker, per day (approved timesheets), and for each
  worker a cost rate and an optional **charge-out rate**
  (`api/_lib/cost-rates.js`).
- **Materials**: captured supplier invoices allocated to the job, with each
  line's description, quantity, unit price and total
  (`supplier_invoice_lines`), and dockets typed into the job's materials
  ledger (`api/_lib/job-materials.js`).
- **Stage invoices**: one headline line plus optional "extra lines" that are a
  description and an amount. Every line goes to Xero with quantity 1.
- **Variations**: nothing. An extra line can be worded as one, but nothing
  records it, and it counts against the original contract.

## 3. What the office will get

1. **Itemised invoice** on any job. Lines typed by hand: description,
   quantity, unit, unit price. Wording-only lines for describing the work.
   A negative price for a discount or credit.
2. **Add from this job.**
   - *Hours:* the job's approved hours that are not on an invoice yet, up to a
     chosen date, priced at each worker's charge-out rate (or a rate chosen on
     the spot). One line per worker, or one line per rate. Hours can be
     rounded up to the quarter, half or whole hour.
   - *Materials:* supplier invoice lines and typed dockets not on an invoice
     yet, at cost plus a markup. The markup can be changed for the batch and
     the price per line. Each item listed, or one "Materials" line.
   - *Usual charges:* the business's own short list (call-out fee, hourly
     rates, travel), added with one tap.
3. **Nothing is billed twice.** Anything pulled in is marked as on that
   invoice. It is free again if the invoice is removed, or is deleted or
   voided in Xero.
4. **"Not yet on an invoice"** on small jobs: hours and materials that have
   arrived and are on no invoice, including ones that arrive after an invoice
   has gone.
5. **Cost and margin, for the office only.** Each pulled line keeps what it
   cost. The editor shows cost, margin and margin %. None of it goes to Xero.
6. **Variations** on the job: number, what it is, who asked, the price, and
   proposed / approved / declined with the approval reference. Approved
   variations raise the job's total ("contract + variations"), show as
   unbilled until they are on an invoice, and are billed on a stage or alone.
7. **Payment-claim wording** (optional, per job, off by default): adds the
   sentence the SA Act asks for, and the claimed-to-date figures, to each
   invoice on that job.

Stage invoices keep working exactly as they do.

## 4. Rules the build follows

Everything in the boundary ADR still holds. In addition:

- **Price is the office's; cost is BuhlOS's.** A person can set any sell
  price. The cost on a pulled line is always worked out on the server from the
  job's own data, never taken from the browser.
- **Cost, markup and "what this line bills" never leave BuhlOS.** Xero
  receives description, quantity, unit price, account and tax type only.
- **No invented numbers.** No default markup and no default hourly rate ship
  with the product. A worker with no charge-out rate gets a blank price to
  fill in, not a guess. A margin is shown only when every pulled line on the
  invoice has a cost.
- **Billed is derived, not flagged.** What is "on an invoice" is read from the
  invoices themselves, so it can never drift from them: removing an invoice,
  or Xero showing it deleted or voided, frees what it billed with no extra
  step.
- **A sent invoice is frozen**, lines included, exactly as stages are.
- **Only an approved variation can be billed, once, at its approved amount.**
- **Integer maths.** Quantity is whole thousandths, money is whole cents, a
  line total is rounded once.

## 5. Design

### 5.1 Database — one additive migration

`20261125100000_customer_invoices_itemised_and_variations.sql`

| Change | Why |
| --- | --- |
| `customer_invoices.kind` may be `itemised` | the new kind |
| `customer_invoices.items jsonb` | an itemised invoice's lines (charge or note; quantity, unit, unit price; where it came from; cost; what it bills) |
| `customer_invoices.sent_footer text` | wording added at send (payment claim), frozen so a retry sends the same thing |
| `customer_invoice_job_profiles.payment_claim boolean` | the per-job switch |
| `customer_invoice_prefs` (one row per tenant) | usual materials markup, usual charges, hours rounding |
| `customer_invoice_variations` | the variations register |
| `customer_invoice_events.event` accepts `variation_*` and `prefs_updated` | history |

RLS on with no policies, tenant-scoped, as every table here is.

### 5.2 Server

| Piece | Where |
| --- | --- |
| Line maths, item normalising, invoice cost summary | `api/_lib/customer-invoices/amounts.js` |
| Itemised lines → Xero, wording lines, per-line GST estimate | `api/_lib/customer-invoices/payload.js` |
| What on the job can be billed, and what already is | `api/_lib/customer-invoices/billable.js` (new) |
| Variations | `api/_lib/customer-invoices/variations.js` (new) + store |
| Routes | `api/customer-invoices.js` |

Routes added (all office tier, all behind `customer_invoices`):

| Call | Does |
| --- | --- |
| `POST ?action=stage-add` / `stage-edit` with `stage.kind = "itemised"` | add / replace a planned itemised invoice |
| `GET ?action=billable&jobId=[&invoiceId=]` | the job's hours and materials, each marked on-an-invoice or not |
| `GET` / `PUT ?action=prefs` | usual markup, usual charges, hours rounding |
| `POST ?action=variation-add` · `variation-edit` · `variation-decide` · `variation-remove` | the register |
| `POST ?action=variation-bill` | put an approved variation on its own invoice or on a planned stage |
| `PUT ?action=payment-claim` | the per-job switch |

The send, retry, reset, raise-again and status paths are unchanged; they
already work from "the invoice's lines".

### 5.3 Screens

All on the job page's **Getting paid** card (office only):

- **Add itemised invoice** beside **Add stage**. The editor is one dialog:
  what the work was, the lines, "Add from this job", a live total, and the
  office-only cost and margin.
- A **Variations** list with add / edit / approve / decline / bill.
- **Contract** becomes "contract + approved variations" once there are any.
- **Not yet on an invoice** on jobs billed by the hour.
- **Payment-claim wording** next to the retention line.

## 6. Awkward cases

| Case | What happens |
| --- | --- |
| Hours are edited after they were billed | the extra hours show as not yet on an invoice; the invoice already sent is untouched |
| A supplier invoice arrives after the job was invoiced | it shows as not yet on an invoice |
| The same hours are picked on two invoices at once | the second save is refused: "already on another invoice" |
| An invoice with pulled hours is removed, or deleted / voided in Xero | its hours and materials are free again |
| A worker has no charge-out rate | the line's price is blank and must be typed or picked from the usual charges |
| A credit note from a supplier | offered as a negative cost; billing it is the office's choice |
| Quantity × price lands on an exact half cent | BuhlOS rounds away from zero; if Xero stored a different cent the invoice is flagged after the read-back, and Xero's figure is shown |
| A variation is approved at a different figure from the quote | both are kept; the approved figure is the one that counts and is billed |
| A variation is declined after being put on a planned invoice | the save of that invoice is refused until the line is taken off |
| A billed variation | can't be edited, re-decided or removed |
| Payment-claim wording on a retry | the wording is frozen at send, so the retry is identical |
| Materials capture or the hours store can't be read | that source says so; the invoice can still be typed by hand |

## 7. Build order

One branch and one pull request, all dark behind `customer_invoices`. The four
parts share the same files (an invoice's lines, the store, the card), so they
were built and tested together rather than as four stacked pull requests:

| Part | Issue | What |
| --- | --- | --- |
| G | #1161 | itemised invoice, typed lines, to Xero as a draft |
| H | #1162 | add from hours and materials, markup, usual charges, not-yet-on-an-invoice |
| I | #1163 | variations and the revised contract |
| J | #1164 | payment-claim wording |

## 8. Going live

Unchanged from the first plan (§8 there), plus, **on the Demo Company proving
run**:

1. One itemised invoice with fractional quantities, a wording-only line and a
   negative line. Confirm Xero stores every line as sent.
2. Two half-cent cases: `2.5 × $33.33` and a `$0.25` line at 10% GST. Record
   which way Xero rounds; if it differs from BuhlOS, change
   `lineAmountCents` / `estimateTaxCents` to match.
3. A stage invoice with payment-claim wording: confirm the wording lines print
   on Xero's invoice template.

The migration needs the owner's approval for dev and for production, as
before. Nothing here calls Xero until an invoice is sent.

## 9. Not in this build

- Tiered, per-supplier or per-client markups.
- A full price book.
- Variation requests raised from the phone on site.
- Notice-deadline and retention-release reminders.
- A different sales account for labour and for materials.
- BuhlOS approving or emailing an invoice.
