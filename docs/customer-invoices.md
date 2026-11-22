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
| Boundary record | [#1147](https://github.com/oskar-ott/BuhlOS/issues/1147) | This document set |
| Stages on the job page, no Xero | [#1148](https://github.com/oskar-ott/BuhlOS/issues/1148) | **Planned, not built** |
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
