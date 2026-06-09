# Phil · My Day — "Right Now" layout

`/phil/my-day` is laid out as the approved **A · Right Now** design direction
(one of four mocked in the Phil design handoff; the user picked A, optionally
blended with D's count badges where the counts are real).

## Why

The previous My Day was hours-first: a flat stack that led with the hours
sheet. Right Now leads with **what matters now** — the worker's job — then the
action, so a worker lands and immediately sees where they are before logging a
day.

## Layout (top → bottom)

1. **Identity** — `Hey, {firstName}.` + today's date. The name comes from the
   session cookie (`session.name`); no extra fetch. Falls back to "Right now"
   when the session carries no name. Date is formatted in `BUSINESS_TIMEZONE`.
2. **Rejected-hours banner** — unchanged; the most recent rejected entry with a
   "Fix & resubmit" link (one banner max).
3. **What matters now**
   - **1 assigned job** → `PhilRightNowCard`: a navy accent hero (navy is used
     only here, never as a page background) with the job name, real address,
     real status chip, real open-work chips, and an "Open job" link to
     `/phil/jobs/[id]`.
   - **2+ jobs** → a "Your jobs" section rendering the existing `PhilJobsList`.
     We never crown one job "you're on" with 2+ jobs — there is **no
     active-job signal** in the data, so faking a current job is off the table.
   - **0 jobs** → nothing here; the hours sheet shows its own honest
     "No active assigned job" block.
4. **The action** — the unchanged `LogHoursSheet`. When there's exactly one
   assigned job it's preselected via `initialJobId`. The sheet still receives a
   minimal `{id,name}` list, so its client payload and the hours
   write/attribution path are byte-for-byte unchanged.
5. **This week** — unchanged recent-entries table + "See history".
6. **Secondary** — "My gear" link.
7. **Under construction** — the unchanged multi-job allocation note.

## Data honesty

| Element | Source | When unavailable |
|---|---|---|
| Worker name | `session.name` (cookie) | "Right now" (no name) |
| Today's date | `BUSINESS_TIMEZONE` | always available |
| Current job | assigned jobs (1 → hero) | 2+ → real list; 0 → none |
| Address / status | real `Job.siteAddress` / `Job.status` | address line omitted; status defaults to Active (as the jobs list does) |
| Open-work counts | `jobOpenWork()` from `?withStats=1` (open snags · active ITPs) | **chips omitted** — never a fabricated count or "all clear" |
| Clock-on state | — (does not exist) | not faked; real day-hours via the sheet |
| Capture | shell `PhilTabBar` centre FAB | unchanged |

`?withStats=1` is the same proven-soft enrichment the Phil jobs list already
uses; a bad stats read returns the core job with zeroed stats, so the chips
just don't render and nothing else regresses.

## Not in scope (deliberately omitted from the prototype)

- A standalone **Plans** tile, a **crew-review** tile, **materials**, or any
  unwired action tile — no route/data, so not shipped (would be fake state).
- A bespoke **clock-on** timer — there is no such concept; the real daily
  action is logging hours.
- Restyling the Phil **shell header** to warm paper (chat14) — that's a
  shell-wide change affecting every Phil screen and the smoke; out of scope.
  Navy stays the app-bar; the warm-paper/navy-accent language is applied in the
  page body. Typography uses the existing `font-display` tokens — Inter Tight /
  JetBrains Mono are **not** imported (no new font loading).

## Tests

- `src/components/phil/PhilRightNowCard.render.test.tsx` — the lead card:
  links to the real job, real status/address, real counts, **no fabricated
  counts when stats are absent**, no "Draft" leak.
- The hours flow + shell + Capture FAB stay covered by the existing Preview
  Smoke (`tests/playwright/smoke/phil.spec.ts`, `field-readiness.spec.ts`),
  whose selectors (`phil-shell`, "Submit Standard day", the job radiogroup,
  the Capture FAB) are untouched.
