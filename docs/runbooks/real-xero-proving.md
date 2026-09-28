# Real-Xero proving runbook

**Purpose.** Connect the **real** Xero organisation and prove one payroll
export end to end — draft timesheets in Xero that a person checks — before
the interim "Send to Tia" email is retired. What exists today: the whole
write stack is on `main` behind two admin-tier launch-gates
(`xero_connection`, `xero_payroll_export`, default off); it was proven
against Xero's **Demo Company** only; the real organisation has never been
connected. Background: [../hours-weekly-closeout.md](../hours-weekly-closeout.md),
[../hours-operational-loop.md](../hours-operational-loop.md),
[../regressions/payroll-export-blocked.md](../regressions/payroll-export-blocked.md)
(the freshness guard and why a stale read must fail loud).

**Boundary (unchanged, deliberate).** BuhlOS pushes **DRAFT timesheets** and
stops: no pay runs, approval, STP, tax, super or payslips. The pay run
finishes inside Xero. Nothing in this runbook changes that.

## Before touching the real organisation

| # | Step | Verify | Stamp |
| --- | --- | --- | --- |
| 1 | Confirm the interim path still works: the current pay week's *Send to Tia* email went out and was used | `/hours/period`, the recipient list at `/settings` | |
| 2 | Take a manual Blob backup snapshot | `GET /api/backup-snapshot?action=run` (cron auth) or wait for the daily 16:00 UTC run; see [../backups.md](../backups.md) | |
| 3 | Decide the **proving week**: a closed, locked week whose Xero pay run has **not** been finalised | The batch is *locked* on `/hours/period` | |
| 4 | Every worker on the batch has a Xero employee link and a work-type mapping; unmapped workers are **withheld** (not blocking) and get no export stamp | `/hours/period` readiness; `/settings/integrations/xero` mappings | |

## Connect

| # | Step | Verify | Stamp |
| --- | --- | --- | --- |
| 5 | `xero_connection` → **Preview for me** at `/owner` | `/settings/integrations/xero` renders | |
| 6 | OAuth to the **real** organisation as the owner (not Demo Company) | The connection card names the organisation; reference sync lists real employees, earnings rates and calendars | |
| 7 | Map each BuhlOS worker → Xero employee; each work type → earnings rate; check the pay calendar (Wed → Tue vs Mon → Sun — the batch's period must match the calendar) | No *unmapped* rows on the proving batch, or a conscious withhold list | |

## Prove one export

| # | Step | Verify | Stamp |
| --- | --- | --- | --- |
| 8 | `xero_payroll_export` → **Preview for me** (owner only) | The Preview / Export / Retry / Reconcile controls appear on `/hours/period` for the locked batch | |
| 9 | **Preview** the export | Row count and hours per worker equal the CSV / the Send-to-Tia figures for the same week | |
| 10 | **Export** | Draft timesheets appear in Xero → Payroll → Timesheets for the right calendar period, one per worker, hours matching | |
| 11 | **Reconcile** (readback) | Every exported row reconciles; withheld rows show `already_exported_excluded` only on a re-run, never a duplicate | |
| 12 | Re-run **Export** on the same batch on purpose | Duplicate refused (409 / no second timesheet in Xero) | |
| 13 | Rejected or reopened day after export: reopen one day, re-approve, re-lock | The batch says what changed; the export path refuses or re-exports exactly the changed rows as the doc describes — write down which | |
| 14 | An employee **missing from Xero** on the next batch | Withheld, named on the batch, not blocking the others | |
| 15 | Locked / already-paid period in Xero | Export refused with the period reason, not a silent partial push | |
| 16 | Recovery after a partial export (simulate: revoke the token mid-run in Xero, then reconnect) | Retry completes only the missing rows; Reconcile agrees | |

## Sign-off

Only when 8–16 are stamped for **one real pay week** may `xero_payroll_export`
go **Live** — and the Send-to-Tia email stays on for one more cycle as the
cross-check. Record: date, batch id, who checked Xero, what differed (if
anything) and how it was resolved.

## Rollback

- `xero_payroll_export` **off** at `/owner`: the export controls vanish; the
  CSV download and the Send-to-Tia email remain.
- Draft timesheets already in Xero: delete them **in Xero** (they are drafts);
  BuhlOS keeps the batch's export stamps — Reconcile will show the mismatch,
  which is the honest state.
- `xero_connection` **off**: the connection stays stored but unused; disconnect
  in Xero to revoke.
