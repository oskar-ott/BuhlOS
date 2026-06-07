# Phil Job Command Model

> A durable decision layer for the field worker. One question, answered from
> data: **"What does this field worker need to know or do on this job, right
> now?"** The UI is generated from the model — not from hardcoded assumptions
> about whichever features happen to exist this week.

## Why this exists (the correction)

Phil had started to accrete feature-specific UI blocks — an action hub, a
rejected-hours card, a closeout widget, an evidence chip, a task panel. Each one
hardcodes "today's features" into the field surface, and each one goes stale the
moment the job model changes. The field UI then has to be re-stitched.

This module replaces that pattern with a single **decision layer**: a pure
function from a well-defined input contract to a ranked, honest command model.
Adding or changing a capability becomes a matter of populating an input field —
the decision layer, its ranking, and the UI generated from it stay put.

BuhlOS = admin/desktop job control. Phil = mobile field execution. Phil should
feel like a **site tool**, not a dashboard; the worker should never have to
understand "modules" — only **job context, attention, and next actions**.

## Architecture

Two files, one clean seam:

| File | Role | Couples to |
| --- | --- | --- |
| `src/domains/phil/job-command-model.ts` | **Decision layer** — types, `buildPhilJobCommandModel`, `rankPhilJobActions`. Pure: no fetch, no React, **no schema imports**. | nothing |
| `src/domains/phil/job-command-input.ts` | **Bridge** — maps the Phil job page's real fetched data into a `PhilJobCommandInput`, marking the non-derivable honestly. | jobs / snags / ITP / documents schemas |

The seam is the point: when the job/snag/ITP/document shapes change, or a new
real signal arrives, **only the bridge moves.** The decision layer doesn't.

```
real page data ──▶ philJobCommandInputFromJobData ──▶ PhilJobCommandInput ──▶ buildPhilJobCommandModel ──▶ PhilJobCommandModel ──▶ (UI)
 (job + lists)            [bridge / schema-coupled]        [contract]              [pure decision layer]            [render]
```

## Input matrix — what's real on `main` vs. honestly deferred

The model derives **only** from real, available data. Anything not derivable
becomes a `limitation`, never a faked action or count.

| Input | Source on `main` | Real / stub | Worker relevance | In model as | Risk |
| --- | --- | --- | --- | --- | --- |
| Job identity (id, name, status) | `GET /api/jobs?id=` → `JobSchema` | **Real** | High | `jobId` / `jobName`, always preserved | Low |
| Released to field (draft/archived) | `isVisibleToField(job)` (builder.ts) | **Real** | High | `state: "office_only"` | Low |
| On hold | `job.status === "on_hold"` | **Real** | High (blocker) | `state: "blocked"`, blocked attention | Low |
| Induction required | `job.inductionRequired` | **Real** (flag only — per-worker completion not knowable) | Med | warning attention (flag, never "you haven't done it") | Low |
| Capture / evidence | `moduleEnabled(job,"photos")` + `/api/evidence` | **Real** | High | `capture` action (ready) | Low |
| Plans / documents | `moduleEnabled(job,"plans")` + `/api/plans` (`status === "current"`) | **Real** | Med | `view_plans` when count > 0 | Low |
| Open snags | `moduleEnabled(job,"snags")` + `/api/snags` (`open`/`in_progress`/`resolved`) | **Real** | High | `report_issue` + `open-snags` attention | Low |
| ITP checks | `moduleEnabled(job,"itps")` + `/api/job-itps` (`pending`/`in-progress`) | **Real** (module defaults **off**) | High when on | `complete_checks` when count > 0 | Low |
| Worker-visible tasks | `buildPhilPreview(job)` structure | **Real (list)** | High | `tasks: list_only` → "View your tasks" | Low |
| Task **completion** | `/api/task-toggle` dormant on `main`; **PR #94 open** | **Stub** | High | **not faked** — honest `tasks-read-only` limitation | Avoided |
| Rejected hours (per job) | global only, via `TimeEntry.allocations[].jobId` on `/phil/hours`; **not fetched on the job page** | **Stub on job screen** | High | `rejectedHours: unknown` → limitation + **upgrade hook** | Low |
| Hours logging | `/phil/my-day` `LogHoursSheet` (global, not job-scoped) | **Real, off-surface** | High | `log_hours` → `elsewhere` (Day tab) | Low |
| Materials | `material-requests` domain exists; **no in-app request flow** | **Stub (UC)** | Med | limitation only ("call your PM") | Low |
| Gear | `/api/assets` (global inventory, not per-job) | Real, **global** | Low for a job model | **not modelled** (lives on its own tab) | — |
| Errors / not assigned | page load result (403/404/5xx) | **Real** | High | `state: "error"`, job context preserved | Low |
| Loading | page fetch in flight | **Real** | — | handled **upstream** by the page skeleton, before the model is built | — |
| Evidence pending review | `/api/evidence` (`submitted`) | Real but **office** concern | n/a for worker | **not modelled** (office side: `deriveJobAttention`) | — |

## The model

