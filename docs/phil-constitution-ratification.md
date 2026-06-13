# Phil Constitution — Ratification Analysis

**2026-06-12 · pinned `origin/main @ bd1d3dd` · Status: analysis only — zero backlog/code actions taken.**
Inputs treated as hypotheses: `docs/phil-ux-master-audit.md` (the audit) and `docs/phil-ux-architecture-v2.md` (the charter). Both are mine; this document attempts to break them. Output: `docs/phil-constitution.md` (the proposed supreme law, ≤2 pages) + the classifications below.

**Evidence honesty:** the audit's *measurements* are source-verified facts. Every *behavioural* claim (how workers think) is domain-reasoned inference — zero direct observation of this crew exists yet. That asymmetry drives the classifications: facts ratify now; behaviour ratifies only through [#132](https://github.com/oskar-ott/BuhlOS/issues/132).

---

## 1 · The three-category sort of every major conclusion

### Category 1 — Observable fact (measured; ratify now)

| Fact | Source |
|---|---|
| 15 font sizes on My Day; 11 instances ≤10px; one 7px; `opacity-50` state cells; 1.23:1 card borders | `myDay.module.css`, tokens math |
| `Mark done` = 40px; Call/Text ≈ 40px; everything else ≥44px | class quotes |
| Job page = 14 top-level sections, ~3.5 screens, 40–50 interactive elements; regrew twice in one week after a deliberate simplification arc | render order in `PhilJobDetail.tsx`; git history |
| My Day = 7 stacked cards incl. a permanent backlog apology; hours-centric content | page source |
| Zero offline: push-only SW, no route/data cache, no write queue; capture has in-flight resilience only | `sw.js`, fetch paths |
| Workers hold username+PIN credentials; the login form is office-labelled; onboarding = 9 screens | invite flow, login source |
| Capture: same-tap camera, drafts survive close, partial-failure retry preserves bytes | `philCapture.ts` |
| The crew has no non-Phil fallback since the cutover | #376 |
| The backlog's epics are feature-modules; the job page's sections map ~1:1 onto them | issue taxonomy vs render order |

**Ruling: all retained.** Facts about *the artefact*. Nobody on any site type disputes a 7px font.

### Category 2 — Design decisions (proposed solutions; must compete)

My Day hero state machine · "Quick actions"→"Now" rename · one-scroll job page · no-tabs · collapse-by-default reference · 12px/4-size type scale · PIN keypad screen · 3-card tour · run lens *as a UI* · attention strip merged into command panel · jobs list today-first sort. **None of these are law.** Each survives only as the current best candidate under the Constitution's principles, replaceable by anything that meets the same principle with less friction.

### Category 3 — Philosophy (the layer this exercise exists to test)

What is the root of the app · what is an Area/Task/Stage/Run · what navigation represents · how interruption works · what the home screen *is* · whose voice the app speaks in. Judged below, one by one.

---

## 2 · Adversarial review of the charter's five architecture decisions

### A. "The Day is the root" — **PARTIALLY BROKEN. Reframe.**
*Disproof attempt that lands:* this crew does **commercial fit-out** — one job for weeks or months. For them "today's plan" and "my job" are the same object ~95% of mornings; a Day layer above the Job is ceremony. Day-as-root genuinely wins for multi-job service work — a different business than the one Phil serves today. A pub refurb (2 sparkies, 3 days): the Day adds nothing the job screen can't say. The foreman test also bites: a computed "plan" can contradict the foreman's words — and the foreman is right. An app that asserts a plan loses trust the first time it disagrees with the morning toolbox talk.
*What survives:* the **question**, not the screen. "Phil opens answering *what now?*" is constitutional; *which surface* answers it (a Day view, the job itself for single-job crews, or a card) is a design decision. The day exists as a **record** (hours receipt, where-I-got-to); the day-*plan* is a **view**. The foreman's allocation should be *carried* (one line from a human), never *computed with authority*.

