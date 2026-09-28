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
- **Supplier invoices add to it (2026-09-23)**: with `invoice_capture` on,
  the CONFIRMED supplier-invoice allocations for the job (Supabase
  `supplier_invoice_allocations`, active rows, credit notes negative) are
  added to the same Materials figure — `materialSource` stays `'ledger'` when
  the ledger has lines, is `'invoices'` when only invoices carry the figure,
  and the response's `supplierInvoices` names the invoice share so the card
  can say what the number is made of. The ledger is therefore for cash-sale
  dockets and anything that never came by email; the card says so, so the
  office does not retype captured invoices. An unreadable invoice store is
  reported (`unavailable`), never a quiet 0.
- **Audit**: `job.material_spend_added` / `job.material_spend_removed` in the
  canonical journal, **without the amount** (the journal is readable below the
  admin tier; supplier + date only). Since 2026-09-27 also
  `job.material_spend_duplicate_override` — see below.

## Possible duplicate cost (2026-09-27)

The Money card sums this ledger **and** the confirmed supplier-invoice
allocations (`docs/invoice-capture.md`). A docket typed here that an invoice
already books on the same job would therefore count **twice** — and until
2026-09-27 the only thing preventing that was a caption asking the office not
to retype captured invoices. Now the server checks, on **every** `POST`:

- It reads the job's **active** allocations on **confirmed** invoices
  (`store.jobActiveAllocations` — reversed allocations and excluded / archived /
  duplicate documents are not a cost and never appear), tenant-scoped.
- A candidate needs the **same supplier** (by the invoice pipeline's own
  lookup key, so "L&H", "L & H Group Pty Ltd" and "L&H GROUP PTY. LTD." agree)
  **and** either the **same supplier invoice number** as the optional
  *Docket / invoice number* field (strongest — the same once punctuation and
  case are dropped, "INV-00482" ≙ "inv 00482", or the same trailing number of
  4+ digits, "INV-001482" ≙ "1482"; a bare "482" does **not** match
  "INV-00482") or the **same amount within 14 days** of the invoice date. **Equal amounts
  alone are never a duplicate**; a credit note (negative) never matches a
  positive docket; a reused number at a different supplier never collides.
- A match answers **409 `possible_duplicate`** with the candidates (invoice
  id, supplier, number, date, amount, the reasons) — nothing is saved. The card
  shows **"Possible duplicate cost"**, links each invoice, and asks *why add
  it anyway*. Re-posting with `override: { reason }` (3–200 chars, mandatory)
  saves the line with a `duplicateOverride` stamp (reason, invoice ids,
  strength, who, when) and journals `job.material_spend_duplicate_override`
  (invoice ids + reason, **never the amount**). It is a warning with an
  audited override, not a block.
- When the invoice store cannot be reached the save proceeds and the response
  says `duplicateCheck: "unavailable"` — the office is never locked out of its
  own ledger, but it is told the check did not run. `"clear"` and
  `"overridden"` are the other answers.

What this does **not** do: it does not compare ledger lines with each other,
and it cannot see an invoice that has not been captured — the honest scope of
the data it has.

## Surfaces

- `api/job-materials.js` — `GET ?jobId=` (lines + total), `POST ?jobId=`
  (add a line), `DELETE ?jobId=&id=` (soft-remove). 404 while the flag is off.
- `api/_lib/job-materials.js` — pure helpers (`validateLineInput`, `appendLine`,
  `removeLine`, `summariseLedger`, and since 2026-09-27 `findPossibleDuplicates`,
  `referencesMatch`, `parseOverride`).
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
