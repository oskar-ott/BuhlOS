# Hours — safe foundation (supersedes PR #57)

_Branch `feat/phil-hours-safe-v1`. Built from current `main` (`e9622c7`), not
from PR #57's stale base._

## Why this exists

PR [#57](https://github.com/oskar-ott/BuhlOS/pull/57)
(`pr-hours/complete-hours-system`, "complete the Hours money-control workflow")
was reviewed twice and is **not safe to merge as-is**: it is 31 commits behind
`main`, `CONFLICTING`/`DIRTY`, and — because it predates the field-readiness
attribution work (#77/#80/#81) — its Phil-side changes would **regress** the
guarantee that a field worker with active assigned jobs can never log hours with
`jobId: null`.

Rather than rebase a stale, unsafe branch, this PR is a **selective rebuild**:
it re-applies only the genuinely-safe pieces of #57 on top of current `main`,
preserving every attribution guard already in `main`.

## What current `main` already has (so #57's Phil rewrite is redundant)

The Phil hours capture surface on `main` is already attribution-safe (#77):

- `src/components/phil/LogHoursSheet.tsx` — auto-selects the sole assigned job,
  requires an explicit pick when there are several, blocks submit with an honest
  message when jobs failed to load or none are assigned, and never builds an
  active-worker payload with `jobId: null` (`jobAttributionError()` + `jobReady`).
- `src/app/phil/my-day/page.tsx` — `loadAssignedJobs()` returns `error: true` on
  any failure so the sheet blocks rather than degrading to an unattributed entry.
- The invariant is codified for normal CI in
  `src/domains/qa/time-entry-attribution.ts` (#81) and exercised by the
  field-readiness smoke (`tests/playwright/smoke/field-readiness.spec.ts`,
  "logging a Standard Day attaches the assigned job (never jobId:null)").

**None of these files are touched by this PR.** The Phil write-path is unchanged.

## What this PR re-applies (all safe, all on real endpoints)

Every endpoint below already exists and is merged on `main`; this PR adds **no**
`api/*.js` and changes **no** write-path. The new UI is read-only / dry-run.

### Shared timesheets domain (Phil + admin both build on this)
- `src/domains/timesheets/schema.ts` — Zod for the existing read endpoints:
  `time-entries-overview` (rollup + missing), `time-entries-export` dry-run
  preview, `today-pulse`.
- `src/domains/timesheets/types.ts` — inferred types for the above.
- `src/domains/timesheets/client.ts` — `overview()` and `todayPulse()`
  (GET-only typed wrappers).
- `src/domains/timesheets/service.ts` — pure helpers `weekEndOf`, `addDays`,
  `summariseMissing` (the last only **reshapes** the server's `missing` list; it
  re-derives no detection logic).
- `src/domains/timesheets/timesheets.test.ts` — unit tests for those helpers.

### Admin `/hours` overview (`src/app/(admin)/hours/page.tsx`)
Replaces the two "under construction" panels with real, read-only data:
- **Today's closeout** — `GET /api/today-pulse` (is today's labour accounted for?).
- **This week's rollup** — `GET /api/time-entries-overview` (totals by
  job/worker/status + the server's **missing-hours** list), week-navigable.
- **Payroll export _preview_ (admin only)** — `GET /api/time-entries-export?dryRun=1`
  shows row/hour/worker/job counts. Labelled "Dry run · not pushed to Xero".

### Command-centre missing-hours card (`src/app/(admin)/command-centre/page.tsx`)
A single additional attention card ("Missing hours"), added **surgically** on top
of current `main` — the `ExceptionsInbox` section (PR #69) and all existing queues
are preserved. (#57's whole-file version deletes `ExceptionsInbox` because it
predates #69; that deletion is **not** carried.)

## What was deliberately NOT carried forward

| Dropped | Reason |
| --- | --- |
| #57's `LogHoursSheet.tsx` / `my-day/page.tsx` rewrites | `main` is already attribution-safe (#77); #57 is the older `jobId:null`-permitting version |
| `pickDefaultJobId()` | Auto-picks among **multiple** jobs → relaxes `main`'s stricter "require an explicit pick" rule |
| In-place rejected→resubmit | Genuine gap, but it is a **write-path UI** on attribution-sensitive files — deferred to its own focused PR (see below) |
| Real (stamping) "Download payroll CSV" | The non-dry-run export **mutates** payroll state (stamps `exportedAt`/`exportId`, writes `payroll-runs.json`, locks entries). The committed run stays on legacy `/admin/hours`; we never trigger a payroll mutation from this surface |
| `playwright.config.ts` changes | #57 removes the `desktop-chrome`/`mobile-phil` smoke-discovery split + `phil.spec` match (#80/#84) |
| `scripts/seed-qa-accounts.js`, `tests/helpers/auth.ts`, `tests/phase-b-hours.spec.ts` | Authed-E2E / Preview-Smoke infra — out of scope, risk to the smoke gates |
| 428-line completion report | Claimed features (resubmit, committed payroll) this PR does not ship |

## Safety boundaries

- **No `jobId: null` field regression** — Phil capture untouched; attribution
  validator + smoke unchanged and green.
- **`/api/time-entries` write behaviour unchanged** — no `api/*.js` modified.
- **No admin payroll controls in Phil**, **no real Xero/payroll push**,
  **no committed payroll mutation** from the new surface (dry-run preview only).
- **#86 Capture behaviour unchanged.**
- **No production/preview data mutated**; **Preview Smoke not dispatched.**

## Validation (all green, local)

`typecheck` · `lint` · `test:unit` (1333) · `test:api` (185) ·
`check:smoke-list` (11 tests, split preserved) · `build` ·
`check:admin-shell` · `check:production-shell` · `check:route-ownership` ·
`check:shell-contract` · `check:sw-cache-version` · `smoke:admin-routes`.

## Recommended next task

`feat/phil-hours-rejected-resubmit` — in-place edit + resubmit of a rejected
entry in Phil, built on `main`'s attribution guards (preserve the original job
id or require a real assigned job; reuse `timesheetsClient.editOwnEntry`). This
is the one genuinely-missing Phil feature from #57, kept separate because it
touches the attribution-sensitive write-path UI.
