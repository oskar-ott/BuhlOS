# Document-retention policy — decision record (template)

**Status: DECISION NOT YET MADE.** This is the template the owner fills in.
Until it is filled, BuhlOS keeps everything it captures indefinitely — that
is the current, undocumented behaviour, and it is a decision by omission.

## What is stored today, where, and by whom it is readable

| Data | Where | Readable by | Deleted when |
| --- | --- | --- | --- |
| Supplier invoice **PDFs** and receipt **photos** | Vercel Blob, private, under `invoices/<tenant>/…`, served only through the authenticated proxy (`/api/invoices?action=document`) | Admin tier | Never (no purge exists) |
| Invoice **metadata, lines, allocations, history (events)** | Supabase Postgres (`supplier_invoice*` tables) | Admin tier via the API | Never; archive / exclude keep the rows |
| Inbound email **receipts** (Svix ids, status, subject excerpt) | Postgres `supplier_invoice_inbound_events` | Admin tier (inbox card) | Never |
| Extracted **text excerpt** of each document | Postgres (`extracted_text_excerpt`) | Admin tier | Never |
| **Audit journal** entries (who did what; supplier + date; never the amount) | Blob `audit/<yyyy-mm>.json` | Staff tier (cross-job journal) | Never |
| Daily **Blob snapshots** | Blob `backups/` | Nobody through the app | Pruned: newest 14 daily + Monday sets within 8 weeks ([../backups.md](../backups.md)) |

Not stored: the email body beyond the excerpt, the sender's mailbox, bank
details, anything from the PDF that is not extracted.

## Questions the decision must answer

1. **Legal minimum.** Australian tax records are generally kept **5 years**
   from lodgement — confirm with the accountant; invoices supporting job
   costs may need longer where a contract or warranty runs longer.
2. **Operational need.** How long does the office look back at an invoice?
   (Statements reconcile within a quarter; disputes within a year.)
3. **Privacy.** Receipts from the field can show a worker's card last digits
   and name; photos can show more than the receipt. Is a shorter retention
   for photos than for PDFs wanted?
4. **What "delete" means.** Purge the binary and keep the metadata + history
   (recommended: the cost record survives, the document does not), or purge
   both? Reversed/excluded documents — same rule or shorter?
5. **Who may delete, and is it audited?** (Today: no one; nothing deletes.)
6. **Backups.** A purge must also age out of the snapshots (they follow the
   14-day / 8-week rule automatically).

## Decision

```
Retention policy — supplier documents
Date:              YYYY-MM-DD
Decided by:        <owner> (with <accountant> on the legal minimum)
PDFs / photos:     keep <N> years from invoice date, then purge the binary (metadata + history kept) — or: keep indefinitely
Reversed/excluded: same / <shorter>
Inbound receipts:  <N> months
Text excerpts:     with the document / with the metadata
Who may purge:     <role>; audited as <action>
Implementation:    a scheduled purge behind a flag (not built — needs a ticket), or a manual quarterly step (runbook)
Review date:       YYYY-MM-DD
```

## After the decision

Open a ticket that names the policy above verbatim; the purge itself is a
runtime change (cron + audit action + a "purged" state on the document row)
and goes through the normal PR path. Until it ships, this record is the
policy and "keep everything" is the practice.
