# Supplier pilot checklist

**Purpose.** Prove supplier-invoice capture on **one real supplier** — real
PDFs, real IV references, real amounts — before adding the next. The rule
parser has never seen a real wholesaler PDF; the pilot is where it learns.
Feature: [../invoice-capture.md](../invoice-capture.md).

## Pick the supplier

- The one that sends the **most** invoices by email and prints the IV job
  reference under a clear label (*Job Number*, *Order Number*, *Your Ref*).
- Not the one with credit notes, statements and multi-job invoices in the
  first week — those come second, deliberately.

## Week 1 — read and match

| # | Step | Verify | Stamp |
| --- | --- | --- | --- |
| 1 | Forward the supplier's last ~10 invoices (mailbox rule or by hand) | Each appears in `/invoices` | |
| 2 | For every invoice compare the read values with the PDF: supplier, invoice number, date, ex-GST / GST / total, IV reference | Corrections are made on the review page (each correction is history) | |
| 3 | Note every field the parser got **wrong** — supplier name, number, a total taken from the wrong line, an IV reference missed | Write them in the table below; they are the parser's backlog | |
| 4 | Confirm the correct ones; **exclude** statements and dockets that slipped through with a reason | The job's Money card *Materials* figure moves; the hub *Materials cost* card lists the lines | |
| 5 | Re-file mis-categorised line items (cable / fixings / lights …) — the re-file is remembered for this supplier | Next invoice from the same supplier files them right | |

| Invoice # | What was read wrong | Fixed by hand? | Parser change needed? |
| --- | --- | --- | --- |
| | | | |

## Week 2 — the hard cases

| # | Step | Verify | Stamp |
| --- | --- | --- | --- |
| 6 | Forward one **credit note** | It reads as a credit note; confirming records a **negative** allocation; the job's figure drops | |
| 7 | Forward one **statement** | It is set aside (never a cost) and the statement check names any invoice never captured | |
| 8 | Forward one invoice printing **two job references** (if the supplier ever does) | *Split allocation required* — no one-click confirm; whole-invoice allocation needs a reason | |
| 9 | Type one of the confirmed invoices into the manual **Materials** ledger on the same job by mistake | *Possible duplicate cost* warns; "Add anyway" needs a reason | |
| 10 | Read the **Monday digest** email | Captured / booked / waiting / set-aside counts match what you saw | |

## Exit criteria (all stamped before the next supplier)

- ≥ 10 invoices read with **no wrong total after correction** and every
  wrong read written in the table above.
- IV matching: every invoice that printed an IV reference matched the right
  job; every one that did not landed in review, not on a wrong job.
- One credit note and one statement handled as above.
- No supplier-invoice cost reached a job without a person confirming it.
- The office says the review page is faster than retyping — or says what is
  missing (pull, not push: [../product/03-lean-startup-loop.md](../product/03-lean-startup-loop.md)).

## Then

Add the next supplier and repeat weeks 1–2. Keep automatic booking **off**
until the shadow report clears its gate for the suppliers in question
([auto-booking-shadow-review.md](auto-booking-shadow-review.md)).
