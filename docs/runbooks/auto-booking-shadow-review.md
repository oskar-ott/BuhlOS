# Automatic-booking shadow review — weekly checklist

**Purpose.** Read the shadow report every week while automatic booking is
**off**, act on what it shows, and build the evidence the release gate needs.
The report and gate: [../invoice-capture.md](../invoice-capture.md)
"Automatic booking — shadow report and release gate". Never turn the knob on
from this runbook; it produces a decision record, not a switch.

## Every Monday, after the digest (~10 min)

| # | Step | What to look at | Stamp |
| --- | --- | --- | --- |
| 1 | `/invoices` → **Automatic booking — shadow report** → Show → 90 days | *Evaluated*, *No human outcome yet*, *Would have booked*, *Would have waited* | |
| 2 | Clear the backlog: every *No human outcome yet* item is an invoice a person has not decided on | Decide them in the inbox — the report cannot judge an undecided invoice, and it never pretends to | |
| 3 | Walk every **disagreement** (linked) | For a *would have booked, person disagreed*: was the person right? If the **evaluator** was wrong, note **why** (wrong job from a mis-read reference, wrong total, a supplier that should be *always review*) | |
| 4 | For *would have waited, person booked it as-is*: which check stopped it? | `supplier_trusted` on a new supplier is expected in month one; `figures_printed` / `totals_consistent` on a supplier whose PDFs always derive a figure is a parser backlog item | |
| 5 | Set **always review** on any supplier whose invoices need a person every time (credit-heavy, multi-job, hand-written) | Supplier preference on the invoice review page | |
| 6 | Read the **release gate** lines and *suppliers ready* | Do not argue with a ✗ — fix the cause or wait for the sample | |

| Week ending | Evaluated | Unresolved | Would book | Agreed | False + | False − | Gate | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | |

## Before the decision to turn it on

All of the following, stamped:

- The gate passes on a **representative proving period** — long enough to
  include the suppliers that matter, month-end statements, at least one
  credit note and receipts from the field.
- **Zero** would-have-booked with a different final job; **zero** with a
  different total; zero reversed automatic bookings (there are none while it
  is off).
- Per supplier: ≥ 5 clean, resolved decisions (*suppliers ready* in the card).
- The cap (`autoConfirmCapDollars`), grace window and lookback are set to
  values the owner can say out loud.
- The rollback is understood: knob **off** stops every scheduled booking; any
  automatic booking reverses from the invoice (Move / Exclude / Archive).

## The decision record (fill in, keep in `docs/decisions/` or the PR)

```
Automatic booking — enablement decision
Date:                  YYYY-MM-DD
Decided by:            <owner>
Evidence period:       YYYY-MM-DD → YYYY-MM-DD (N evaluated, M unresolved)
Gate result:           pass / fail (paste the ✓/✗ lines)
Scope:                 review-only stays / enable for suppliers: <list> (BuhlOS has no per-supplier switch today — enabling is global with "always review" on every other supplier)
Cap / grace / lookback: $ / h / d
Monitoring:            weekly shadow review continues; digest read every Monday
Rollback:              knob off at /owner; reverse any booking from the invoice
```

Enabling per supplier is **not a switch BuhlOS has** — the honest way to
start small is: enable globally, set *always review* on every supplier not
yet ready, and keep this review weekly.
