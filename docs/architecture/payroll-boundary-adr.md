# ADR — the BuhlOS/Xero payroll boundary (Phil submits, BuhlOS approves, Xero pays)

**Status:** Accepted 2026-06-21 (#614) · **Amended 2026-07-13** — Milestone 4 export convergence ([#895]/[#249]): the locked payroll batch is the single export source (see Consequences → Export convergence).
**Deciders:** Oskar (owner) · platform
**Relates to:** Epic [#184] (Xero Integration), Epic [#122] (Hours & Payroll),
[#609] (this ADR), [#247] (connect), [#610] (read reference data),
[#248] (worker→employee map), [#611] (work-type→earnings-rate map),
[#249] (timesheet push), [#250] (reconcile), [#251] (sync health),
[#612] (draft-vs-approved decision), [#613] (one-cycle field validation).
**Extends:** [task-led-jobs-adr.md](task-led-jobs-adr.md),
[00-rebuild-non-negotiables.md](00-rebuild-non-negotiables.md),
[data-ownership-map.md](data-ownership-map.md),
[supabase-storage-migration-adr.md](supabase-storage-migration-adr.md).

## Context

The business runs payroll through **Xero**, with workers using **Xero Me** for
time. BuhlOS + Phil already field-deploy the hours loop — one-tap standard day,
job attribution, weekly closeout/approval, committed CSV export (Epic 9, in
production). The last manual step is someone downloading that CSV and **re-typing
every row into Xero**: the single biggest recurring double-entry in the office,
under payday pressure, where payslip errors are born.

**Xero Me is a self-service surface over Xero Payroll** (payslips, leave,
timesheets, personal details), not a separate engine or developer API. Parity
with Xero Me is therefore achieved by writing the right data **into Xero
Payroll**, never by integrating to Xero Me directly.

No Xero connection exists in the repo yet (no OAuth, no SDK, no token store, no
API call — verified). The first Xero write ([#249]) hard-codes a boundary, and
payroll is compliance-heavy and jurisdiction-specific. That boundary must be
**ratified before the write ships**, not discovered after a wrong push lands on
someone's payslip.

## Decision

Adopt the operating rule **"Phil submits, BuhlOS approves, Xero pays."** BuhlOS is
the operational time-capture, approval, audit, job-costing and export layer; Xero
remains the **payroll system of record**. Concretely:

1. **Ownership split is fixed** (§ Ownership split below).
2. **Integration path = Xero Payroll API timesheet push** ([#249]), **draft-first**
   — not summarised accounting journals (see Alternatives).
3. **Gate: no Xero payroll *writes* until** the approval + Xero-ready export +
   explicit-mapping foundations exist. Order: [#247] connect → [#610] read
   reference → [#248]/[#611]/[#254] map → [#249] push (paired with [#250]).
4. BuhlOS **caches** selected Xero reference data (employees, calendars, earnings
   rates, leave types) for **mapping/validation only** ([#610]); the cache is
   **never authoritative**.
5. BuhlOS **never** creates pay runs, generates payslips, files STP, or stores
   statutory tax/super/bank calculation logic. **Data minimisation:** do not copy
   PII Xero owns. (AU TFNs are masked on retrieval and non-roundtrippable — design
   reconciliation accordingly, never as a full mirror.)
6. **Region scope = Australia** (Xero Payroll AU). Xero's payroll APIs are
   region-specific; NZ/UK differ (UK exposes GET pay runs, not create) and the
   **US has no equivalent public Payroll API** (Gusto-powered). **Do not** build a
   speculative region-adapter abstraction — re-open this clause only if the
   business adds a non-AU entity.
7. **Time attribution keys off canonical task identity** (`ct_<hash>` / `tasks.id`).
   The `jobId + areaId + stage + taskId` tuple is the **labelled compatibility
   bridge**; `taskInstanceId` is the target term (per the task-led ADR +
   data-ownership-map §0). Payroll work must not deepen area-owned task arrays.

## Ownership split

| Data / responsibility | Owner | Note |
|---|---|---|
| Worker-entered time + site/task/job context | **Phil → BuhlOS** | Phil captures; BuhlOS holds the operational record + allocations |
| Approval workflow + audit trail | **BuhlOS** | Xero is never asked to approve; approval evidence stays local |
| Job costing / labour-by-job/stage | **BuhlOS** | `time_entries`, per-job ledger ([#134]) |
| Export/push batches + Xero sync-state | **BuhlOS** | immutable `payroll_batches` snapshot + append-only timesheet attempt/event records (pending → accepted_by_xero → verified_against_xero / rejected, `X-Correlation-Id`) |
| Worker↔employee, work-type↔earnings-rate, job↔tracking maps | **BuhlOS** | explicit confirmed links ([#248]/[#611]/[#254]); never name-guessed at push time |
| Employee payroll record, tax, super, bank details | **Xero** | BuhlOS does not copy or compute |
| Pay calendars, earnings rates, leave types | **Xero (source)** | BuhlOS holds a **non-authoritative cache** for mapping ([#610]) |
| Leave balances, payslips, pay runs, STP | **Xero** | read-only links at most; BuhlOS never generates these |

## Consequences

- **Positive:** the boundary is decided once — [#247]–[#613] build to a single line;
  BuhlOS stays *integration, not payroll*, minimising compliance/legal blast radius.
- **P7 obligation (binding acceptance criteria, not nice-to-haves):** every Xero
  exchange is **loud and reconcilable**. A push that "ran" is not a push that
  "landed" ([#250]); unmapped/rejected items are **named**, never silent
  drops ([#248]/[#249]/[#251]). No faked payroll state, no invented numbers.
  *(Amended 2026-07-26, owner-ratified via the lean-reset replica's closeout
  Xero stage: workers with no confirmed Xero employee link are **withheld with
  a named warning** — their hours stay out of the batch and the rest pushes —
  instead of blocking the whole period. The blocking error remains only when no
  payable worker is mapped. Mapped-but-broken links stay blocking errors.
  Nothing is silently dropped: the withheld list is itemised on the batch.)*
- **P8 obligation:** while Xero is disconnected, every dependent surface **states it
  and how to reconnect** ([#247]) — never errors or hides.
- **Data minimisation:** BuhlOS holds no statutory tax/super/bank truth; sensitive
  identifiers are write-sensitive and non-roundtrippable.
- **Export convergence (amended 2026-07-13, M4 [#895]/[#249]):** the **locked payroll
  batch is the single export source** for BOTH the Xero draft-timesheet push and the
  CSV fallback. The CSV fallback is **preserved** — but it now downloads **from the
  immutable batch snapshot** (`payroll_batch_items`), not from live stamped hours.
  The legacy stamp-based committed-run in `api/time-entries-export.js` (the non-dry-run
  GET commit + POST finalise + `payroll-runs.json` write) is **retired**; that file
  keeps only its read-only preview/rollup GET. This **supersedes** the original clause
  ("the push extends the CSV seam, it does not replace it"): there is now **one** export
  mechanism, not two competing ones. Double-export protection moves from live time-entry
  `exportId` stamps to batch membership + the batch's own attempt/event records; the
  per-worker entry stamp remains only as a **compatibility bridge**, written after a
  push is accepted **and** reconciled.

## Constitution gate

Per **Phil Constitution P15**, a payroll *integration boundary* is an
architecture/fact-tier direction, **not** a behavioural amendment to the ratified
Phil package → **no constitutional amendment required** (same framing as the
task-led ADR; Phil's place-first navigation is untouched). It **serves P7** (truth
over theatre — loud reconcilable sync, honest "didn't sync" paths) and **P8**
(honest degradation — a disconnected Xero is stated, not hidden). It **follows**
the task-led ADR (attribution keys off canonical task identity) and the Supabase
ADR (payroll-grade data demands the Pro/PITR backup gate before real rows land).
Merging this ADR **clears the Constitution Gate for the first Xero write** ([#249]).
Repo-docs PR first; **wiki sync after merge** (the wiki-touch rule).

## Delivery sequence (threads Epic [#184] + Epic [#122])

1. **This ADR** — ratify the boundary.
2. **BuhlOS-owned payroll data foundation** — [#134] (per-job ledger) + [#131]
   (pay-period roll-up); export-batch/sync-state shapes in [#249]/[#250].
3. **Phil entry + weekly admin approval** — *shipped* (Epic 9); extended by
   [#128]/[#129]/[#130].
4. **Xero-ready export pack** — *shipped* (CSV); Xero-shaping is [#249]'s seam.
5. **Connect** — [#247] (OAuth2 + tenant + token health).
6. **Read-only reference sync** — [#610].
7. **Explicit mappings** — [#248] (workers) + [#611] (work types) + [#254]
   (jobs→tracking).
8. **Draft timesheet push** — [#249] (same-release pair with reconciliation).
9. **Reconcile + sync-health dashboard** — [#250] + [#251].
10. **Draft-vs-approved promotion decision** — [#612].
11. **Field validation: one pay cycle vs Xero Me** — [#613].

## Alternatives considered

- **Accounting-API journals / AP bills** (post summarised payroll to the GL instead
  of Payroll timesheets) — *rejected*: Xero's documented path for an *external*
  payroll engine, but it does **not** reproduce Xero Me, doesn't populate
  leave/timesheet/payslip self-service, and weakens employee parity. Only relevant
  if BuhlOS *becomes* the payroll engine — which this ADR declines.
- **BuhlOS as payroll engine** (compute pay, payslips, STP, leave balances) —
  *rejected*: inherits jurisdiction-specific statutory compliance and legal risk
  for no advantage; Xero already does it as system of record.
- **Region-agnostic payroll abstraction (AU/NZ/UK/US)** — *rejected as speculative*:
  the business is AU-only; the US has no public Payroll API. Add a region only when
  a real non-AU entity exists.
- **Integrate directly to Xero Me** — *rejected*: Xero Me is self-service UI over
  Xero Payroll, not an API target.
- **Push approved (not draft) timesheets from day one** — *deferred to [#612]*:
  draft-first until several clean draft cycles build trust.
