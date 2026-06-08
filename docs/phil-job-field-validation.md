# Phil job screen — field-validation plan

> **Purpose.** The worker-first job-screen code pass (#102–#105) is **done enough**.
> The next step is **real worker preview**, not more cleanup from code theory. This
> is the plan to run with a real electrician/apprentice on a phone, and the rule
> for when (and only when) to write more code. Companion to
> [phil-job-worker-first-finish-review.md](./phil-job-worker-first-finish-review.md).
>
> **Strong rule:** _no more Phil job-screen code until worker preview produces a
> **Class-A blocker** or **repeated Class-B friction** (below)._

## What the worker sees (orient the tester, don't over-explain)

Top → bottom on `/phil/jobs/[id]`: **job name + Active pill + address** → **Quick
actions** (big "Continue work — N tasks left", then *Take a photo or add a note*,
*Log hours*, *Report an issue*, + muted "not in app" notes) → **Needs attention**
(only when real, e.g. induction) → **Work to do** (area → stage → tasks + *Mark
done*) → **Capture evidence** (yellow CTA → camera-first sheet) → **Today's
captures** ("No evidence captured for this job yet" when empty) → **Issues**
(*Report snag*) → **Checks** (ITPs) → **Plans** (*Open plan viewer*) → **Documents
& specs** (only when docs exist) → **Site details** (collapsed; one tap) →
**"Not connected in Phil yet"** (one line).

## A. Participants (first round: profiles A + B are essential)

| Profile | Tests | Watch for | Feedback that matters most |
| --- | --- | --- | --- |
| **A. Experienced tradesman** | does it get in the way | irritation, "I don't need this", skipped sections | does it feel bossy / admin |
| **B. Apprentice** | does it help understand the job | finds Work/Plans, follows area→stage→task | is it useful job memory |
| **C. Boss / project lead** | admin value without worker pain | evidence/issues/checks reach the office | enough visibility, no worker burden |
| **D. You (self, electrician hat)** | fast first pass before showing anyone | your own friction | the single biggest annoyance |

## B. Five-minute worker script

Hand them the phone on the job: _"this is the job screen — show me how you'd use
it."_ **Don't explain. Don't lead. Time each task. Note every tap.**

| # | Ask them to… | Expected | Success | Friction sign |
| --- | --- | --- | --- | --- |
| 1 | Open the job | lands on screen | orients <2s | confusion at top |
| 2 | Tell me the job + where it is | reads hero | instant | scrolls to find |
| 3 | Find the current plans | taps *Open plan viewer* | <10s | hunts; opens Documents instead |
| 4 | Start a proof photo | taps yellow *Capture evidence* → camera | ≤2 taps | misses the CTA |
| 5 | Add a note to the job | uses the optional capture note | finds it | types a lot / unsure where |
| 6 | Report a problem | taps *Report snag* | ≤2 taps | looks elsewhere |
| 7 | Find what work is left | opens an area, sees tasks | <15s | overwhelmed / bored |
| 8 | Find checks/ITPs | scrolls to Checks | finds it | confused by "ITP" |
| 9 | Find site details | taps to expand Site | <10s | misses it (collapsed) |
| 10 | What would you use / ignore? | — | names 2–3 each | — |
| 11 | What feels like admin? | — | — | — |
| 12 | What would make you stop using it? | — | — | — |

## C. Observation checklist (tick what you see)

☐ hesitation ☐ wrong taps ☐ over-scrolling ☐ confused by "Quick actions"
☐ confused Plans vs Documents ☐ capture friction ☐ issue-report friction
☐ Work-to-do feels bossy ☐ Checks feels compliance-heavy ☐ empty Today's-captures
reads as guilt ☐ attention strip useful / nagging ☐ hunts for Site details
☐ misses Plans ☐ wants search ☐ "I wouldn't use this" ☐ "that's handy"
☐ types too much ☐ asks what a word means ☐ office-language reaction
☐ anything reads as fake.

## D. Scorecard (1–5 · 1 = unusable/annoying, 3 = acceptable, 5 = clearly valuable)

speed · clarity · worker control · low-admin-feel · plans access · capture ease ·
issue ease · work/task usefulness · checks usefulness · reference usefulness ·
low visual clutter · trust/honesty · **likelihood of daily use**.

## E. Pass / fail rules

- **Pass:** `daily-use ≥4` **and** `worker-control ≥4` **and** `low-admin-feel ≥4`,
  and **no category = 1** → ship to a wider test group.
- **Fail:** `daily-use ≤2`, **or** any core action (plans / capture / issues) = 1.
- **Category = 3** → design review (not necessarily code).
- **≤2 on a worker-friction category** → code work (per the decision tree).

## F. Issue classification

| Class | Examples | What to do |
| --- | --- | --- |
| **A — Critical blocker** | can't open plans/capture/report; fake/misleading state; data loss | **code immediately** |
| **B — High-friction** | too slow / too bossy / too many taps / too much typing | code **if repeated** (≥2 workers); else gather more |
| **C — Medium UX** | unclear wording; a section too loud; extra scroll | batch one small PR after evidence |
| **D — Low polish** | style / copy preference | backlog |
| **E — Product disagreement** | one likes structure, one hates it | **more users, no code yet** |

## G. Post-test decision tree (next PR — _only if the test proves it_)

| Test outcome | Next PR | Scope / non-scope | Risk |
| --- | --- | --- | --- |
| Likes it / minor notes | none (wider test) | — | none |
| Capture still friction | `fix/phil-capture-polish` | the exact step they stalled on; **no API/data** | low |
| Plans not fast enough | `fix/phil-plans-shortcut` | lift Plans nearer top / into Quick actions; no route change | med |
| Work-to-do feels bossy | `fix/phil-work-reframe` | copy/emphasis; **no task-toggle change** | low |
| Checks compliance-heavy | `fix/phil-checks-language` | "ITP" wording; **no checks-data change** | low |
| Today's-captures nags | `fix/phil-job-quiet-empty-captures` | hide when empty **and no banner**; keep Capture CTA; update the skipped e2e | low-med |
| Too much scroll / clutter | `fix/phil-reference-grouping` | collapse/group reference; **no access removed** | med |
| Feels fake / admin | `fix/phil-honesty-repair` | remove the offending string/state | low |

## H. Boundaries (unchanged by any of the above)

No API/data-shape change · no `/api/photos` or `/api/evidence` change · no
task-toggle / hours / checks / issues **behaviour** change · no command action-IDs
or anchors (`view_plans` stays `#phil-job-plans`) · no telemetry / offline /
admin / payroll / Xero · no fake state · don't remove access to plans/docs/site ·
don't hide fetch errors or superseded-doc safety warnings · one PR at a time.

## I. The rule, restated

**Run the script with profiles A and B first. Fill the scorecard + observation
checklist. Classify every issue A–E. Write code only for a Class-A blocker or a
repeated Class-B friction — everything else waits for more evidence.**

> Preview Smoke was **not** dispatched and production/preview data was **not**
> touched in preparing this plan.
