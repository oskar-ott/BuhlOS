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
  account id, like licences.

## Coverage — supersedes `staff-no-rate`

`costRateCoverage(users, store)` is the canonical "who is unrated" report over
`isHoursTrackedWorker`. The legacy `api/data-quality.js` `staff-no-rate` category
still keys off `users.json` `hourlyRate` and is intentionally left in place until
the consumers below migrate — it now reports the **legacy** field's sparseness,
which the cost-rate coverage report replaces for analytics decisions.

## Migration order for existing `hourlyRate` consumers

This issue is **additive**: the new store and helper land without changing any
money math. The existing consumers still read `users.json` `hourlyRate`. They
migrate onto `effectiveCostRate(...)` in this order — no silent dual-source drift,
each its own change:

1. **`api/costs.js`** (admin Costs rollup) — the most direct labour-$ consumer.
   First to move; pin parity per job/week before/after.
2. **`api/cash-watch.js`** (`labourSpent`) — daily spend vs contract; move with
   `costs.js` so the two never disagree.
3. **`api/crew-utilization.js`** / **`api/crew-export.js`** — utilisation $ and
   the payroll-adjacent export; move together.
4. **`api/time-entries-export.js`** — if it carries a rate, last (payroll export
   is the highest-stakes path).
5. **Quoting** (`src/domains/quoting/labour-calc.ts`, `margin.ts`,
   `api/quotes.js`) — quoting uses an *estimating* sell rate, a deliberately
   **separate** number from a worker's confidential cost; it does **not** migrate
   to this store. Documented here only so it isn't mistaken for a consumer.

Job profitability (#327) is the first NEW consumer and reads the store directly
via `effectiveCostRate`.

## What is NOT guaranteed

- No transactional storage: the store is a blob read-modify-write, so concurrent
  edits race like every other blob (last write wins on the array; history entries
  are individually append-only within a single request).
- No backfill of the legacy `hourlyRate` into the new store — rates are entered
  fresh by an admin (the old field's meaning was ambiguous, so importing it would
  fabricate certainty about what it represented).
