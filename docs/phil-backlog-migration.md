# Phil Backlog — Constitutional Migration Plan

**Board:** Product Governance Board for Phil. **Date:** 2026-06-12. **Pinned:** `origin/main @ e65cdbd (#438)`; Phil set pulled live.

> **EXECUTION GATE (read first).** The constitutional package is **not yet ratified to origin** (`docs/phil-constitution.md` absent on `origin/main`; no tag). This document is the **migration plan** — the ratifiable artifact. The live GitHub mutations (rewrite/merge/block/close) are a **single pass executed on the product owner's "go", *after* the ratification PR merges** (governance §8). Nothing in the tracker is touched by producing this plan. Classifications here are decision-ready so "execute" is one confirmed step.

Scope: the **22 work issues under `epic:phil-mobile`** (#121 umbrella) are migrated fully. The **15 cross-epic Phil-surface issues** (label `phil`, other epics) get a lighter constitutional-touchpoint review — they are owned by their own epics' migrations, but their alignment and any conflicts are flagged here.

---

## Phase 1 — Authority loaded

Supreme order: `phil-constitution.md` (15 principles) → `phil-governance.md` → `phil-architecture.md` → `phil-implementation-roadmap.md`. This migration *derives from* the ratification analysis §6 and roadmap Phase 2 — it does not re-decide them; it adds the constitutional-alignment fields the governance model (§4) now requires of every Phil issue, and extends classification to issues those drafts didn't cover.

---

## Phase 2 + 3 — Every phil-mobile issue: verdict + constitutional alignment

Legend — **Arch?** = architecture layer touched · **FV?** = field-validation required before ship · **Budget** = cognitive/navigation impact (P10).

### KEEP (16)

| # | Issue | Principles | Arch? | FV? | Budget / nav | Worker benefit · Admin benefit |
|---|---|---|---|---|---|---|
| #132 | field UX review | P15 + all provisional | — (instrument) | **is the FV** | none | Validates the law against reality · de-risks every later issue |
| #135 | offline read cache v1 | P8 P14 | views over cache | no | none (same surfaces) | Job/plans/tasks in a basement · fewer "app's down" calls |
| #138 | 4G cold-start budget | P4 P6 | no | no | none | App opens fast · adoption |
| #139 | fail honestly on bad signal | P7 P8 | no | no | none | Never lose work silently · trust |
| #141 | sunlight/glove legibility pass | P8 | no | **yes (outdoor)** | none | Readable in sun · — (verifies #423/#424) |
| #143 | offline capture queue | P8 P13 | no | no | none | Photos survive no signal · evidence not lost |
| #147 | voice dictation (capture/notes) | P6 P13 | no | no | none (in-flow) | Notes with dirty hands · richer records |
| #148 | camera improvements | P8 P13 | no | no | none | Usable photos in bad light · better evidence |
| #149 | gesture polish (swipe-back/pull-refresh) | P8 | no | no | none (conventions, not hidden-only — distinct from #146) | Natural navigation · — |
| #368 | scope context on task | **P2 P14** | **decision D** | no (D ratified) | record context, no new section | Knows the drawing/materials at the task · less rework |
| #421 | worker PIN sign-in | P8 P11 | no | no | none | Signs in on day one · fewer onboarding calls |
| #423 | legibility floor (4 sizes/12px) | **P8** | no | no | none (adds the floor CI gate) | Readable everywhere · — |
| #424 | ux quick wins (glove/declutter/copy) | P6 P8 P10 P11 | no | no | **removes** the apology note | One-tap controls, calmer screen · — |
| #425 | resume where you left off (+stage memory) | **P8 P14** | §2 (stage-as-memory) | no | none | Resume after interruption · — |
| #426 | who's on the job today | P14 P7 | §1 (Crew) | no | reference zone (L3), no new section | Coordinate without texting · less radio chatter |
| #427 | all-clear win states | P14 | no | no | none | Finishing feels finished · — |

### REWRITE (2)

| # | Issue | Rewrite to | Principles | Arch? | FV? | Why |
|---|---|---|---|---|---|---|
| #422 | my day hero state machine | **"Phil opens answering *what now?*"** — surface left open (day-view vs job-rooted, per architecture §4); absorbs #136 | **P4** | §4 (root surface) | **yes** (surface is field-gated) | Right instinct, but the *frame* (hero on My Day) presumes the answer-surface the field test must decide. Rewrite states the question, defers the surface. |
| #145 | recents/favourites on jobs list | **today-relevance ordering** (today's job first; favourites only for many-job workers) | P4 P14 | no | no | "Recents" is a generic-app frame; the worker wants *today's* job surfaced, which is memory (P14), not history. |

### MERGE (1)

| # | Into | Why |
|---|---|---|
| #136 daily briefing | **#422-rewrite** | Same root: "the day's work is missing from the day screen." The briefing *is* the what-now answer's content. Close with a pointer at execution; #178 (ai-generated briefing content) feeds it later. |

### BLOCK (2)

| # | Issue | Blocked on | Principle basis |
|---|---|---|---|
| #133 | tabbed job interface | **#132 field test** | P9/P10. An experiment judged by the "critical state never hidden behind navigation" criterion — not pre-decided in either direction. The audit's flat anti-tabs ruling was retracted to this criterion (ratification §5). |
| #144 | in-job search | **spine landing (Sprint 4)** then re-test demand | P4/P10. Search is the escape hatch; if the IA answers "what now" and "what's left here," search is rarely reached. Measure demand after the spine, don't build the hatch first. |

### CLOSE (1)

| # | Issue | Why |
|---|---|---|
| #146 | long-press quick actions on FAB/job rows | **P12 violation** — hidden-gesture-only actions are not discoverable by sight; they fail the "impossible to misuse" bar. Re-admissible later *only* as a redundant shortcut to a visible action, never as the sole path. Close with that reason. |

**phil-mobile counts: 16 KEEP · 2 REWRITE · 1 MERGE · 2 BLOCK · 1 CLOSE = 22.**

### Cross-epic Phil-surface issues (touchpoint review — owned by their epics)

All **constitutionally clean** (record-context or reference-zone additions; none demand new top-level Phil navigation) **except two P10 watch-items**:

| # (epic) | Enters | Principle | Note |
|---|---|---|---|
| #128 #129 #142 (hours) | the log sheet (record context) | P6 P7 | #128 split-day is what #424 stops apologising for — sequence #424 first |
| #178 (ai) | content for #422-rewrite | P4 | feeds the what-now answer; sequence after #422 |
| #219 (bible) safety acknowledge | **a Now blocker** | P9 P10 | exemplary fit — a gate, not a section |
| #230 (bible) services locations | reference zone L3 | P10 | clean |
| #233 (bible) as-builts | rides drawings (D) | P2 | later |
| #263 #272 (capture) before/after, video | capture flow | P13 | same context contract — clean |
| #369 (capture) variation-from-site **(P0)** | capture destination/type | P13 P7 | money-leak fix; clean, high value |
| #275 (capture) QR→asset · #303 (inv) QR labels | capture/gear | P13 | ⚠️ **P10 watch:** must enter capture/gear, NOT a new scanner tab |
| #308 #326 (inv) consumption, van stock | gear/materials | P14 | clean |
| #340 (workforce) self-visible work record | More/reference | P14 | ⚠️ **P10 watch:** must enter the More tab, NOT a new top-level section |

---

## Phase 4 — Epic structure review

**Recommendation: RETAIN #121 "Epic 2 — Phil Mobile" as the single Phil umbrella — RENAME + recharter it. Do NOT create a parallel "Epic 19."**

*This refines the package draft (which proposed filing Epic 19) with reasoning:* `docs/issues.md` holds that the umbrella **is** the progress view; a second Phil umbrella fragments that view and forces every future contributor to ask "which Phil epic?". #121 already owns all 22 issues. Better structural move:
- **Rename** #121 → *"Epic 2 — Phil Mobile (constitution-governed)"* (or keep the name, add a body banner).
- **Add to #121's body:** a "Constitutional gate" section linking the package + the sprint grouping below, and the rule that every child cites its principle (governance §4).
- No split, no archive, no merge. One umbrella, now constitution-anchored.

Other epics: **no structural change** — their Phil-surface issues stay home (hours/capture/bible/inventory/workforce migrations handle them under the same principles). The constitution governs *across* epics via governance §4, not by relocating issues into one mega-epic.

---

## Phase 5 — Implementation order (sprints)

| Sprint | Theme | Issues | Gate |
|---|---|---|---|
| **0** | **Ratification** (the prerequisite) | the ratification PR (closes wiring G1–G3) + this migration's execution pass + branch protection | product-owner act |
| **1** | Architecture-independent, ship now | #424 · #423 · #421 · #139 · #138 | none — start immediately |
| **2** | Confidence + alignment | offline track #143 → #135 · #425 (resume) · #141 (outdoor verify) · the #145 rewrite | Sprint 1 partial |
| **3** | Field validation | **#132** (run the kit) → compile → freeze provisional tier; decide #133, run lens, #422 surface | human session |
| **4** | Architecture-dependent UX | #422-rewrite (what-now root) · Now hero (job page) + P10 budget guard · #425 stage-memory · #368/D drawings binding (may start earlier — D is ratified) | Sprint 3 ratifies |
| **5** | Depth + joy | #147 · #148 · #426 · #427 · #149 · (run-lens **only if** #132 validates) · #144 (re-test demand) | Sprint 4 |

Note: #368 and the BuhlOS compile-spine (drawings↔areas, #364–#367) are the one Sprint-4 workstream that **does not wait on the field test** — architecture decision D is ratified, not provisional. It can run parallel from Sprint 2.

---

## Phase 6 — Conflicts (listed separately, per the brief)

The backlog is **remarkably clean** — the anti-creep risk is concentrated in four issues, not spread:

| # | Conflict | Principle | Resolution |
|---|---|---|---|
| #146 | hidden-gesture-only actions | **P12** | CLOSE (above) |
| #133 | tabs may hide critical state / add navigation | **P9 P10** | BLOCK → field-test criterion decides |
| #144 | a search surface may become new top-level navigation | **P10** | BLOCK → only build if demand survives the spine; enter as in-context, not a new tab |
| #340 | self-visible record may grow a new top-level section | **P10** | enters the More tab — watch at design |
| #275 #303 | QR scanning may spawn a scanner entry point | **P10** | enters capture/gear, not a new tab |

No issue **assumes one workflow** or **one project type** in a way that conflicts (the run lens was already demoted to a field-gated view precisely to avoid this; #422-rewrite leaves the surface open for exactly this reason). No issue invents fake UI or numbers (P7). **Zero hard constitutional conflicts survive the migration** — every flagged item is resolved by CLOSE, BLOCK, or a design-time P10 watch.

---

## Phase 7 — Critical path to *Phil Constitution v1.0 Field Release*

```
[BLOCKER 0] Ratification PR merged  ──┐  (closes wiring G1–G3; makes the law citable)
                                      │
        ┌─────────────────────────────┼─────────────────────────────┐
        ▼ (parallel)                  ▼ (parallel)                   ▼ (parallel)
  Sprint 1                      Offline track                  #368 + compile-spine
  #424 #423 #421                #139 → #143 → #135             (D ratified — no FV wait)
  #139 #138                          │
        └──────────────┬─────────────┘
                       ▼
              [BLOCKER 1] #132 FIELD SESSION (human, ~½ day)
                       │  ratifies provisional tier; decides #133 / run-lens / #422 surface
                       ▼
              Sprint 4: #422-rewrite + Now hero (P10 guard) + #425 stage-memory
                       ▼
              ── PHIL CONSTITUTION v1.0 FIELD RELEASE ──
                       (tag phil-constitution-v1.0, post-field)
```

- **Two hard blockers:** the ratification PR (a keeper act, ~1 PR) and the #132 field session (a human ½-day). Everything else parallelises around them.
- **Three parallel workstreams** can run from day one: Sprint-1 legibility/login, the offline track, and the #368/compile-spine lane.
- **Minimum sequence to Field Release:** Ratify → Sprint 1 (legible/gloved/honest/signable) → #132 (validate) → #422-rewrite + Now hero (the app answers "what now"). That is the smallest set that makes Phil constitutionally complete on its L1 surfaces. Depth (Sprint 5) ships after release.

---

## Final report

1. **Total Phil issues reviewed:** 37 (22 `epic:phil-mobile` migrated fully + 15 cross-epic Phil-surface reviewed for alignment/conflict).
2. **Keep:** 16 (phil-mobile) — the cross-epic 15 also retained by their epics, none closed.
3. **Rewrite:** 2 (#422, #145).
4. **Merge:** 1 (#136 → #422).
5. **Block:** 2 (#133, #144).
6. **Close:** 1 (#146).
7. **Epic structure:** retain + rename/recharter **#121** as the single constitution-governed Phil umbrella; **do not** create Epic 19; no other epic relocations (governance §4 governs cross-epic).
8. **Sprint roadmap:** Sprint 0 ratify → 1 architecture-independent → 2 confidence/alignment → 3 field validation → 4 architecture-dependent → 5 depth (above).
9. **Critical path:** Ratification PR → {Sprint 1 ∥ offline ∥ #368} → #132 field session → #422-rewrite + Now hero → **v1.0 Field Release**. Hard blockers: the ratification PR and the human field session.
10. **Backlog health score: 84 / 100.**
   | Dimension | Score | Note |
   |---|---|---|
   | Constitutional alignment of surviving issues | 26/30 | high keep-rate — backlog was authored under the same instincts the law codifies |
   | Conflict load | 18/20 | only 4 watch-items, all resolved by CLOSE/BLOCK/design-watch |
   | Duplication / fragmentation | 13/15 | one merge (#136); one umbrella kept clean |
   | Principle-citation coverage | 5/15 | **the gap** — issues don't yet cite principles; the §4 template + this migration's execution close it |
   | Sequencing clarity | 14/15 | clear critical path, parallel lanes identified |
   | Ratification readiness | 8/5→ capped | plan decision-ready; **−** the law isn't committed yet (the one true drag) |

   The backlog is **healthy** — it barely needed surgery (1 close, 1 merge, 2 blocks out of 22) because it was generated under the product instincts the Constitution later formalised. The health score is held below 90 by exactly one thing: the issues don't yet *cite* their principles, and the law isn't yet committed to cite. Both close in the same ratification-plus-execution pass.

**Bottom line:** after this migration executes, every surviving Phil issue carries a principle citation, a sprint, and a slot — and future engineering proceeds without reopening philosophy, because the philosophy is settled, committed, and pointed-to from the issue template itself. **The migration is planned and decision-ready; it executes in one confirmed pass once the ratification PR merges.**

---
*Derives from: `phil-constitution.md`, `phil-architecture.md`, `phil-governance.md` (§4 alignment fields, §8 execution gate), `phil-implementation-roadmap.md` (Phase 2), `phil-constitution-ratification.md` §6 (dispositions, here extended + the Epic-19 refinement). Touches no GitHub issue.*