### B. "Stage as ambient context, set by the office" — **HALF RIGHT, HALF WRONG. Repair.**
*Disproof that lands:* an office-maintained "current stage" field **will go stale** (mixed-stage mid-project is the norm: L1 fit-off while L3 rough-in; nobody updates per-area season fields at 6am). A wrong confident default is worse than one honest tap — trust again. Hospitals break the binary entirely (pre-pour / in-wall / above-ceiling / fit-off / test / commission, plus hold points); the rough-in/fit-off **pair** is a fit-out simplification, not a truth.
*What survives:* stage *is* lived as a season — but the app should get it from **memory and evidence, not administration**: remember the worker's last stage per area (this merges cleanly with [#425](https://github.com/oskar-ott/BuhlOS/issues/425) resume-by-place) and default from where recent completions cluster. No new office-maintained field. Long-term: the phase *set* is per-job-type configuration; "phases gated by other trades" is the stable concept, the pair is not.

### C. "The Run lens" — **REAL BUT NOT UNIVERSAL. Demote to field-gated hypothesis.**
*Disproof that lands:* foremen frequently **forbid** cross-area runs in finishing stages ("finish the room — I can't hand over 40 rooms at 95%"). Runs optimise the worker's setup cost; room-completion optimises handover, claims and QA. Both are true at different phases: runs dominate rough-in and warehouses (cable-tray kilometres); completion dominates fit-off, finals, hospitals. A first-year apprentice thinks in neither — they think in *instructions*.
*What survives:* batching mode is **context-dependent**; the model must not enshrine either. The run lens remains a worthwhile *view* hypothesis — build only if the field test shows workers asking area-by-area "what's left of *this kind*". The charter's instinct to make it a view (no schema change) was right; the instinct to make it Phase-3 roadmap was premature.

