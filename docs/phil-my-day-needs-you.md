# Phil · My Day — "Needs you" feed

`/phil/my-day` shows a **"Needs you"** feed below the hours area: the logged-in
field worker's real, actionable attention items, aggregated across their
assigned jobs. It is backed **only by existing data sources** — there are no
mock rows, no fake counts, and no dead links. When nothing is real, it shows an
honest empty state ("Nothing needs you right now / You're clear for today").

Pure selector: `src/domains/phil/needs-you.ts` (`buildPhilNeedsYou`). Renderer:
`src/components/phil/PhilNeedsYouFeed.tsx`.

## Item types shipped (real + worker-attributable)

| Kind | Source | Worker attribution | Action route |
|---|---|---|---|
| **rejected-hours** | `GET /api/time-entries` (already loaded by the page) — entries with `status: "rejected"` + `rejectedReason` | self-scoped: the endpoint returns the caller's own entries | `/phil/hours` (`RejectedHoursResubmitSheet`) |
| **snag** | snagsV2 `GET /api/snags?jobId=` per assigned job (`src/domains/snags/*`) — `SnagItem` with `assignedToId`, `status`, `priority`, `title`, `areaName` | `assignedToId === session.userId` **and** `status ∈ {open, in_progress}` | `/phil/jobs/[jobId]#phil-job-snags` |

Snags are job-scoped (no cross-job snagsV2 endpoint exists), so the page fetches
`/api/snags?jobId=` for each assigned job in a **bounded, parallel, fail-soft**
fan-out (`loadAssignedSnags`): a job whose snags can't be read is skipped, never
an error that blanks the page. The "assigned to me, still open" filter mirrors
the per-job logic in `PhilJobAttention.ts`, generalised across the worker's jobs.

The feed **replaces** the previous standalone top rejected-hours banner —
rejected hours now live in the feed (severity `urgent`, sorted first), so there
is no duplication.

## Item types deliberately NOT implemented (no honest source today)

| Kind | Why omitted |
|---|---|
| **Assigned tasks** | Tasks are **job-level**, not per-worker. The model (`api/_lib/job-tasks.js`, `taskState.ts`) is `{ id, name }` + a shared `not_started/in_progress/complete` state — **no `assignedTo`, no due date, no blocked state**. Cannot say a task is due/overdue/blocked for *this* worker. |
| **Required evidence** | Evidence (`src/domains/evidence/*`) is opportunistic capture — there is **no required-vs-supplied completion model**. "Required-but-missing for this worker" is not derivable. |
| **ITP / sign-off** | ITP (`src/domains/itp/*`) is **job/area/level-scoped and role-gated**; an instance has no per-worker `assignedTo`. |
| **RFIs** | **No RFI entity exists** in the repo (only an `observations` intent tag). Nothing worker-attributable or actionable. |
| **"Submit timesheet"** (weekly) | **No weekly batch-submit workflow** — logging a day already creates it `submitted`. A weekly submit is a separate future feature (period summary + missing days + submit-week action + admin approval), out of scope here. |

If any of these gain a real, worker-attributable source later (e.g. a snag
assignee already exists, but tasks/ITP/evidence would need new fields), they can
be added to `buildPhilNeedsYou` the same honest way.

## Visual

Quiet, field-scannable, sitting below the standalone hours action — consistent
with the rest of My Day (navy header → week strip → yellow action → quiet
secondaries). Styling is scoped in `myDay.module.css` (`.needs*`): a mono
"Needs you" heading with a count (only when `> 0`), tappable rows with a
severity dot + title + detail + an action chip, ≥56px touch targets, and a
dashed honest empty state. No desktop-table density.

## Tests

- `src/domains/phil/needs-you.test.ts` — empty input → **no rows**;
  submitted/approved hours and not-mine / resolved / closed snags are excluded;
  a rejected entry → a `/phil/hours` item; only `assignedToId === me` +
  open/in-progress snags surface, routed to the job; no snags without a viewer;
  urgent-before-snag ordering; every item carries a real `/phil/...` href.
- `src/components/phil/PhilNeedsYouFeed.render.test.tsx` — honest empty state
  (no fabricated rows) and real rows linking to real routes with a count.

## Out of scope (this PR)

Weekly "Submit timesheet" workflow · Xero export · admin approval workflow ·
fake "Needs you" rows · auth/routing changes · production deploy.
