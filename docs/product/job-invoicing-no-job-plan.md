# Job invoicing: an invoice with no job (#1166)

**Status:** built, dark behind `customer_invoices`. What is built is recorded in
[../customer-invoices.md](../customer-invoices.md) → "An invoice with no job".
This page is the research and the decisions behind it.

**The pull (owner, 2026-11-25):** on builder work the money is released
monthly, most often through Payapps. Once a month one invoice is raised for
all the money coming in; claims and variations are settled through it. "I want
to create an option that allows you just to create one invoice and send it to
Xero … it won't be tied to a job."

**Hypothesis:** the office raises the monthly invoice from BuhlOS instead of
typing it into Xero, because it is the same few fields and the paid status
then shows beside the job invoices.

## 1. What was looked at

- **Payapps.** A payment-claims platform: the subcontractor submits a claim
  against the builder's contract, the builder assesses and approves it, and
  money is released on the payment schedule, usually monthly. Payapps is
  listed in Xero's app store with its own integration: an invoice can be
  created in Xero when a claim is submitted or when it is approved, with each
  claimed line, retention and tax on it and the claim PDF attached
  ([Xero App Store listing](https://apps.xero.com/au/app/payapps)). These are
  vendor and customer-story sources; it has not been tried on this business's
  accounts.
- **What that means here.** If most monthly claims go through Payapps, its own
  Xero link may remove the typing altogether, with no BuhlOS involvement. That
  is the owner's call and needs a look at the real Payapps account. The pull
  as stated is wider (any invoice with no job) and smaller (one invoice, typed),
  so that is what was built.
- **The existing invoice path.** Everything that makes a send safe is per
  invoice, not per job: the number claimed before the send, the create-only
  draft, the read-back, the look-up by number before any retry, the hourly
  status check. Only three things came from the job: where the invoice is
  kept, who it is for, and its number.

## 2. Decisions

| Decision | Why |
| --- | --- |
| An invoice with no job is an ordinary **itemised** invoice in a reserved ledger (`job_legacy_id = '~no-job'`) | reuses the whole proven path; a job id is a slug and can never contain `~` |
| Its **client is chosen on the invoice**, confirmed against Xero | there is no job to carry a linked client; the stored name is Xero's (boundary rule 8) |
| **BuhlOS numbers it**, from its own series `GEN-0001` | the number is what a retry looks up, so it must exist before the send; a job number would be untrue; `GEN-` is not a prefix Xero's own numbering uses |
| **Typed lines only** | with no job there is no job data to bill |
| **No retention, variations or payment-claim wording** | all three are per job |
| Its own **page**, `/getting-paid`, in the Jobs group | "Invoices" in the nav already means supplier invoices coming in; "Getting paid" is what the job card is called |
| It **does not count toward any job** | it belongs to none; an invoice that should count belongs on the job |

## 3. Not in this build

- Tagging a line with the job it pays for, so monthly money shows on jobs.
- The office's usual charges in this editor.
- Choosing the number or its prefix in Settings.
- Anything that talks to Payapps.

## 4. Before it can be used

1. **Done 2026-11-25.** The migration
   `20261126100000_customer_invoices_no_job.sql` is on dev and production
   (owner-approved each time), applied **before** the code that needs it went
   live with the flag on.
2. The proving run on a test Xero organisation still owed for the whole
   feature, now including one invoice with no job.
