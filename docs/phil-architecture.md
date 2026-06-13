# Phil Architecture

**Package:** Constitution → **Architecture** → Governance → Field Validation → Roadmap. This document defines how Phil is *structured* — concepts, hierarchy, relationships, navigation philosophy — never how it looks. It consolidates the architecture review **as amended by hostile ratification** (`docs/phil-constitution-ratification.md`); where this document and the original charter (`docs/phil-ux-architecture-v2.md`, historical) differ, this document governs. Supreme law: `docs/phil-constitution.md`.

---

## 1 · Stable concepts (the model) vs views (everything else)

**Foundational concepts** — these are modelled, stored, and expected to survive a decade:

| Concept | Meaning | Status |
|---|---|---|
| Job | The unit of engagement; may have zero structure (P5) | modelled |
| Worker · Crew | The person; the unit a leading hand thinks in | Worker modelled · Crew = relation over assignment, recognised concept |
| Area (× Area group) | Place — the primary address of work | modelled |
| Task | A promised unit of work, addressed to a place | modelled |
| Phase ("stage") | A trade-sequence gate per area. *The concept is stable; the rough-in/fit-off **pair** is per-job-type configuration, not law* | modelled (pair = current config) |
| Drawing + Revision | The reference of record where it exists; field sees current only | modelled |
| Photo / Evidence | Proof, captured at the moment of work | modelled |
| Defect (snag) · Check (ITP) | Quality records with lifecycles | modelled |
| Hours day-record | The **receipt** of a day — one per worker per date | modelled |
| Material (+ request) | What work consumes and waits on | modelled |
| **Blocker** | What's stuck, and why — first-class because memory works by exception (P14) | recognised; today expressed via observations/material-requests |
| **Instruction / Allocation** | The foreman's word: who/where/what today. *The one foundational concept not yet modelled* — lightweight (a carried line, never a workflow engine), authoritative per P3 | **to be modelled** (Phase 5) |
| Circuit · Device | Electrical truth | future-foundational (arrives with the drawings ladder) |

**Views — never storage:** the run · the day *plan* · "what now" rankings · needs-you · week strip · progress % · coverage grids · queues. Views may slice the model any way that helps a context; they never gain their own data. **Views stay views.**

## 2 · The hierarchy (elastic by law)

```
JOB ──▶ AREA GROUP ──▶ AREA ──▶ (phase) ──▶ TASK
  │
  └─ records attach at any depth they honestly have:
     evidence · defects · checks · notes · materials · hours-allocations
     each carrying inherited context {job, area?, phase?, task?}
```

- **Elasticity (P5):** every level below Job is optional. A structureless job (capture + hours + a punch list) is first-class, not degenerate. The app adapts to the structure that exists; it never demands structure before allowing work.
- **Context inheritance (P2/P13):** records inherit context from where they are created. Many doors into the same record (global capture, area view, task row, day surface) — one record, never duplicated storage.
- **Phase awareness comes from memory and evidence, not administration:** the app remembers each worker's last phase per area and defaults from where recent completions cluster. There is **no office-maintained "current stage" field** — a confidently stale default is worse than one honest tap (ratification, decision B as repaired).

## 3 · The mental model (context-dependent by design)

Worker cognition varies along four axes, and Phil adapts rather than flattening them:

| Axis | Poles | Architectural consequence |
|---|---|---|
| Job scale | pub rewire ↔ hospital tower | elastic hierarchy (§2) |
| Phase | rough-in ↔ finals/defects | batching mode flips: runs ↔ room-completion ↔ list-chasing; **no single lens is enshrined** — the run lens remains a field-gated *view* hypothesis |
| Role | apprentice ↔ tradesman ↔ leading hand | instruction-first ↔ place+kind ↔ coverage+crew: same model, three lenses |
| Structure quality | fully compiled ↔ "just rewire it mate" | the app works with whatever exists |

**Invariant across all cells** (and therefore constitutional): work has a place · the instruction outranks computed ordering (P3) · records happen at the moment of work or not at all (P13) · memory works by exception — completion + blockers (P14) · interruption is the environment (P8) · hours are the receipt of the day, never its identity.

## 4 · Navigation philosophy

- **The root of the app is a question, not a screen: "what now?"** (P4). Which surface answers it — a day view, the job itself for single-job crews, a card — is a design decision that may evolve; the question may not. The answer is offered as memory, never as command; a known human instruction *is* the answer.
- **Critical state is never hidden behind navigation** (P9). This criterion — not any mechanism — governs the tabs-vs-scroll question; [#133](https://github.com/oskar-ott/BuhlOS/issues/133) is an experiment judged by it in the field.
- **Progressive disclosure with a fixed cognitive budget** (P10): Level 1 of any surface carries at most one decision; Level 2 carries the work; Level 3 is the single reference group. New capability enters existing slots — the ranked next action, context on a record, or the reference group — never a new top-level section. Adding requires removing. Enforced by tests on the section *count*, not on a frozen shape.
- **Interruption recovery costs at most one gesture** (P8): place + next survive navigation, backgrounding and relaunch.

## 5 · Provisional tier (per the Constitution's commencement clause)

The behavioural claims inside P4 (the what-now framing), P13, P14, and the concepts list hold **provisional** status until the field session ([#132](https://github.com/oskar-ott/BuhlOS/issues/132), instrument: `docs/phil-field-validation-kit.md`) has had the chance to disprove them. The run lens and the answer-surface decision are explicitly field-gated. Everything else in this document is in force.

---
*Historical record: `docs/phil-ux-master-audit.md` (evidence) · `docs/phil-ux-architecture-v2.md` (superseded in part) · `docs/phil-constitution-ratification.md` (the amendments and their reasons).*
