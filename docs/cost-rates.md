# Confidential cost-rate store (#304)

The deliberate replacement for the single, sparse, leaky `users.json` `hourlyRate`
that every dollar figure in the system currently multiplies hours by.

## What it is

- **Store:** blob `workforce/cost-rates.json` —
  `{ rates: { [userId]: [ { id, costRateCents, chargeOutRateCents|null, effectiveFrom, setBy, setByName, setAt } ] } }`
- **Money is integer cents** (P7 — no invented precision; same discipline as the
  expenses domain). `$52.50/h` is `5250`. Display layers divide by 100.
- **Loaded cost vs charge-out:** `costRateCents` is the loaded cost to the
  business (wage + on-costs); `chargeOutRateCents` is the optional sell rate.
  The old `hourlyRate` conflated these with no statement of which.
- **Effective-dated history:** an edit **appends** a new entry, never overwrites.
  `effectiveCostRate(history, date)` returns the entry with the latest
  `effectiveFrom ≤ date`, so a past week is always costed at the rate that was
  effective **then**. Every entry records `setBy`/`setByName`/`setAt`.
- **Confidential:** `api/cost-rates.js` is **admin-tier only** on every method
  (`isAdminRole`). A leading hand — or any field worker — can neither read nor
  write rates. The legacy `hourlyRate` leak via `GET /api/users?action=listTradies`
  (the only non-admin user fetch) is closed: that response now strips
  `hourlyRate` alongside `passwordHash`.

## Surfaces

- `api/cost-rates.js` — `GET ?userId=` (history + current), `GET ?action=coverage`
  (hours-tracked workers with no rate), `POST` (append a rate).
- `api/_lib/cost-rates.js` — pure helpers (`effectiveCostRate`, `historyFor`,
  `validateRateInput`, `appendRate`, `costRateCoverage`).
- Admin UI — "Cost rate (admin only)" section in the employee detail drawer
  (view current + history, add an effective-dated rate). Keyed by the worker
  account id, like licences. The job hub's Money and Labour cards deep-link an
  unrated worker straight to that record ("Set rate →").

## Coverage — supersedes `staff-no-rate`

`costRateCoverage(users, store)` is the canonical "who is unrated" report over
`isHoursTrackedWorker`. The legacy `api/data-quality.js` `staff-no-rate` category
still keys off `users.json` `hourlyRate` and is intentionally left in place until
the consumers below migrate — it now reports the **legacy** field's sparseness,
which the cost-rate coverage report replaces for analytics decisions.

## Consumers (status 2026-08-23)

**Reading this store** — every per-job labour dollar the product shows:

- `api/job-profitability.js` — the job hub's Money card: APPROVED hours ×
  `effectiveCostRate(history, entry.date)`, unrated workers named (with the
  employee record the rate is set on), plus the optional charge-out value.
- `src/domains/jobs/job-hours.ts` `costJobHours` — the job hub's Labour card:
  the same maths client-side via `effectiveCostRateOn`, per worker, approved
  and awaiting costed separately — so the Labour card's approved cost IS the
  Money card's labour figure.
- `src/app/(admin)/hours/weekly/page.tsx` — the week board's labour $ (rate
  effective on the week's Monday).

**Still on the legacy `users.json` `hourlyRate`** (set for one worker in prod;
migrate in this order, each its own change, parity pinned before/after):

1. **`api/_lib/payroll-inputs.js`** — the payroll CSV's `Rate ex-GST` /
   `Line cost ex-GST` columns (`api/_lib/payroll-csv.js`). Highest-stakes
   path, so last to move; until it does those columns read $0 for unrated
   workers and must not be presented as cost.
2. **`api/crew-export.js`** — the crew export's rate column; move with the
   CSV.

**Deleted:** `api/costs.js` (the old admin Costs rollup — all statuses ×
`hourlyRate`, zero UI callers since the lean reset) was removed 2026-08-23 so
there is one labour-dollar engine, not three. `api/cash-watch.js` and
`api/crew-utilization.js` went with the 2026-07-27 gut.

**Quoting** (`src/domains/quoting/*`) used an *estimating* sell rate — a
deliberately separate number from a worker's confidential cost; it was deleted
in the gut and never read this store.

## What is NOT guaranteed

- No transactional storage: the store is a blob read-modify-write, so concurrent
  edits race like every other blob (last write wins on the array; history entries
  are individually append-only within a single request).
- No backfill of the legacy `hourlyRate` into the new store — rates are entered
  fresh by an admin (the old field's meaning was ambiguous, so importing it would
  fabricate certainty about what it represented).
