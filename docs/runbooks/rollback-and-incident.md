# Rollback and incident steps

**Purpose.** When production is wrong, stop the bleeding first, then undo,
then learn. The existing pieces this runbook strings together:
[../deploy-checklist.md](../deploy-checklist.md) (Rollback),
[../backups.md](../backups.md) (Restore runbook, restore drill),
[../feature-flags.md](../feature-flags.md) (Flipping a flag),
[../owner-console.md](../owner-console.md), and the regression records in
[../regressions/](../regressions/).

## First five minutes

| # | Ask | Do |
| --- | --- | --- |
| 1 | Is money or someone's pay wrong, or about to be? | Yes → stop the loop first (flag off / knob off / mailbox rule paused), then read on. No → read on. |
| 2 | Is it one feature? | Flag **off** at `/owner` (audited, no deploy). Kill-switches: `jobs`, `hours`, `evidence`, `employees`, `gear`, `job_photos`. Launch-gates: everything else. |
| 3 | Is it the last deploy? | Vercel → Deployments → promote the previous production deployment (deploy-checklist "Rollback"). `main` is unchanged; open a revert PR afterwards. |
| 4 | Is data wrong? | Do **not** edit stores by hand. Read [../backups.md](../backups.md) "Restore — runbook": every restore takes a `pre-restore-*` safety snapshot first. |
| 5 | Tell the office | One sentence in the group chat: what is off, what still works (e.g. "Invoices inbox is off for an hour; hours and photos work"). |

## Feature-specific undo

| Feature | Stop | Undo | Evidence kept |
| --- | --- | --- | --- |
| Supplier invoices (email intake) | `invoice_capture` off → routes 404; inbound mail **quarantined by id**, re-ingested when on again. Pause the mailbox rule if off for long. | A wrongly confirmed cost: **Move / Exclude / Archive** on the invoice — the allocation is **reversed**, never deleted. | Invoice history (events), audit journal. |
| Automatic booking | `autoConfirm` knob **off** at `/owner` → every scheduled booking stops (the sweep re-checks the knob). | Reverse any automatic booking from the invoice (above); the shadow report shows it as *auto-booked then reversed*. | `auto_confirmed` / `reversed` events. |
| Receipts from the field | `receipt_capture` off → the My Day tile disappears. | Exclude wrong receipts in the inbox. | Same as invoices. |
| Manual materials ledger | `job_materials_spend` off → card and API 404. | Remove a wrong line from the card (soft delete; journalled). | `job.material_spend_*` journal. |
| Payroll / Xero export | `xero_payroll_export` off → export controls vanish; CSV + Send-to-Tia remain. | Delete draft timesheets **in Xero**; BuhlOS keeps the export stamps; Reconcile shows the mismatch. | Batch export stamps, audit. |
| Hours (the spine) | `hours` kill-switch off hides the surfaces — last resort; the time-entry APIs stay up as infrastructure. | Per-day edits via the existing Fix / reopen paths. | Hours journal (`editedWhileSubmittedAt`). |

## Severity

| Sev | Meaning | Example | Response |
| --- | --- | --- | --- |
| 1 | Money or pay wrong for a real person, or data loss | Payroll export sent wrong hours; a Blob store truncated | Stop + rollback now; owner on the phone; restore from snapshot if needed; regression doc within a day |
| 2 | A loop is blocked for everyone | Nobody can log hours; inbox 500s | Flag off / promote previous deploy; fix forward same day |
| 3 | One feature degraded, workaround exists | Invoice parser mis-reads one supplier | Ticket; fix in the next cycle |

## After

1. Write the regression record (`docs/regressions/<name>.md`): root cause,
   why the guard did not catch it, the guard added, how to re-check
   production before changing it — the pattern of
   [../regressions/payroll-export-blocked.md](../regressions/payroll-export-blocked.md).
2. If a flag was flipped, leave it flipped until the fix is **on `main` and
   deployed** — never "turn it back on to see".
3. Stamp below.

| Date | What happened | Sev | Stop step | Undo step | Regression doc | Who |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |
