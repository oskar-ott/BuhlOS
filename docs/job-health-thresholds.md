# Job health thresholds (#226)

> Status: **engine, real.** Pure derivation in
> [`src/domains/jobs/job-health.ts`](../src/domains/jobs/job-health.ts)
> (`deriveJobHealth`). No UI yet — the jobs list / hub badge is a follow-up that
> renders this. Sibling of [`attention.ts`](../src/domains/jobs/attention.ts):
> attention LISTS the backlog, health CLASSIFIES it.

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
