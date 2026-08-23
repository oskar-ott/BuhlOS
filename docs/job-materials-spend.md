# Job materials spend ledger (`job_materials_spend`)

The owner's pull (2026-08-23): *on one job, see the materials used and what they
are worth.* Before this the hub's Materials figure read
`jobs/<id>/materials-list.json` — a file the legacy materials tool wrote and the
2026-07-27 gut deleted the writer of — so it said "—" on every job forever.

## What it is

- **A per-job spend ledger**: one line per docket or invoice — date, supplier,
  what for (optional), amount **ex GST**. Typed by the office on the job hub
  (`/v2/jobs/[jobId]`, Materials card). Admin-tier only; a leading hand never
  sees it (the card hides on 403, like the Money card).
- **Store:** blob `jobs/<jobId>/materials-ledger.json` —
  `{ lines: [ { id, date, supplier, description|null, amountCents, createdBy,
  createdByName, createdAt, deletedAt?, deletedBy?, deletedByName? } ] }`.
  Covered by the backup manifest's `jobs/` prefix.
- **Money is integer cents** (P7). `$123.45` is `12345`.
- **Soft delete**: removing a line tombstones it (who/when); totals and
  listings exclude tombstoned lines.
- **One source for the figure**: `api/job-profitability.js` reads the same
  ledger (`materialSource: 'ledger'`), so the Money card's Materials cell and
  the ledger's total can never disagree. The legacy `materials-list.json`
  rollup stays as a fallback proxy for any job that still has one.
- **Audit**: `job.material_spend_added` / `job.material_spend_removed` in the
  canonical journal, **without the amount** (the journal is readable below the
  admin tier; supplier + date only).

## Surfaces

- `api/job-materials.js` — `GET ?jobId=` (lines + total), `POST ?jobId=`
  (add a line), `DELETE ?jobId=&id=` (soft-remove). 404 while the flag is off.
- `api/_lib/job-materials.js` — pure helpers (`validateLineInput`, `appendLine`,
  `removeLine`, `summariseLedger`).
- `src/domains/jobs/job-materials-client.ts` — typed client + the
  `buhlos:job-money-changed` window event the Money card listens for.
- `src/components/admin/JobMaterialsCard.tsx` — the hub card.

## What it is NOT

- Not the task-led **materials facet** (what a task *needs*, keyed by canonical
  task identity — `docs/architecture/task-led-job-architecture.md`). This is
  job-level commercial money, like `contractValue`, with no area/task linkage.
- Not procurement: no orders, receiving, supplier products or invoice matching.
- Not field capture. A Phil-side "I used X" path would enter the field
  cognitive budget (P10) and goes through governance §3 — a separate decision.

## Flag

`job_materials_spend` — admin-tier launch-gate, default **off**, expires
2026-11-30. Flip it Live at `/owner` to show the Materials card and feed the
Money card. Off = the Money card says materials spend isn't tracked yet (never a
fake "$0" or "no orders yet").
