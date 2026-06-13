# Phil Implementation Roadmap

**Package:** Constitution → Architecture → Governance → Field Validation → **Roadmap**. Pure execution — no philosophy. Every item below already exists as a ratified conclusion, a filed issue, or a chartered disposition; this document only sequences them. Status table updates freely as phases complete (governance §6).

---

## Phase 1 — Architecture-independent improvements *(no validation dependency; start immediately)*

Fact-tier repairs; correct under any outcome of the field session.

| Work | Issue | Notes |
|---|---|---|
| Touch-target floor (Mark done 40px→48px, Call/Text, tray-×), home-screen declutter, explainers→empty-states | [#424](https://github.com/oskar-ott/BuhlOS/issues/424) | One PR, CSS/copy only. Excludes the "Now" rename (field-gated) |
| Typography floor — kill ≤10px styles, ≥14px glanceable, one design dialect, no opacity-states | [#423](https://github.com/oskar-ott/BuhlOS/issues/423) | Adds the grep-style floor test (becomes the governance §5 floor gate) |
| Worker-grade sign-in (name + PIN) | [#421](https://github.com/oskar-ott/BuhlOS/issues/421) | Office form untouched (frozen hooks) |
| Offline confidence trio, in order | [#139](https://github.com/oskar-ott/BuhlOS/issues/139) → [#143](https://github.com/oskar-ott/BuhlOS/issues/143) → [#135](https://github.com/oskar-ott/BuhlOS/issues/135) | Honest failures → capture outbox → read cache (today's job + current sheets first) |
| Interruption recovery — resume by place | [#425](https://github.com/oskar-ott/BuhlOS/issues/425) | Expanded per architecture §2 to carry stage-memory |
| 4G cold-start / job-home perf budget | [#138](https://github.com/oskar-ott/BuhlOS/issues/138) | |

**Exit:** all merged + preview-verified; floor tests green in CI.

## Phase 2 — Constitution-aligned backlog consolidation *(the ratified dispositions, executed in one pass)*

| Action | Target |
|---|---|
| Rewrite | [#422](https://github.com/oskar-ott/BuhlOS/issues/422) → "Phil opens answering *what now?*" (surface left open per architecture §4); [#145](https://github.com/oskar-ott/BuhlOS/issues/145) → today-relevance ordering |
| Merge/close | [#136](https://github.com/oskar-ott/BuhlOS/issues/136) folds into the #422 rewrite (close with pointer); [#146](https://github.com/oskar-ott/BuhlOS/issues/146) closed per P12 (hidden-only gestures) |
| Block with reason | [#133](https://github.com/oskar-ott/BuhlOS/issues/133) (experiment, judged by the P9 criterion post-field-test); [#144](https://github.com/oskar-ott/BuhlOS/issues/144) (until the spine lands; re-test demand) |
| File (the only new issues) | the P10 budget guard (render-test on section count — also the governance §5 budget gate); the #145-successor if rewritten-as-new is cleaner |
| Conditional | run-lens issue filed **only if** the field session validates demand |
| Epic | file "Epic 19 — Phil UX Architecture (constitutional)" from the package; re-parent #421–#427 and the blocked pair under it; add principle citations per governance §4 |
| Commit | the constitutional package + historical record committed together (the ratification commit, governance §2) |

**Exit:** tracker matches the ratification analysis §6 exactly; every Phil issue cites its principles.

## Phase 3 — Field validation *(human-run)*

Seed + run `docs/phil-field-validation-kit.md` with ≥3 crew (apprentice, tradesman, LH). Sheets and recordings return for compilation. **30-day provisional-expiry clock runs from the Phase-2 commit** (governance §2).

**Exit:** filled sheets delivered.

## Phase 4 — Ratification

Compile the per-principle ✅/⚠️/❌ report (evidence only; sealed predictions opened; overfit check applied). All-✅ → Constitution **frozen**, provisional tier commences. Any ⚠️/❌ → amendments via governance §3, then freeze. Decide #133 and the run lens from the evidence. Update the package documents' status lines.

**Exit:** Constitution status = frozen (or amended-and-frozen); field-gated questions decided.

## Phase 5 — Architecture-dependent implementation *(unlocked by Phase 4)*

| Work | Derives from |
|---|---|
| The what-now root surface (the #422 rewrite, built as validated — day view or job-rooted) | Architecture §4 · P4 |
| Job page "Now" hero: command panel absorbs the attention strip; reference collapses to one group; budget enforced | Architecture §4 · P9/P10 · naming per field evidence |
| Stage-as-memory defaults (rides #425) | Architecture §2 |
| **Instruction/Allocation modelled** (the carried foreman line) + LH entry door for it | Architecture §1 · P3 |
| Drawings/materials bound to the task — [#368](https://github.com/oskar-ott/BuhlOS/issues/368) (P0) + area↔sheet mapping riding the BuhlOS compile spine (#364–#367) | Architecture decision D (ratified) — *may start during Phase 3; D is not provisional* |
| Run lens (only if validated) · [#426](https://github.com/oskar-ott/BuhlOS/issues/426) crew line · [#427](https://github.com/oskar-ott/BuhlOS/issues/427) win states · [#147](https://github.com/oskar-ott/BuhlOS/issues/147)/[#148](https://github.com/oskar-ott/BuhlOS/issues/148) | Architecture §§1–3 |

**Exit:** Phil's L1 surfaces answer "what now?" within the budget, from the validated model.

---

## Status

| Phase | State |
|---|---|
| 1 | **Ready — no blockers** |
| 2 | Ready on product-owner "go" (it touches the tracker) |
| 3 | Awaiting a human session (kit ready) |
| 4 | Awaits 3 |
| 5 | Awaits 4 (except the #368/D lane) |
