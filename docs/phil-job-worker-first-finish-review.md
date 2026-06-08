# Phil job screen — worker-first finish review (#102–#105)

> **Status:** review/record only. No behaviour, API, data, anchors, capture,
> task, hours, checks or issues change in this doc's PR — it closes the
> worker-first job-screen correction chain and hands off to a **human mobile
> preview**. Re-verify against `git log` + the tests before relying on a line
> here; `main` moves fast.

## Why this exists

The Phil job screen (`/phil/jobs/[jobId]` → `src/components/phil/PhilJobDetail.tsx`)
was corrected over a short chain of PRs to stop feeling like an **instruction
manual / digital foreman / admin dashboard** and start feeling like a **fast
site companion**. This records the finished state, the deliberate deferrals, and
the checklist a human should run on a real phone before any further
job-screen code.

## Product principle (the bar every section is held to)

Phil is **not** an instruction manual, compliance portal, digital foreman, admin
dashboard, fake productivity tracker, or checklist manager. It should help
workers on site move faster while letting them work naturally:

- quick job identity · worker-controlled shortcuts · current plans/specs ·
  fast proof capture · simple issue reporting · useful job memory · low typing ·
  honest state · worker autonomy · one-tap access to what matters.

**Rule:** show something prominently only if it helps the worker *now*;
everything else stays available but **quiet**.

## The correction arc

| PR | Squash | Change | Boundary held |
| --- | --- | --- | --- |
| #100 | `b9040d6` | Panels read **"Checks" / "Issues"** | copy only; **"Report snag"** kept (AU site term) |
| #101 | `362240e` | Command anchors repaired; `JobFieldViewCard` made honest | no fake worker telemetry |
| #102 | `1bd7914` | **Capture-shutter v1** — photo-first; note optional; stage/area/task collapsed behind one optional row | same `/api/photos` + `/api/evidence`; no data/honest-state change; "Capture evidence" preserved |
| #103 | `1da6219` | Top surface **"Next on this job" → "Quick actions"** | command model/ranking/action-IDs/anchors unchanged; `id="phil-job-next-h"` preserved |
| #104 | `abd21b0` | **Site details collapsed by default** | `#phil-job-site` preserved; one tap to open; `hasSiteContext` hide-when-empty kept |
| #105 | `e07ec1d` | **Empty Documents & specs hidden** | real docs, superseded-safety warning, and fetch errors still render; `view_plans` → `#phil-job-plans` |

## Final job-screen anatomy (top → bottom)

