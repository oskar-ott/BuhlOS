# Phil Governance

**Package:** Constitution → Architecture → **Governance** → Field Validation → Roadmap. This document defines how Phil *evolves* — the chain every change flows through, and how the law itself is amended. It invents no philosophy; it operationalises `docs/phil-constitution.md` (P15) and integrates the repo's existing conventions (`docs/issues.md`, the CI guard suite) rather than replacing them.

---

## 1 · The lifecycle of every change

```
CONSTITUTION  (15 principles — supreme, amended only by §3)
     ↓
GOVERNANCE  (this document — the process layer)
     ↓
ARCHITECTURE  (stable concepts, hierarchy, navigation philosophy)
     ↓
EPIC  (an umbrella with a charter that cites the principles it serves)
     ↓
ISSUE  (nine-section shape per docs/issues.md + constitutional alignment, §4)
     ↓
PR  (compliance gates, §5)
     ↓
PRODUCTION  (main-only deploys; preview-verified where field-facing)
     ↓
FIELD VALIDATION  (reality reviews the result — docs/phil-field-validation.md)
     ↓
CONSTITUTIONAL / ARCHITECTURE AMENDMENT  (if reality disagrees — §3)
     ╰──────────────── the loop closes upward ────────────────╯
```

No layer may skip upward: an issue that contradicts the architecture is wrong even if it's a good idea; an architecture change that contradicts a principle requires amending the principle *first*, with evidence.

## 2 · Commencement & ratification status

- The Constitution was board-ratified **with amendments** (2026-06-12). Two-tier commencement: **P1–P3, P5–P12 in force**; the behavioural tier (P4's framing, P13, P14, concepts list) is **provisional until the first field session** (#132).
- The package's first governance act is the **ratification commit**: all package + historical documents committed together by the product owner. Until committed, nothing here is citable law.
- **Provisional-expiry rule:** provisional status is not a parking lot. If no field session has run within **30 days** of package commit, the provisional items escalate to the product owner for an explicit decision: run the session, extend with reason, or ratify on desk evidence (recorded as such).

## 3 · Amendment processes

| Layer | Trigger | Requirements |
|---|---|---|
| **Constitution** | Field evidence contradicting a principle ([PHIL-X] marks), or a principle proving dogmatic in practice | Written rationale citing evidence · explicit product-owner ratification · the amendment recorded in the document's history note. **Field evidence outranks AI reasoning; AI reasoning outranks elegance** (evidence hierarchy in `docs/phil-field-validation.md`) |
| **Architecture** | New stable concept, relationship, or navigation-philosophy change | Must cite which principle(s) motivate it · must not contradict any in-force principle · same ratification path, lighter ceremony |
| **Governance** | Process failing in practice | Product-owner sign-off; keep the chain intact |

What never requires amendment: design decisions (screens, layouts, copy, mechanisms). They compete freely *underneath* the principles and may be replaced by anything that satisfies the same principle with less friction.

## 4 · Issue standards (extends `docs/issues.md` — does not replace it)

Everything in the existing conventions stands (nine sections, audited current-state, one `epic:*`, one priority, one surface, umbrella task-lists). Phil-surface issues additionally require:

1. **Principle citation:** one line — *"Serves: P6, P14"* — in the `Part of` header. An issue that cannot name its principle is either mis-scoped or new philosophy in disguise (send it to §3).
2. **Budget check (P10):** any issue adding UI states what existing slot it enters (ranked action · record context · reference group) — or what it removes.
3. **Tier check:** issues implementing provisional-tier behaviour are labelled blocked until commencement (§2).
4. **No-theatre check (P7):** acceptance criteria may not include invented numbers, fake states, or silent failure paths.

## 5 · PR compliance

Existing gates remain (CI guard suite, frozen test hooks, preview smoke for field-facing changes, `Closes #N`). Additionally for Phil surfaces:

- **The budget test:** the job-page top-level section count is test-enforced; a PR raising it fails unless it removes an equal number (P10). *(Guard to be implemented in Phase 2 of the roadmap.)*
- **The floor test:** type/tap-target floors per the field standards (P8's numbers live there, may tighten never loosen). *(Same Phase 2 guard.)*
- **Voice check (P11):** new worker-facing copy is site language; reviewers reject enterprise vocabulary.
- **Field-facing definition:** any change a worker can see or feel ships only after preview verification; L1-surface changes (the what-now answer, the job hero) additionally require a field-validation pass per `docs/phil-field-validation.md`.

## 6 · Document registry & keepers

| Document | Role | Mutability |
|---|---|---|
| `phil-constitution.md` | Supreme law | §3 only |
| `phil-architecture.md` | Structure | §3 (lighter) |
| `phil-governance.md` | Process | §3 (lightest) |
| `phil-field-validation.md` + `-kit.md` | Reality's instrument | kit evolves freely; authority doc via §3 |
| `phil-implementation-roadmap.md` | Execution state | updated freely as phases complete |
| audit · charter · ratification analysis | **Historical record** | frozen; never edited, only superseded |

**Keeper:** the product owner (Oskar) holds ratification authority. **Succession rule:** if the company grows past a single keeper, authority transfers to a named product council of ≤3 with one field representative — decided *then*, recorded *here*. Agents and contractors may propose at every layer and ratify at none.

---

## Appendix B · Prompt Governance Standard (project-wide, adopted 2026-06-12)

Applies to every prompt generated for the BuhlOS ecosystem (Phil, BuhlOS, governance, architecture, AI, strategy, UX, docs, planning). The assistant acts as **Chief Product Officer + Program Director**: it strengthens long-term coherence and **actively discourages unnecessary work**.

1. **Should the prompt exist?** Before generating one, decide whether implementation, field validation, or execution is more valuable than more analysis. If so, **recommend NOT creating the prompt.** Prompts move the project forward, never sideways; never repeat completed work or reopen settled decisions without new evidence.
2. **Every generated prompt is preceded by a context block:** (1) *Recommended Claude model* + why — **Opus** for governance/constitution/architecture/strategy/synthesis; **Code/Fable** for repo-wide reasoning, issue analysis, implementation planning, refactoring; (2) *Purpose* (what / why now / where in the lifecycle); (3) *Expected outcome* (measurable success); (4) *What happens next* (the roadmap step it unlocks).
3. **Quality:** clear objective · explicit constraints · success criteria · no ambiguity · respects ratified governance/constitution · no reopening ratified decisions without new evidence · fits the roadmap.
4. **Philosophy ranking:** governance > opinion · evidence > elegance · implementation > endless analysis · field validation > AI speculation · consistency > novelty · shipping > philosophical perfection. Reinforce governance; do not invent new philosophy.
5–7. **Prime Directive:** every prompt must raise the probability of shipping a better product. If its marginal value is below that of implementation or real-world validation, **it should not be generated** — recommend the action instead. Preserve continuity with prior constitutional/governance/architecture decisions; create no conflicting philosophy unless explicitly asked to challenge it.

**Lifecycle this serves:** Vision → Constitution → Governance → Architecture → Backlog Alignment → Implementation → Field Validation → Amendment → Continuous Improvement. A prompt that does not advance a step in this chain is the wrong artifact.