```ts
type PhilJobState = "ready" | "blocked" | "office_only" | "empty" | "error";

interface PhilJobCommandModel {
  jobId: string;
  jobName: string;
  state: PhilJobState;
  primaryAction: PhilJobCommandAction | null; // the one thing to lead with
  actions: PhilJobCommandAction[];            // ranked secondary; excludes primary
  attention: PhilJobAttentionItem[];          // ranked blocked → warning → info
  limitations: PhilJobLimitation[];           // honest "can't show / not yet"
}
```

Actions use the brief's bounded verb set (`fix_rejected_hours`,
`complete_checks`, `continue_tasks`, `capture`, `log_hours`, `view_plans`,
`report_issue`) and a status of `ready | attention | disabled | not_configured`.

### Ranking policy (one place to tune)

`PHIL_JOB_ACTION_PRIORITY` is the whole policy:

1. _Blockers / cannot work_ → handled as `state: "blocked"` (not an action)
2. `fix_rejected_hours`
3. `complete_checks` (ITPs)
4. `continue_tasks`
5. `capture`
6. `log_hours`
7. `view_plans`
8. `report_issue`

`rankPhilJobActions` sorts by status (attention → ready → disabled →
not_configured), then by this priority. Each action id is unique, so the order
is a total order — deterministic regardless of engine sort stability, and pure
(no clock, no randomness).

### State, honestly

- `error` — job didn't load / not assigned. Job id preserved; one blocked notice.
- `office_only` — draft/archived; nothing for the field.
- `blocked` — a hard blocker (on hold). `primaryAction` is `null`; the model does
  not lead the worker into job work.
- `ready` — there is job-specific work **or** something needing attention.
- `empty` — released but no assigned work. "Ambient" capabilities (log hours,
  report an issue) may still appear; they don't, on their own, make a job ready.

## The durability thesis, made concrete

**Rejected hours** is the worked example. On `main` the job page doesn't fetch
time entries, so per-job rejected hours is genuinely unknowable there → the
bridge returns `{ kind: "unknown" }` → the model emits an honest limitation, not
a fake card.

When a caller _can_ compute it (filter the worker's rejected `TimeEntry`s by
`allocations[].jobId`, using the helpers in `src/domains/timesheets/resubmit.ts`
shipped in #93), it passes `rejectedHoursForJob` and the bridge returns
`{ kind: "count", value }`. The model then lights up `fix_rejected_hours` as the
top-priority action — **with zero change to the decision layer or the UI.** The
same pattern applies to task completion (`list_only` → `tracked`) when #94 lands.

## Intended UI integration (deferred — see "Scope")

A compact **"Next on this job"** block near the top of the Phil job page,
rendered entirely from the model:

- `primaryAction` as the single `PhilActionButton`;
- the top 2–4 `actions` as secondary buttons/rows;
- `attention` items as `PhilNotice`s (severity → tone: `blocked`/`warning` →
  `warning`, `info` → `info`);
- `limitations` as muted, honest one-liners.

No new workflow, no duplicated section, no giant hub — it only re-presents
existing capabilities as "what's next." A reference render path:

```tsx
const model = result.kind === "ok"
  ? buildPhilJobCommandModel(philJobCommandInputFromJobData({
      job: result.job,
      snags: initialSnags,
      itps: initialItps,
      documents: documentsResult.documents,
      loadErrors: { documents: documentsResult.error != null },
    }))
  : buildPhilJobCommandModel(philJobCommandLoadFailureInput({ kind: result.kind, jobId }));
```

## Scope of the shipping PR

**Model + bridge + tests + docs only.** The UI integration is intentionally
**not** included: PR #94 (worker-visible tasks) is open and owns
`src/components/phil/PhilJobDetail.tsx` and `src/app/phil/jobs/[jobId]/page.tsx`
— the exact files the integration would touch. Per the brief, when an open PR
owns the Phil job page, we ship the decision layer and defer the wiring, so #94
merges cleanly and the follow-up is the near-one-liner above.

## Deliberate deviations from the brief

- **No separate `sections` field.** The brief's suggested `sections` is folded
  into `actions[].status` + `limitations`. A standalone capability inventory
  would duplicate the same signals and re-introduce the panel-list pattern this
  layer exists to retire. Feature availability is therefore expressed as data
  (an action's presence/status, or an honest limitation), not as a fixed list.
- **`loading` is upstream.** The page already awaits the job fetch and renders a
  skeleton before building the model, so `loading` isn't a model state; the model
  handles the resolved outcomes (`ok` / `error` / `not_found`).
- **Gear is out of scope** for the _job_ model — it's global inventory with its
  own tab, not a per-job signal.

## Tests

- `job-command-model.test.ts` — 22 cases: every state; actions only from real
  data; no fake rejected hours / task completion / counts; unknown → limitation;
  priority + primary selection; stable ranking; no admin/payroll/Xero language.
- `job-command-input.test.ts` — 14 cases: module gating, honest counts (snags /
  ITPs / docs), empty-vs-failed loads, the rejected-hours upgrade hook, and
  bridge→model end to end.