| # | Section | Renders when | Default | Empty behaviour | Worker value |
| --- | --- | --- | --- | --- | --- |
| 1 | Back link → All jobs | always | — | — | nav |
| 2 | `PhilJobHero` — name / status / address | always | — | — | "where am I" |
| 3 | **Quick actions** (`PhilJobCommandPanel`) | when it has content | — | null when nothing | "fast shortcuts" (model-ranked, presented as shortcuts) |
| 4 | Attention strip (`PhilJobAttentionStrip`) | only real signals | — | **null when empty** | "what's genuinely wrong" (rejected/assigned snags, pending ITPs, induction) |
| 5 | Work to do (`#phil-job-work`) | areas exist | open | "no areas" note | core work, area drill-in + task toggle |
| 6 | Capture evidence (`#phil-job-capture`) + Today's captures | always | — | strip shows "No evidence captured…" (**see deferred #1**) | core proof capture |
| 7 | Issues (`#phil-job-snags`) | viewer present | — | "No open issues" | report/track problems |
| 8 | Checks (`#phil-job-itps`) | always | — | panel empty copy | inspection checks |
| 9 | Plans (`#phil-job-plans`) | `moduleEnabled(plans)` | — | — | current drawings (high-value reference) |
| 10 | Documents & specs (`#phil-job-documents`) | **only when docs exist or fetch error** (#105) | — | **hidden** when truly empty | reference; superseded-safety + errors kept |
| 11 | Site details (`#phil-job-site`, `PhilJobSiteCard`) | `hasSiteContext` | **collapsed** (#104) | null when no context | on-arrival reference, one tap |
| 12 | Not connected yet (`#phil-job-more`, `PhilJobDeferredNote`) | always | — | one compact honest line | "Materials → call PM; history in office" |

## Worker-first verdict: **acceptable → strong**

- **Job identity** — instant (hero). ✅
- **Shortcuts, not orders** — "Quick actions" reframes the top from an assignment to the worker's tools. ✅
- **Capture** — photo-first, note/context optional, honest states. ✅
- **Issues** — "Report snag" one tap. ✅
- **Reference is quiet** — Documents hidden when empty (#105), Site collapsed (#104), deferred note is one line. ✅
- **Honest** — no fake saved/uploaded/complete/telemetry state anywhere. ✅

Remaining frictions are **product/visual judgment**, best resolved with eyes on a real phone — see *Deferred* and the *Human-preview checklist*.

## Field-flow support (after #102–#105)

| Flow | Supported now | Still wants human eyes |
| --- | --- | --- |
| A — Arrive on site | hero + Plans + Quick actions + attention; Site one tap | is collapsed Site right on first arrival? |
| B — Already knows the job | Quick actions → plans/capture/issue/hours; no nagging | does "Continue work — N left" still feel directive? |
| C — Needs proof | photo-first sheet, optional note/context, honest save | empty "Today's captures" prompt vs noise (#1) |
| D — Finds a problem | "Report snag" + photo + note | — |
| E — Unsure | Plans / Documents (when present) / Site / Checks | is reference discoverable enough when quiet? |
| F — Apprentice/new | Work-to-do area/stage memory + plans | — |
| G — Boss/admin visibility | evidence + issues + checks feed the office surfaces | unchanged by this chain |

## Deferred — deliberately NOT changed (need human preview / judgment)

1. **Today's captures empty state** ("No evidence captured for this job yet").
   `TodaysCapturesStrip` always renders. Hiding it when empty is a genuine
   judgment call: an empty strip may **prompt** a worker to capture (capture is
   core), not just create guilt. Two real constraints make this delicate:
   the success/failure **banner renders inside that card**, so any hide-when-empty
   must still surface a failed-capture banner; and a (skipped) e2e
   (`tests/phase-d-d3-capture.spec.ts`) asserts the empty copy. → human preview +
   careful test update, not a blind change.
2. **Count-chip language** ("1 ITP" / "2 snags"). Headings already read
   "Checks/Issues" (#100). The chips live across ~5 tested files
   (`philJobWorkTree`, `philJobsListSignals`, `PhilJobsList`, `PhilJobAreaDetail`,
   `PhilJobAttention`); a rename is a deliberate, heavier pass — defer.
3. **Quick-actions ↔ attention duality** and the **"Continue work — N tasks left"**
   count label. The model still ranks a primary internally; whether that count
   reads as helpful or foreman-ish is a live-screen judgment.

## Honesty — clean

No fake state introduced anywhere in the chain. Capture shows "saved" only after
a confirmed server write; tasks come from real task state; checks from real ITP
data; issues from real snags; Documents shows current vs superseded honestly and
keeps fetch errors; Site's collapsed state does **not** hide induction (it's
surfaced in the attention strip); `JobFieldViewCard` (BuhlOS "what the field
sees") remains honest and carries no live worker telemetry.

## Test coverage added by the chain

`CaptureSheet.render.test.tsx` (#102), `PhilJobCommandPanel` + `JobFieldViewCard`
assertions updated to "Quick actions" (#103), `PhilJobSiteCard.render.test.tsx`
collapsed-by-default guard (#104), `JobDocumentsPanel.render.test.tsx`
hidden-when-empty / superseded / error guards (#105). Smoke (`phil.spec.ts`) and
route/shell guards unchanged and green throughout; "Capture evidence" +
"Take a photo" remain the smoke-locked capture names.

## Human-preview checklist (run on a real phone, mobile viewport)

- [ ] Above-the-fold job screen reads as **shortcuts, not instructions**
- [ ] **Quick actions** — labels are obvious; primary doesn't feel bossy
- [ ] **Capture evidence** — one tap; photo-first; note/context clearly optional
- [ ] **Plans** — reachable fast (high-value reference)
- [ ] **Work to do** — useful memory, not a forced checklist
- [ ] **Issues** — "Report snag" is fast and obvious
- [ ] **Checks** — understandable, not micromanaging
- [ ] **Documents & specs** — **absent** on an empty job; present + correct when docs exist; superseded-safety + fetch error still show
- [ ] **Site details** — **collapsed** by default; one tap opens; address still in hero; induction still in the attention strip
- [ ] **Today's captures** empty state — does "No evidence captured yet" *prompt* capture or just nag? (deferred #1)
- [ ] Attention strip — useful, not nagging; doesn't duplicate Quick actions
- [ ] Overall — would a busy electrician **voluntarily** use this daily, one-handed, with dirty hands and poor reception?

## Recommended next step

**Human mobile preview / light field user-testing before any further
job-screen code.** If that surfaces a concrete, low-risk fix, take it as its own
small PR (top candidate: the deferred *Today's captures* empty-state, handled
with the banner + skipped-test care noted above). Do not stack more blind
job-screen passes.

The runnable test plan — participants, a five-minute on-phone script, an
observation checklist, a scorecard, issue classes (A–E), and a post-test
decision tree — lives in **[phil-job-field-validation.md](./phil-job-field-validation.md)**.

> **Strong rule:** _no more Phil job-screen code until the worker preview produces
> a **Class-A blocker** (a core action — plans / capture / issues — broken, fake/
> misleading state, or data loss) or **repeated Class-B friction** (the same
> too-slow / too-bossy / too-many-taps complaint from ≥2 workers)._ Everything
> else waits for more evidence.
