# /reports — the owner numbers dashboard (#316)

The six numbers the owner checks daily, on one v2 admin screen, each with
a week-over-week direction where its source provides one and a one-click
drill-down to the records behind it.

**Status of the set: ratified by default — owner edits welcome.** The six
below are the #316 candidate set built as ratified by the orchestrator;
swapping a tile is a normal change (edit the definition module + this
doc in one PR). When the KPI engine lands (#329), the tiles re-point at
the engine and quote identical numbers from one layer — this page does
not change shape.

## The six, their sources, their definitions

Every number is defined in **one place**:
`src/domains/analytics/owner-numbers.ts` (the seed of #329 — one exported,
unit-tested definition per tile; payload in → `{value, trend, state,
drillHref, honestNote}` out). The `/reports` page renders only what that
module returns. No metric math anywhere else.

| # | Tile | Source (one per number) | Definition | Drill-down |
| --- | --- | --- | --- | --- |
| 1 | Hours this week | `GET /api/compare-weeks` | thisWeek submitted + approved hour totals; trend = same sum for lastWeek, subtracted. lastWeek 0 → "New this week" (the endpoint's `pct: null` convention — never ∞). Mid-week renders a "week in progress" note so Monday never reads as a collapse. | `/hours` |
| 2 | Approvals waiting | `GET /api/time-entries?scope=approver&status=submitted` | Count of submitted entries — the SAME source the command-centre queue card and Today strip count, so the surfaces cannot disagree. | `/hours/approvals` |
| 3 | On the clock today | `GET /api/today-pulse` | `hours.crewOnSite` (distinct users with >0 logged hours today). Labelled **"on the clock"**, never "on site" — a time entry proves logging, not presence. | `/hours` |
| 4 | Open defects — high-priority or stale | `GET /api/snags-all?status=open` | Union of open rows that are high-priority (`urgent`/`high`) or stale. Stale thresholds are `api/admin-stats.js`'s existing `STALE_THRESHOLDS` (High 3 / Medium 7 / Low 14 days) mapped through `api/snags-all.js`'s own legacy→v2 priority mapping; `urgent` shares high's 3-day tier. | `/defects?status=open` |
| 5 | Active quotes | `GET /api/quote-stats` | The endpoint's own vocabulary: `active` count headline, sum of its per-stage `stale` counts in the detail. Empty register → honest "No quotes in the register yet", not a confident 0. **No drill link** — verified there is no quoting surface in the v2 shell (legacy `/admin/quotes` 307s to `/command-centre`); a dead end is worse than no link. Re-point when quoting ships. | — |
| 6 | Jobs forecast over contract | `GET /api/jobs` (persisted `job.cashWatch`) | Count of active jobs carrying a persisted overrun alert written by the daily cash-watch cron. **Never** runs `cash-watch?dryRun=1` per page load (it walks every user time-entry blob in the request path — #316 enrichment req 1); the tile shows `lastAlertedAt` as its asOf instead. No `contractValue` on any active job → "No contract values set…", never "$0 at risk". | `/v2/jobs` (or the job hub when exactly one job is alerted) |

## Boundary with /command-centre (#185 vs #316)

- **`/command-centre` = what needs me NOW** — Today strip + needs-you
  queues. THE admin landing.
- **`/reports` = how the business is TRENDING** — values + direction +
  drill-downs.

Link, never duplicate: no queue cards on /reports, no analytics tiles on
/command-centre. Where a number appears on both (approvals waiting, crew
on the clock) it comes from the **same endpoint with zero client-side
re-math** — one source per number is #329's law; pre-engine, that's how
the two surfaces are kept from disagreeing.

## Failure + honesty behaviour

- Six sources are fetched server-side in parallel (the command-centre
  `loadSnapshot` pattern); a failed source renders that tile's explicit
  error state and the other five still paint.
- Tile states map to the doc 27 §6.1 tone palette: ok → neutral,
  warning → `--state-warning` rail, error → `--state-danger` rail,
  missing → neutral + honest explainer. Missing/unset data is explained,
  never rendered as a zero presented as fact.
- Tests: `src/domains/analytics/owner-numbers.test.ts` (one suite per
  definition, incl. the no-contract-values and pct:null honesty cases) +
  `src/components/admin/OwnerNumbersBoard.render.test.tsx` (six painted;
  one failed source → five tiles + one error tile).
