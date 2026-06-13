# Phil UX Architecture v2 — mental model, hierarchy, and issue consolidation

> **HISTORICAL RECORD (frozen).** Superseded in part by hostile ratification: decisions A (Day-root), B (office-set stage) and C (run lens as roadmap) were **amended** — see `docs/phil-constitution-ratification.md`. The governing successor is `docs/phil-architecture.md`. Do not cite this document as current architecture.

**Pinned:** `origin/main @ bd1d3dd`, 2026-06-12 · **Status: CHARTER DRAFT — for ratification, not yet an epic.** Per instruction, this document creates no issues and changes none; Part 4 lists the exact dispositions to execute once ratified. The §2 mental model is domain-reasoned and must be validated by the [#132](https://github.com/oskar-ott/BuhlOS/issues/132) field test (its script gains three questions — see Part 5).

**The question this answers:** is Phil's underlying philosophy — not its pixels — the way electricians actually organise work on a commercial fit-out? Where it is, lock it in writing. Where it isn't, fix the model before another hundred issues inherit the error.

---

## Part 1 — Critique of the current product philosophy

### What is right, and must be written down so it stays right

1. **Closed loops only.** Field → office → decision → record → audit. This is the product's spine and it is correct.
2. **Honest data.** No invented counts, "No tasks yet" over fake 0%, limitations stated. Rare and precious.
3. **Capture-first.** The camera on the same tap, photos surviving accidents, "send to the office" replacing texts — this is the one surface already at the standard, because it was designed from a *moment* (worker sees something) not a *module*.
4. **The Job → Area → Stage → Task skeleton.** Place-first decomposition matches how fit-out work is assigned, walked, and remembered. The spine is right.
5. **The stupid-simple bar** exists in writing and in tests (frozen strings, render tests, 44px discipline).

### Where the philosophy is wrong — five structural errors

**E1 · My Day is a timesheet wearing the home screen's clothes.**
The worker's day is *work, located somewhere, with hours as the receipt at the end*. Phil's My Day is hours-first (week strip, log sheet, payroll states) with work nowhere on it. That is the office's mental model — payroll compliance — projected onto the worker's front door. The existence of [#136](https://github.com/oskar-ott/BuhlOS/issues/136) ("add a daily briefing — what am I doing today") is the confession: *the day's work is missing from the day screen.* The audit's hero-state-machine ([#422](https://github.com/oskar-ott/BuhlOS/issues/422)) fixed the symptom (too many cards) but kept the frame (hours at the centre). Wrong frame.

**E2 · The job page mirrors the software's org chart, not the site.**
Sections = modules: Issues (snags module), Checks (ITP module), Test and tag (tags module), Documents (register module), Who to call (contacts module). Every epic that ships grows the worker's scroll by one card — observed twice *this week* (tags, contacts re-grew the page after the #98/#99 simplification arc). Section creep is therefore **structural, not accidental**: the backlog's feature-module taxonomy is leaking into the worker's screen. A worker's frame is *place + what's next*, never "which module am I in." Without a written rule, the page will regrow forever.

**E3 · Stage is modelled as an attribute; on site it is a season.**
Rough-in and fit-off are different months, different tools, a different mindset — and which one applies to an area is imposed by *other trades' progress* (you can't fit off an unpainted wall). The current UI makes stage a per-visit toggle inside each area card: a decision the app demands daily that the site already made. The app should *know* what season each area is in.

**E4 · The hierarchy is one-way and ignores the run.**
Electricians batch identical tasks across areas — "I'll do every downlight on this level while the ladder's set up," "terminate all of SB2's circuits" — because movement and tool-setup cost dominates. Job→Area→Task makes per-area completion legible and **cross-area batching invisible**. No issue in the backlog covers this. It is the single biggest *missing* idea.

**E5 · The product self-teaches with a tour because the IA doesn't self-teach.**
Nine onboarding screens are the receipt for E1/E2. When the day screen states the day and the job screen states the next action, the tour shrinks to a welcome card.

**Verdict: the philosophy is ~80% right.** The spine (place-first hierarchy, closed loops, honesty, capture-first) survives scrutiny. The 20% that's wrong — day-frame, module-leak, stage-as-question, missing run — is exactly the layer that hundreds of issues would otherwise inherit.

---

## Part 2 — How an electrician actually organises a commercial fit-out

*(First-principles + trade-practice reasoning. Assumptions flagged ⚠ are #132 validation targets.)*

**The grid is Area × Stage, imposed by the site, not chosen by the worker.**
A fit-out is physically organised by level → zone/room. Temporally it moves in trade-sequenced stages per area: walls open → **rough-in** → close-up → (other trades) → paint → **fit-off** → terminate → test/commission → defects. Which areas are workable *today* is determined by other trades and the foreman — not by any list in an app.

**Work executes in runs.**
Within an available area+stage, the worker batches by kind: same tool, same ladder height, same body position, repeated across points and often across rooms. Setup cost is the tax; the run amortises it. ⚠ *Validate: do the crew think "do all the GPOs on L2" or "finish room by room"? (Answer is usually both — runs within a level, completion by room.)*

**The day loop:**
arrive → *"where am I / what am I on?"* (foreman's words, yesterday's memory, a text) → set up for one kind of work in one place → run it → blocked? (no stock, other trade in the way, no access) → switch area or switch kind → smoko/lunch/interruptions every few minutes → resume **by place** ("I was in East Gym") → end of day: pack up, *"where did I get to"*, hours.
Hours are the **receipt** of the day, written once. The plan is the day; the timesheet is its shadow.

**Memory works by exception.**
An experienced tradie doesn't recall task lists; they recall completion + blockers: *"East Gym's done except two GPOs — waiting on stock."* The app that matches this shows, per area: how done, **what's left, and why anything's stuck** (the blocker/material link is first-class, not a footnote).

**Knowing an area is finished** = the walk-down: visual sweep + the checkpoints (ITPs) + no open defects. "Finished" is a *place* statement, never a task-count statement alone — which is why ITP gates and snags must attach to areas to mean anything.

**Avoiding missed/duplicate work** is a *coverage* problem across the Area×Stage grid: the dread is the room nobody went back to. The grid view (what's open per area per stage) is the anti-missed-work instrument.

**Drawings are the senior source of truth.** Workers navigate the job *by sheet* ("E-201, Level 2 power") at least as much as by any list; markups are how reality gets recorded. Drawings therefore belong **bound to the place and the task** (one tap from "Work to do in East Gym" to East Gym's sheet), with the library as fallback — not the reverse.

**Paperwork (photos, ITPs, notes, defects) only happens at the moment and place of work.** Any flow that defers it to "later, in the right module" produces nothing. Capture-first got this right; the rule must be universal: **records inherit context from where they're created** — {job, area, stage, task} — through every door (FAB, area view, task row).

**Interruption recovery = place + next.** Ten minutes after the boss call, the question is "where was I and what was next there" — both must survive navigation, backgrounding, and app death.

**Where the foreman fits:** the morning allocation ("you're on L2 East with Jacko, fit-off") is the strongest single organiser of a worker's day. ⚠ *Validate: does Tom/LH allocate daily in words? (Almost certainly.)* The app should *receive* that allocation (one line from LH/boss) rather than pretend to compute it.

---

## Part 3 — The recommended information architecture

**Keep the spine. Re-root the app at the Day. Make stage ambient. Add the run lens. Bind drawings to work.**

```
DAY (root surface — "what now?")
 └─ JOB-NOW (the foreman card: one ranked next action + blockers, from the command model)
     └─ PLACE (Area × Stage work view ··· pivotable to RUN view: same data, kind-first)
         └─ RECORD (task done · photo · check · issue · note — context inherited)
 Reference (drawings · docs · site · contacts · crew) — collapsed, one layer, never grows the spine
 Receipt (hours) — one tap from the Day, pre-filled by the day itself
```

### The five architecture decisions

**A. The Day is the root, not the Job.** My Day = *today's plan*: today's job(s) and area focus (foreman's line when present, else inferred from yesterday/assignment), what's left there, what needs you — and the hours **receipt** as a single action, not the page's identity. This merges [#422](https://github.com/oskar-ott/BuhlOS/issues/422) and [#136](https://github.com/oskar-ott/BuhlOS/issues/136) into one correct thing. *(End-of-day is one motion: "log 7h36 + mark where you got to" — the receipt and the resume-point are the same moment.)*

**B. Stage is context, not a question.** The job (and area, where mixed) carries a current-stage default set by office/LH ("this job is in fit-off now"). Workers see the right task lists with zero stage decisions; override remains one tap away. Tiny model addition; removes a decision from every drill-in; makes "Continue East Gym · fit-off" sayable.

**C. The Run lens.** One toggle on the work view pivots Area-first ↔ Kind-first: "Power points — 14 left across 6 areas," ordered by place. Pure *view* over existing data (task templates already repeat across areas); no schema change; directly mirrors how runs execute. The anti-missed-work grid falls out of the same pivot (areas × remaining).

**D. Drawings/materials bind to the work.** [#368](https://github.com/oskar-ott/BuhlOS/issues/368) (P0, already chartered) is the cornerstone: the task carries its drawing ref, materials, warnings. Area ↔ sheet mapping makes "the drawing for where I'm standing" one tap from Work-to-do. The Plans section remains as the library; the binding is the worker's path. (The AI-drawings ladder #199/#206 later automates the mapping.)

**E. The anti-creep law (kills E2 permanently).** *No capability may add a top-level section to the job page.* New capabilities enter as: a ranked action in **Now** (when actionable), context on a Record (when situational), or a row inside the single collapsed **Reference** group (when informational). The screen's shape is fixed: Hero → Now → Work (Place/Run) → Capture → Reference. Anything else is a regression, enforceable by a render test counting top-level sections.

### Supporting rules (the epic's standing law)

- **Navigation philosophy:** one scroll per surface, L1→L3 progressive disclosure; **no tabs inside the job** unless the #132 field test contradicts (tabs hide state and split interruption recovery across invisible panes). [#133](https://github.com/oskar-ott/BuhlOS/issues/133) is therefore an *output* of this charter, not an independent decision.
- **Context model:** every record inherits {job, area?, stage?, task?} from its creation point; multiple doors to the same record are a feature (FAB, area view, task row, Day card) — never duplicate *storage*, always duplicate *entry*.
- **Interruption recovery:** place + next survive everything — last area/stage per job persists on-device ([#425](https://github.com/oskar-ott/BuhlOS/issues/425)); the Day re-states the plan on every open.
- **Cognitive-load budget:** L1 of any surface = ≤1 decision; a screen answers *where am I / what is this / what's next* in 3 seconds; everything else is below the fold or behind one disclosure.
- **Density/legibility:** the [#423](https://github.com/oskar-ott/BuhlOS/issues/423) floor (4 sizes, 12px min, ≥14px glanceable, one dialect) is law.
- **Field standards:** 48px primary targets, no hidden-gesture-only actions, consequence-copy confirms on destructive/identity actions, offline honesty per #139/#143/#135.
- **First-use:** the IA self-teaches; tour ≤3 cards; the door is name+PIN ([#421](https://github.com/oskar-ott/BuhlOS/issues/421)).
- **Vocabulary:** site words only (Issues, Checks, runs, rough-in/fit-off); the foreman voice ("Now: …") not the SaaS voice ("Quick actions").

---

## Part 4 — Disposition of every Phil UX issue

### The seven from this week's audit (#421–#427)

| Issue | Verdict | Why |
|---|---|---|
| [#421](https://github.com/oskar-ott/BuhlOS/issues/421) worker sign-in (PIN) | **Keep unchanged** | The door. Architecture-independent; ship early |
| [#422](https://github.com/oskar-ott/BuhlOS/issues/422) My Day hero state machine | **Rewrite** (absorb [#136](https://github.com/oskar-ott/BuhlOS/issues/136)) | Right instinct, wrong frame (E1). Becomes **"My Day = the day plan"**: today's work + needs-you as the hero, hours as the one-tap receipt. The state machine survives as the hero's logic |
| [#423](https://github.com/oskar-ott/BuhlOS/issues/423) legibility floor | **Keep** | Presentation law; architecture-independent; ship now |
| [#424](https://github.com/oskar-ott/BuhlOS/issues/424) quick wins | **Keep** | Ship now; nothing in it conflicts |
| [#425](https://github.com/oskar-ott/BuhlOS/issues/425) resume-last-area | **Keep** (fold under epic) | It *is* the interruption-recovery rule's first brick |
| [#426](https://github.com/oskar-ott/BuhlOS/issues/426) who's on this job | **Keep, P2** | Day-plan-aligned (the crew line); reference zone |
| [#427](https://github.com/oskar-ott/BuhlOS/issues/427) win states | **Keep, P3** | Reframe: completion is a *place* statement (area walked down), week receipt squared away |

### The pre-existing Phil set

| Issue | Verdict | Why |
|---|---|---|
| [#132](https://github.com/oskar-ott/BuhlOS/issues/132) field review | **Keep — now also ratifies this charter.** Add 3 script questions: run-vs-room batching ⚠, stage-as-season truth ⚠, does the day-plan framing land ⚠ |
| [#133](https://github.com/oskar-ott/BuhlOS/issues/133) tabbed job interface | **Block** until charter ratification + #132. Tabs are a navigation-philosophy output, not a feature. Current evidence: against |
| [#136](https://github.com/oskar-ott/BuhlOS/issues/136) daily briefing | **Merge into #422-rewrite, then close with pointer.** It was the symptom report for E1 |
| [#135](https://github.com/oskar-ott/BuhlOS/issues/135)/[#139](https://github.com/oskar-ott/BuhlOS/issues/139)/[#143](https://github.com/oskar-ott/BuhlOS/issues/143) offline trio | **Keep, elevate to adoption-critical track.** Architecture-independent. Sequence: #139 (honest failure) → #143 (capture outbox) → #135 (read cache: today's job + its sheets first — note the Day-root makes "what to cache" obvious) |
| [#138](https://github.com/oskar-ott/BuhlOS/issues/138) perf budget | **Keep** |
| [#141](https://github.com/oskar-ott/BuhlOS/issues/141) sunlight/glove pass | **Keep** — validates #423 outdoors |
| [#144](https://github.com/oskar-ott/BuhlOS/issues/144) in-job search | **Block until Phase 1 lands.** Search is the escape hatch; if the IA is right it's rarely needed. Revisit demand afterwards |
| [#145](https://github.com/oskar-ott/BuhlOS/issues/145) recents/favourites | **Rewrite.** Half-superseded: "today's job first" is the Day's job, not a recents feature. Surviving scope: favourites/pinning for many-job workers → fold into jobs-list ordering by today-relevance |
| [#146](https://github.com/oskar-ott/BuhlOS/issues/146) long-press quick actions | **Close with reason.** Hidden gestures violate the discoverability/glove law ("impossible to misuse"). Re-admissible later only as *redundant* shortcuts |
| [#147](https://github.com/oskar-ott/BuhlOS/issues/147) voice dictation | **Keep, P2.** Dirty hands argue *for* it; belongs in capture + notes |
| [#148](https://github.com/oskar-ott/BuhlOS/issues/148) camera improvements | **Keep** |
| [#149](https://github.com/oskar-ott/BuhlOS/issues/149) gesture polish | **Keep, P3** — platform-standard gestures (swipe-back, pull-refresh) are fine; they're conventions, not hidden features |
| [#368](https://github.com/oskar-ott/BuhlOS/issues/368) scope context on task | **Keep, P0 — promoted to cornerstone.** It *is* architecture decision D |

### Job-bible issues that touch Phil (sequence, don't change)

[#219](https://github.com/oskar-ott/BuhlOS/issues/219) safety-doc acknowledge (enters as a **Now** blocker — perfect fit, no new section) · [#210](https://github.com/oskar-ott/BuhlOS/issues/210) site diary (the end-of-day "where I got to" should *feed* it — note synergy in #422-rewrite) · [#230](https://github.com/oskar-ott/BuhlOS/issues/230) services locations (Reference) · [#242](https://github.com/oskar-ott/BuhlOS/issues/242) gallery (after capture pipeline) · [#233](https://github.com/oskar-ott/BuhlOS/issues/233) as-builts (later; rides D).

### To **derive** from the epic once ratified (the only new issues this charter will ever justify)

1. `phil: my day is the day plan` — the #422 rewrite absorbing #136 (A).
2. `phil: stage is context — job/area current-stage default` (B).
3. `phil: the run lens — kind-first pivot across areas` (C).
4. `phil: the job page anti-creep law — fixed shape + render-test guard` (E; includes the Now hero absorbing the attention strip and the L3 Reference collapse).
5. `jobs/docs: bind drawings to areas` (D's mapping half; #368 carries the task half).

**Net effect on count:** −2 (close #146, fold #136) +5 derived = +3, but every one traces to a ratified model instead of a symptom.

---

## Part 5 — Dependency map (what must be decided before what)

```
                    ┌──────────────────────────────────────────────┐
                    │  SHIP NOW (architecture-independent)         │
                    │  #424 quick wins → #423 legibility → #421 PIN│
                    │  offline: #139 → #143 → #135   ·   #138 perf │
                    └──────────────────────────────────────────────┘
 #132 FIELD TEST (augmented: run ⚠ · stage ⚠ · day-plan ⚠)
        │ validates §2
        ▼
 RATIFY THIS CHARTER  ──→  file the epic (Part 6 appendix) + execute Part 4 dispositions
        │
        ├─→ derived 1 · My Day = day plan  (rewrites #422, closes #136)
        ├─→ derived 4 · job-page Now + anti-creep law  (absorbs attention strip; #425 rides along)
        ├─→ derived 2 · stage-as-context   ──┐ unlock each other:
        ├─→ derived 3 · run lens           ──┘ run lens reads stage context
        ├─→ derived 5 + #368 · drawing/material binding (P0 track)
        └─→ #133 decided (expected: closed in favour of one-scroll; tabs lose)
 Later, model-consistent: #426 crew line · #147 voice · #148 camera · #219 · #210 · #144 (re-test demand) · #427 · #149
```

**The one true blocker is small:** nothing waits on a rewrite — only on a *decision*, and the decision waits on one half-hour with an electrician (#132).

---

## Part 6 — Roadmap to the simplest field app in construction

- **Phase 0 · This week — ship the invariants, test the model.** #424 → #423 → #421 land (no architecture risk). Run #132 with the augmented script. Ratify this charter; execute Part 4 (file epic + 5 derived issues, rewrite #422/#145, block #133/#144, close #146, fold #136).
- **Phase 1 · The spine (1–2 weeks).** Derived 1 (Day plan) · derived 4 (Now hero + anti-creep law + #425) · derived 2 (stage context). Phil now *answers* instead of listing.
- **Phase 2 · Confidence.** #139 → #143 → #135 (cache today's job + its sheets first — the Day-root defines the cache set) · #138. The basement stops being the app's enemy.
- **Phase 3 · The lenses.** Derived 3 (run lens) · #368 + derived 5 (drawing/material on the task) · #426 (crew line). The app now batches the way the worker batches.
- **Phase 4 · Depth.** #147 voice · #148 camera · #219 safety gate in Now · #210 diary fed by end-of-day · #144 if demand survives.
- **Phase 5 · Joy.** #427 walk-down win states · #149 gesture polish · #242 gallery.

**Definition of victory** (unchanged from the product's own words): a tradie opens Phil, knows what to do in 3 seconds, and after a week refuses to work without it — *because it remembers the site the way he does.*

---

## Appendix A — Ready-to-file epic draft

> **Title:** `Epic 19 — Phil UX Architecture v2 (the worker's mental model)`
> **Labels:** `epic`, `epic:phil-mobile`, `phil` · **Body:** §2 (mental model) + §3 (architecture decisions A–E + standing rules) of this document verbatim, plus:
> **Ratification gate:** [ ] #132 field test confirms/amends ⚠ assumptions → decisions A–E confirmed → dispositions executed.
> **Children:** derived 1–5 (above) · #421 #423 #424 #425 #426 #427 (re-parented) · #133 (blocked: decision pending) · #368 (cornerstone, shared with bible) · #144 (blocked until Phase 1).
> **Standing law:** the anti-creep rule (E) + cognitive-load budget + context-inheritance rule govern every future Phil issue regardless of epic.

*Charter by the audit session, 2026-06-12. Companion: `docs/phil-ux-master-audit.md` (the screen-level evidence). Neither is committed; commit both together when ratified.*
