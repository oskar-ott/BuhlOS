# Job health thresholds (#226)

> Status: **engine, real.** Pure derivation in
> [`src/domains/jobs/job-health.ts`](../src/domains/jobs/job-health.ts)
> (`deriveJobHealth`), rendered by the jobs list cards (#227 / Job Detail
> Variants) and the hub's health band. Sibling of
> [`attention.ts`](../src/domains/jobs/attention.ts): attention LISTS the
> backlog, health CLASSIFIES it.

## Inputs (real signals only)

Every input is a real, blob-derived `stats*` field already on the loaded `Job`
(no new fetch, no fabrication). A missing/zero/negative stat contributes nothing;
when **no** signal is loaded the level is `unknown`, never a fake `good` (P7).

| Reason | Stat | Severity | Destination |
|---|---|---|---|
| Expired gear tags | `statsExpiredTags` | **hard** | `/gear` (cross-job — no per-job tab) |
| Evidence to review | `statsEvidenceV2Pending` | soft | `/v2/jobs/<id>/evidence` |
| Open snags | `statsSnagsV2Active` | soft | `/v2/jobs/<id>/snags` |
| ITPs to sign off | `statsItpsNeedsReview` | soft | `/v2/jobs/<id>/itps` |

## Levels

- **`unknown`** — no signal loaded (stats absent).
- **`good`** — every loaded signal is zero.
- **`watch`** — some soft backlog, below the at-risk threshold, and no hard breach.
- **`at-risk`** — any **hard** signal > 0 (out-of-test gear is a live compliance
  breach), **or** the soft backlog total reaches `AT_RISK_SOFT_TOTAL`.

## The one threshold

`AT_RISK_SOFT_TOTAL = 10` (exported from `job-health.ts`). A large actionable
backlog (evidence + snags + ITPs combined) tips a job from `watch` to `at-risk`
even with no hard breach. Conservative and named so it tunes in one place — not a
magic number in a branch. A hard signal trips `at-risk` on its own regardless of
this value.

## How the jobs list words it (2026-09-27, owner pull: an accurate phone overview)

The level drives the filter pills, the "needs me first" sort and the
"N need attention" count — unchanged. What the **card line** says is decided
separately by `jobCardVerdict` in
[`src/domains/jobs/portfolio.ts`](../src/domains/jobs/portfolio.ts), so the
list can never contradict the status pill beside it:

| Job | Card line |
|---|---|
| any phase with a real backlog | `Watch · 3 evidence to review` (the health word + the top reason) |
| active, all clear | `On track · nothing needs you` |
| active, no stat loaded | `No data · health starts when hours or photos come in` |
| on hold, nothing outstanding | `Paused — nothing to review` |
| finished, inside the callback window | `Finished 21 Sep · crew can log until 21 Oct` |
| closed | `Closed 13 Aug · still takes callback hours` |
| draft | `Not published yet — the crew can't see it` |
| archived | `Archived — office history only` |

"On track · nothing needs you" on a draft or a paused job was theatre (P7), so
the health word appears only where health is the read. The phone facts line
under it (`jobCardFacts`) prints only real facts — contract value, crew,
task progress when the job has tasks, when it last moved — never a "—".
