# ADR — the BuhlOS/Xero customer-invoicing boundary (BuhlOS drafts, Xero owns the invoice)

**Status:** Proposed 2026-11-22 ([#1147]). Accepted when this PR merges.
**Deciders:** Oskar (owner) · platform
**Relates to:** Epic [#184] (Xero Integration), [#1147] (this ADR), [#1148] (stages),
[#1149] (permissions, client link, defaults), [#1150] (send as draft),
[#1151] (paid status), [#1152] (IV numbers).
**Extends:** [payroll-boundary-adr.md](payroll-boundary-adr.md),
[integration-credential-storage-adr.md](integration-credential-storage-adr.md),
[00-rebuild-non-negotiables.md](00-rebuild-non-negotiables.md),
[data-ownership-map.md](data-ownership-map.md).
**Build plan:** [../product/job-invoicing-xero-plan.md](../product/job-invoicing-xero-plan.md).

## Context

BuhlOS holds a job's hours and its supplier invoices, so it knows what a job has
cost. It does not know what the job has been **paid**. Commercial jobs are paid
in stages over months; today each stage invoice is raised in ServiceM8 and
pushed to Xero. That is the last thing ServiceM8 does for the business (owner
pull, 2026-11-22).

The only ratified Xero write is draft payroll timesheets
([payroll-boundary-adr.md](payroll-boundary-adr.md)). That ADR rejects
Accounting-API journals **as a way to do payroll**; it says nothing about
customer invoices. A sales invoice is a new kind of write, to a different API,
with a different failure cost: a wrong one reaches a client and the books. The
boundary is therefore ratified here before the write ships.

The old progress-claims feature ([#372]) was deleted in the 2026-07-27 gut.
Nothing of it is reused.

## Decision

Adopt the operating rule **"BuhlOS drafts, Xero owns the invoice."**

1. **Ownership split is fixed** (§ Ownership split).
2. **Draft only.** BuhlOS creates sales invoices in Xero with `Status: DRAFT`
   and nothing else. It never approves, emails, voids, deletes or edits an
   invoice in Xero, and never records a payment. Promotion to anything beyond
   a draft needs an amendment to this ADR.
3. **Create-only call.** The send uses the Accounting API's create-only method
   (`PUT /Invoices`), never the create-or-update method, so a send cannot
   overwrite an existing invoice.
4. **A send can never duplicate.** Three independent guards, all required:
   the BuhlOS row is moved to `sending` by compare-and-swap before the call;
   the invoice number (`<job code>-<n>`) is unique in Xero; an
   `Idempotency-Key` is sent. Before any second attempt BuhlOS looks the number
   up in Xero and **adopts** what it finds instead of sending again.
5. **"Sent" means read back and matched.** After Xero accepts, BuhlOS reads the
   invoice back and compares contact, status, lines and subtotal. A push that
   ran is not a push that landed (P7). The pending event is written **before**
   the call; every attempt is an immutable row.
6. **Xero's figures win.** For anything already sent, BuhlOS shows Xero's
   status and amounts, never its own arithmetic. An edit made in Xero is shown
   as changed, not hidden and not reverted.
7. **A sent stage is frozen in BuhlOS.** Numbers are never reused: a stage whose
   draft was deleted or voided in Xero stays as history, and raising it again
   makes a new stage with the next number.
8. **Explicit links, never guessed at send time.** The job's client is linked to
   a Xero contact by a person. Sales account and tax rate are chosen from
   Xero's own lists. Only `ContactID` is sent in the invoice's contact element,
   so BuhlOS cannot edit a contact as a side effect.
9. **Data minimisation.** From Xero BuhlOS keeps: contact id and name, account
   code and name, tax type, name and rate, invoice id, number, status, totals
   and dates. No addresses, emails, bank details or contact people. Contacts
   are searched live, not cached wholesale.
10. **Scopes are flag-gated.** The connect flow requests `accounting.invoices`
    and `accounting.contacts.read` only while `customer_invoices` is on for the
    connecting admin. A default connection is unchanged.
11. **Region scope = Australia**, as for payroll. No region abstraction.
12. **Money is integer cents** in every new table. Audit entries carry no
    amounts (the journal is readable below the admin tier).

## Ownership split

| Data / responsibility | Owner | Note |
|---|---|---|
| A job's stage schedule (titles, amounts, % of contract, planned dates) | **BuhlOS** | Exists only in BuhlOS until sent |
| Retention % per job and the retention held | **BuhlOS** | Sent to Xero as a negative line; released by a later stage |
| Job ↔ Xero contact link; default sales account, tax rate, terms | **BuhlOS** | Explicit, confirmed, organisation-scoped |
| Send attempts, events and sync state | **BuhlOS** | Immutable attempts + append-only events, correlation ids |
| The invoice once sent: number sequence for other invoices, approval, emailing, due-date chasing, statements | **Xero** | BuhlOS never does these |
| Payments, credit notes, allocations, the receivables ledger | **Xero** | BuhlOS mirrors amount paid / due / credited, read-only |
| Contacts, chart of accounts, tax rates | **Xero (source)** | BuhlOS reads; never creates or edits |
| Job costing and "is this job making money" | **BuhlOS** | Paid and invoiced figures come from the Xero mirror |

## Consequences

- **P7 obligation:** every exchange is loud and reconcilable. A rejected send
  shows Xero's own sentence; an unknown outcome stays `sending` until resolved
  by look-up; nothing is silently dropped. No invented numbers: GST and totals
  for a sent invoice are Xero's.
- **P8 obligation:** while Xero is disconnected, connected to another
  organisation, or connected without invoice permission, the surface states it
  and how to fix it. Planned stages stay usable.
- **Two systems can disagree, by design.** BuhlOS does not police Xero. If the
  office edits or deletes a draft in Xero, BuhlOS follows.
- **Backups:** planned stages are irreplaceable BuhlOS rows. The credential ADR's
  Pro/PITR gate applies before real rows land ([#897]).
- **ServiceM8** is not integrated, migrated or imported
  (see `docs/product/02-lean-reset.md`; the sync stays dark).

## Constitution gate

This is an office (admin-tier) integration boundary: an architecture direction,
**not** a behavioural amendment to the ratified Phil package. No field worker
sees money. It serves **P7** and **P8** and follows the payroll ADR's write
pattern. Merging this ADR clears the Constitution Gate for the first
Accounting-API write ([#1150]). The one field-visible part of the programme,
server-issued IV numbers ([#1152]), is governed separately in its own PR under
the Phil package (P7, P10: no new slot).

Repo-docs PR first; wiki sync after merge.

## Addendum, 2026-11-22: itemised invoices, job data and variations

Part 2 ([#1161]–[#1164],
[../product/job-invoicing-part-2-plan.md](../product/job-invoicing-part-2-plan.md))
adds a second kind of invoice and the variations register. **The boundary does
not move**: BuhlOS still only creates drafts, and Xero still owns the invoice
once it exists. Five rules are added to the ones above.

13. **An invoice may be itemised.** Its lines are BuhlOS's until it is sent and
    frozen after, exactly as a stage is. Xero receives each line's
    description, quantity, unit price, account and tax type, and nothing else.
14. **Price is the office's; cost is BuhlOS's.** A person may set any sell
    price. The cost of a line pulled from the job is worked out on the server
    from the job's own records and is never taken from the browser. Cost,
    markup, where a line came from and what it bills never leave BuhlOS.
15. **"On an invoice" is derived, never flagged.** What hours, materials and
    variations are billed is read from the lines of the job's live invoices.
    An invoice that is removed, or that Xero shows deleted or voided, no longer
    holds what it billed. A write that depends on the answer runs under a
    per-job lock in the same transaction.
16. **Variations are BuhlOS's.** Approved variations add to the contract in
    BuhlOS's own figures. Only an approved variation is billed, once, at the
    approved amount. Xero is told nothing about a variation beyond the invoice
    line that bills it.
17. **Wording added to an invoice is opt-in and frozen.** Payment-claim wording
    is off unless the office turns it on for a job, and what was sent is kept
    on the row so a retry sends the same invoice.

No new Xero scope, endpoint or write is introduced. The one write remains the
create-only draft invoice.

## Alternatives considered

- **Keep ServiceM8 for invoicing.** Rejected by the owner: it is the only
  remaining reason to pay for and double-enter into ServiceM8.
- **Create approved invoices directly.** Rejected for now: a mistake would be on
  the books and one click from a client. Draft-first mirrors the payroll path.
- **Let Xero number the invoices.** Rejected by the owner: `IV3345-2` tells the
  office, the builder and the wholesaler which job and stage it is, and the
  uniqueness of the number is a second guard against a double send.
- **Cache all Xero contacts.** Rejected: it copies data Xero owns for no gain. A
  live search is enough.
- **Xero webhooks for payment status.** Deferred: an hourly check is enough at
  this volume and needs no public endpoint.
- **Xero Projects or tracking categories for job profit.** Deferred: the owner
  wants job profit in BuhlOS, which already holds the costs.

[#184]: https://github.com/oskar-ott/BuhlOS/issues/184
[#372]: https://github.com/oskar-ott/BuhlOS/issues/372
[#897]: https://github.com/oskar-ott/BuhlOS/issues/897
[#1147]: https://github.com/oskar-ott/BuhlOS/issues/1147
[#1148]: https://github.com/oskar-ott/BuhlOS/issues/1148
[#1149]: https://github.com/oskar-ott/BuhlOS/issues/1149
[#1150]: https://github.com/oskar-ott/BuhlOS/issues/1150
[#1151]: https://github.com/oskar-ott/BuhlOS/issues/1151
[#1152]: https://github.com/oskar-ott/BuhlOS/issues/1152
[#1161]: https://github.com/oskar-ott/BuhlOS/issues/1161
[#1164]: https://github.com/oskar-ott/BuhlOS/issues/1164