### D. "Drawings bound to the work" — **SURVIVES. Strongest of the five.**
Holds across job types (hospital: drawings+specs rule everything; warehouse: layouts rule; pub refurb: may have *no* drawings — which the binding handles by absence). The mapping cost concern resolves itself: area↔sheet binding is **origination work** (BuhlOS compile step — the #364–#368 scope spine that is already P0 and already shipping). Constitutional form: *work and records carry their context* — the drawing is part of a task's context, not a separate library trip. [#368](https://github.com/oskar-ott/BuhlOS/issues/368) confirmed as cornerstone.

### E. "Anti-section-creep law" — **SURVIVES, generalised.**
Rooted in fact (taxonomy leak observed twice in one week). But freezing *today's exact shape* (Hero→Now→Work→Capture→Reference) would be freezing a design decision. The timeless form: **screens have a fixed cognitive budget; new capability enters existing slots (action ranking · record context · the single reference group); adding a top-level element requires removing one.** Enforceable by render test counting top-level sections — the *count*, not the shape.

### One-scroll / no-tabs — **CRITERION SURVIVES, MECHANISM DOESN'T.**
The audit's anti-tab arguments (hidden state, split interruption recovery) are real but not conclusive; Uber Driver and Airbnb Host pass field tests *with* tabs by keeping critical state in a persistent header. Constitutional form: **critical state is never hidden behind navigation; interruption recovery costs ≤1 gesture.** [#133](https://github.com/oskar-ott/BuhlOS/issues/133) becomes an *experiment judged by that criterion* in the field test — not pre-decided in either direction. (The audit overstepped by recommending against; the charter compounded it.)

---

## 3 · The real mental model — the honest, non-simple answer

**It is context-dependent, along four axes, and the model must say so:**

| Axis | Poles | Implication |
|---|---|---|
| **Job scale** | pub refurb ↔ 500-apartment tower | Hierarchy must be **elastic**: a zero-structure job (no areas, just capture + hours + a punch list) is first-class, not a degenerate case |
| **Phase** | rough-in ↔ finals/defects | Batching flips: runs ↔ room-completion ↔ defect-chasing (list-driven). No single lens is "the" lens |
| **Role** | apprentice ↔ tradesman ↔ LH | Apprentice = *instruction* ("do what I was told, prove it"); tradesman = *place + kind*; LH = *coverage + crew*. Same data, three lenses |
| **Structure quality** | fully compiled job ↔ "just rewire it mate" | The app adapts to what exists; it never demands structure before allowing work |

**What is invariant across all cells** (and therefore constitutional): work has a *place*; the *instruction* (foreman's word) outranks any computed ordering; records happen *at the moment of work* or not at all; memory works *by exception* (done-except + blocked-because); interruption is the environment, not an edge case; the drawing/spec is the reference of record where it exists; hours are the *receipt* of the day.

## 4 · Stable concepts (10-year) vs views

**Foundational (model these):** Job · Worker · Area (place) · Task (promised unit of work) · Phase/Stage (*concept* stable; the rough-in/fit-off *pair* is per-trade config) · Drawing + Revision · Photo/Evidence · Defect (snag) · Check (ITP) · Hours day-record · Material (request/consumption) · **Instruction/Allocation (the foreman's word — currently the one missing foundational concept; today it lives in `assignedJobIds` + speech)** · Circuit/Device (electrical truth — future-foundational, arrives with the drawings ladder).
**Views (never storage):** Run · Day *plan* · My Day · "Now" ranking · Needs-you · week strip · progress % · queues · coverage grids. **Phil's architecture is sound exactly insofar as these stay views.**

## 5 · Audit recommendations re-classified

✅ **Permanent (fact-backed):** type floor *principle* (legible at arm's length in sun) · 48px floor on frequent actions · kill the 7px/`opacity-50`/two-dialect styling · no hidden-gesture-only actions · offline-honesty as adoption-critical · PIN-holders shouldn't face office labels · explainer prose only where it teaches (empty states) · capture flow is at standard, protect it.
⚠️ **Likely correct (ship, reversible):** declutter My Day (apology note etc.) · merge attention strip into the ranked panel · jobs list today-relevance · ITP auto-save on blur · gear condition grouping · 3-card tour.
❓ **Field-gated (do not freeze):** "Now" vs "Quick actions" naming (the team already deliberated once and chose the opposite — two reasonable owners disagree ⇒ exactly what #132 settles) · hero-state-machine *as the* My Day shape · one-scroll vs tabs (#133) · run lens · day-plan framing · win states' emotional pitch.
❌ **Probably incorrect (retract):** the audit's flat "recommend against #133" (overreach — replaced by the criterion) · the charter's office-maintained stage field (B as written) · Day-as-root as architecture rather than as the *what-now* question (A as written) · treating the run lens as a committed Phase-3 roadmap item.

## 6 · Backlog classification (analysis only — NOTHING executed)

| Issue | Ruling | Reason |
|---|---|---|
| [#421](https://github.com/oskar-ott/BuhlOS/issues/421) PIN door · [#423](https://github.com/oskar-ott/BuhlOS/issues/423) legibility · [#424](https://github.com/oskar-ott/BuhlOS/issues/424) quick wins | **KEEP — ship now** | Pure Category-1 repairs; constitution-aligned regardless of any future IA |
| [#139](https://github.com/oskar-ott/BuhlOS/issues/139)→[#143](https://github.com/oskar-ott/BuhlOS/issues/143)→[#135](https://github.com/oskar-ott/BuhlOS/issues/135) offline · [#138](https://github.com/oskar-ott/BuhlOS/issues/138) perf | **KEEP — elevate** | Constitutional (P8); architecture-independent |
| [#132](https://github.com/oskar-ott/BuhlOS/issues/132) field review | **KEEP — now the ratification instrument** | Script must test the ❓ set: what-now framing, run demand, stage memory, naming, tabs criterion |
| [#422](https://github.com/oskar-ott/BuhlOS/issues/422) My Day hero | **REWRITE** | From "hero state machine on My Day" to "Phil opens answering *what now*" — surface left open (Day view vs job-rooted for single-job crews); absorbs #136 |
| [#136](https://github.com/oskar-ott/BuhlOS/issues/136) daily briefing | **MERGE → #422-rewrite** | Same root (E1); close with pointer at execution |
| [#133](https://github.com/oskar-ott/BuhlOS/issues/133) tabbed job interface | **BLOCK (reframed, not buried)** | Becomes an experiment judged by the hidden-state criterion in #132 — *not* pre-decided against |
| [#425](https://github.com/oskar-ott/BuhlOS/issues/425) resume-by-place | **KEEP — expand** | Becomes the home of stage-memory (the repaired decision B); interruption is constitutional |
| [#145](https://github.com/oskar-ott/BuhlOS/issues/145) recents/favourites | **REWRITE** | Today-relevance ordering; "recents" framing superseded |
| [#146](https://github.com/oskar-ott/BuhlOS/issues/146) long-press actions | **CLOSE (at execution)** | Violates P12 (no hidden-gesture-only); re-admissible only as redundant shortcuts |
| [#144](https://github.com/oskar-ott/BuhlOS/issues/144) in-job search | **BLOCK until spine lands** | Escape-hatch; measure demand after |
| [#147](https://github.com/oskar-ott/BuhlOS/issues/147) voice · [#148](https://github.com/oskar-ott/BuhlOS/issues/148) camera · [#149](https://github.com/oskar-ott/BuhlOS/issues/149) gestures | **KEEP** (P2/P2/P3) | Aligned; platform-standard gestures are conventions, not hidden features |
| [#426](https://github.com/oskar-ott/BuhlOS/issues/426) who's on the job | **KEEP P2** | Aligned (crew line; honest presence only) |
| [#427](https://github.com/oskar-ott/BuhlOS/issues/427) win states | **KEEP P3, reframe** | Completion is a *place* statement (area walked down; week receipted) |
| [#368](https://github.com/oskar-ott/BuhlOS/issues/368) scope context on task | **KEEP P0 — cornerstone** | It *is* decision D |
| Bible/phil adjacents #219 #210 #230 #242 #233 | **KEEP, sequence later** | #219 enters as a Now-blocker (no new section — P10); #210 should be *fed by* the end-of-day receipt |
| Charter's 5 "derived issues" | **TRIMMED to 2 + 1 gated** | Day-plan issue → *is* the #422 rewrite (not new). Stage-context → folds into #425. Drawings↔areas → rides #364–#368 (no new issue). Survivors to file at execution: anti-creep render-test guard; jobs-list relevance (as the #145 rewrite). Run lens: **file only if #132 validates demand** |

Net at execution: −2 (close #146, fold #136), 2 rewrites, 2 blocks, +1 small guard issue, +1 conditional. The charter wanted +5; ratification cut it. That is the process working.

## 7 · Dependency tree — what waits on what

```
CONSTITUTION (user ratifies the 15 principles)                     ← decide FIRST
   ↓
#132 FIELD TEST (the instrument; script = the ❓ list)              ← only true blocker, ~half a day
   ↓
IA FREEZE: elastic hierarchy · allocation-as-concept (lightweight) · phase-set-as-config ·
           what-now root surface decision (Day view vs job-rooted)
   ↓
NAVIGATION: #133 experiment resolved by criterion (tabs vs scroll) — not before
   ↓
SCREEN HIERARCHY: job-page shape (Now hero, reference grouping, anti-creep budget) · My Day shape
   ↓
SCREENS: #422-rewrite · #145-rewrite · #426 · run-lens-if-validated
   ↓
COMPONENTS: #425(+stage memory) · ITP autosave · gear grouping
   ↓
STYLING: #423 (already law-by-fact — may ship ahead of everything)
   ↓
MICRO: #427 · #149 · haptics
─────────────────────────────────────────────
WAITS ON NOTHING (parallel lane): #424 · #423 · #421 · #139→#143→#135 · #138
```

## 8 · Final recommendation — *"starting from zero, would we choose the same architecture?"*

**Mostly yes — with three changes we should now make anyway, and one thing we'd never rebuild.**

**Yes, we would re-choose:** Job → Area → Task as the spine (place is how site work is addressed, on every job type tested); records-inherit-context; the pure command model feeding a ranked "what now"; capture-first design; the honesty rules; blob-now/Postgres-next; the closed-loop product thesis. These survived every break attempt.

**No — three things we'd do differently from day one, and should correct now:**
1. **Model the foreman's allocation** as a lightweight first-class concept (one human-entered line: who/where/what today). It is the strongest organiser of a worker's day and the only foundational concept Phil is missing. (Small: a record, not a workflow engine.)
2. **Make the hierarchy elastic from the start** — a structureless job is a first-class citizen (capture + hours + punch list), so a pub refurb never wears tower ceremony.
3. **Treat stage as per-area memory/evidence, not a binary enum** — the rough-in/fit-off pair becomes per-job-type configuration; the app's stage awareness comes from what workers actually did, not from a field someone forgot to update.

**And we would never rebuild:** My Day as a timesheet-first surface. The home of the app is the question *"what now?"* — the timesheet is its receipt.

None of the three changes requires a rewrite; all are additive to the existing spine. **That is the strongest possible endorsement of the current codebase — and the reason to ratify the constitution now, before the next hundred issues are written against anything less.**

---
*Companion documents: `docs/phil-constitution.md` (the proposed law) · `docs/phil-ux-master-audit.md` (evidence) · `docs/phil-ux-architecture-v2.md` (superseded in part by this analysis — A/B/C amended, D/E ratified in generalised form). Commit all four together upon ratification.*
