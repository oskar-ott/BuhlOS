# Invoice mailbox activation checklist

**Purpose.** Turn supplier-invoice **email intake** on for the first time, in
the right order, and prove it with one real email before anyone relies on
it. The feature itself: [../invoice-capture.md](../invoice-capture.md)
(status block, "Inbound email", "External steps still required", "Catching up
on past emails").

**Ground truth at the time of writing (2026-09-28):** the code is on `main`;
the flag `invoice_capture` is a launch-gate (default off, admin tier); the
office mailbox forwarding rule has not been set up; the provider / DNS /
secret / migration steps cannot be verified from the repository. This
runbook does not perform any of them — a person does, and signs below.

## Order matters

1. **Flag first, mail second.** With the flag off, a correctly signed
   inbound email is *quarantined by id* and re-ingested by the sweep once the
   flag is on — nothing is lost, but nothing is visible either. Turn the flag
   on before forwarding anything, so the first email is seen the moment it
   lands.
2. **Manual upload needs only the flag.** If email intake is delayed, the
   office can still upload PDFs at `/invoices`.

## Checklist

| # | Step | Where | How to verify | Stamp (who · date · what you saw) |
| --- | --- | --- | --- | --- |
| 1 | Supabase production has every `supplier_invoice*` migration applied | Supabase dashboard → Database → Migrations (prod project) | The list ends with `20260925100000_supplier_invoice_receipts` (or later) | |
| 2 | Resend receiving is enabled on `buhlos.com` and the MX record exists | Resend → Domains; `dig MX buhlos.com` | Resend shows *send and receive*; `dig` returns the Resend inbound MX | |
| 3 | The Resend webhook exists for `email.received` → `https://buhlos.com/api/inbound/invoices` | Resend → Webhooks | Endpoint listed, event ticked, status healthy | |
| 4 | Production env carries `RESEND_INBOUND_WEBHOOK_SECRET` and `INVOICE_INBOUND_DOMAIN` (names only) | Vercel → Settings → Environment Variables → Production | Both names present; `RESEND_API_KEY` present (full-access) | |
| 5 | `invoice_capture` → **Preview for me** at `/owner`; open `/invoices` | `/owner`, `/invoices` | The inbox renders; the *Inbound email* card shows the address `invoices@buhlos.com` | |
| 6 | Upload one PDF by hand | `/invoices` → Upload | It reads, matches or lands in review — the pipeline works end to end without email | |
| 7 | `invoice_capture` → **Live** at `/owner` | `/owner` | State *On*, source *blob* | |
| 8 | Office mailbox forwarding rule: wholesaler emails → `invoices@buhlos.com` | The office mailbox (Outlook / Google) | Rule saved; test by forwarding one existing supplier email | |
| 9 | The test email appears in `/invoices` within a few minutes | `/invoices` | A new row from *email*; the *Inbound email* card shows a recent receipt; if it shows *quarantined*, the sweep (15 min) re-ingests it | |
| 10 | Replies to `timesheets@` / `office@` / `pay@` / `onboarding@` now route through Resend and are **forwarded to the accounts list** | `/settings` recipient list | The list is set; a test reply arrives at those addresses | |
| 11 | Catch-up: forward the backlog **after** the flag is on; ~20/min land at once, a hundred drain within the hour; invoices older than the auto-book lookback (90 d) always wait for a person | Mailbox | Rows appear; the sweep drains `received` 15+15 per run | |
| 12 | First week: review every item by hand; keep `autoConfirm` **off** (see [auto-booking-shadow-review.md](auto-booking-shadow-review.md)) | `/invoices` | | |

## Rollback

- Flag **off** at `/owner`: the inbox, cards and APIs disappear (404); new
  inbound email is quarantined by id, not lost; nothing already confirmed
  changes.
- Pause the mailbox rule if the flag must stay off for long — quarantined
  receipts pile up otherwise.
- A wrongly confirmed invoice: **Move / Exclude / Archive** on the invoice
  reverses its cost with the history kept.

## What "operational" means

Only after steps 8–9 are stamped and at least one real supplier email was
read, matched and confirmed by a person may the status block in
`docs/invoice-capture.md` say *email intake operational* — with the date and
the person.
