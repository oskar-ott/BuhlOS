# BuhlOS / Phil — contributor & agent entry point

Two surfaces, one product: **BuhlOS** (office/admin desktop) and **Phil** (field
mobile — *internal name only*). **This version presents as one brand: every
user-visible surface says BuhlOS.** "Phil" is reserved as a possible future
field brand; routes (`/phil/*`) and code identifiers keep the internal name
(field URLs are sacred). Brand constant: `src/naming/brand.ts`. Start here,
then load the deeper docs you need.

## Phil is governed by a constitution — load it before Phil work
Any change a field worker can see or feel derives from the package, in this order
of authority:
1. [docs/phil-constitution.md](docs/phil-constitution.md) — supreme law (15 principles)
2. [docs/phil-governance.md](docs/phil-governance.md) — how change flows; amendment rules; the prompt-governance standard (Appendix B)
3. [docs/phil-architecture.md](docs/phil-architecture.md) — stable concepts & navigation philosophy
4. [docs/phil-field-validation.md](docs/phil-field-validation.md) — **field evidence outranks reasoning**
5. [docs/phil-implementation-roadmap.md](docs/phil-implementation-roadmap.md) — what's being built now

**Hard rules for agents:**
- The thinking phase is closed. Do **not** reopen first-principles UX/architecture
  design or invent philosophy. Propose under the principles; amend them only via
  governance §3 with field evidence.
- Every Phil-surface issue cites the principle(s) it serves and names the UI slot
  it enters or removes (cognitive budget, P10).
- No fake UI, no invented numbers (P7). Site language, not enterprise (P11).
- Field evidence > measured fact > domain reasoning > AI argument > elegance.
- Evidence hierarchy & amendment process: `docs/phil-governance.md` §3.

## Task-led job architecture — load it before job/task/proof work (cross-surface)
The data direction for **both** surfaces: a job is the operating context; the
**task instance is the operational spine**. Areas, stages, systems, workers,
dependencies, blockers, proof, QA, materials, RFIs and drawings are **facets of a
task**; every list is a **view — a projection over task instances**.
1. [docs/architecture/task-led-job-architecture.md](docs/architecture/task-led-job-architecture.md) — the principle, the worked example, the bridge, the target
2. [docs/architecture/task-led-jobs-adr.md](docs/architecture/task-led-jobs-adr.md) — the decision record
3. [docs/architecture/proof-review-model.md](docs/architecture/proof-review-model.md) — proof is **area/package-granular** today; admin approval is **not** built
4. Engineering rules: [docs/architecture/00-rebuild-non-negotiables.md](docs/architecture/00-rebuild-non-negotiables.md) → "Task-led architecture"

**Hard rules for agents:**
- The `jobId + areaId + stage + taskId` model is a **labelled compatibility bridge**, not the final architecture. `taskInstanceId` is a **target term only — it exists nowhere in the code.** Do not write docs/code that claim it, per-task proof, or admin proof approval as built.
- New task-facet work keys off **canonical task identity** (the canonical task index + `src/domains/jobs/task-ref.ts`), never raw area arrays. **Do not deepen area-owned task arrays** unless the change explicitly labels itself a temporary bridge.
- This is an **architecture** direction, not a Phil-constitution amendment: Phil's place-first navigation is a view and stays. Behavioural change to the ratified Phil package still goes via governance §3 / P15.

## Source of truth & the Constitution Gate
- **Source-of-truth hierarchy** (higher wins on conflict): repo docs (`/docs`, `README.md`, `CLAUDE.md`) → GitHub Wiki (published handbook) → AI memory (working context, may be stale) → prompts (per-task instructions, **not permanent truth**). See [docs/wiki-sync.md](docs/wiki-sync.md).
- **Constitution Gate (architecture-relevant prompts):** before changing an architecture/product principle, identify the governing doc, state the change against it, and update the doc. A prompt may direct work; it does not amend the constitution. Repo-docs PR first, **wiki sync after merge** (the wiki-touch rule).

## Lean-startup loop — how work is selected (load before proposing product work)
The product grows by evidence, not momentum:
[docs/product/03-lean-startup-loop.md](docs/product/03-lean-startup-loop.md)
(builds on the [02-lean-reset.md](docs/product/02-lean-reset.md) scope cut).
- **Pull, not push:** nothing new is built and nothing hidden is un-hidden
  unless a real user asked for it or a proven loop demands it. The hidden
  features are an arsenal, not a roadmap.
- One hypothesis per pay-week cycle (Wed→Tue), smallest testable slice, dark
  behind a flag; reviewed at weekly closeout — persevere / tweak / kill.
- Feature/behaviour PRs name the hypothesis or pull they serve (one line).
- Measurement is observation + conversation at current scale — **do not build
  analytics infrastructure.**

## Backlog & process
- Issue conventions: [docs/issues.md](docs/issues.md) (nine sections, epics, labels)
- Backlog index: north-star epic #120; Phil epic #121
- Deploys are `main`-only via squashed PR; preview-verify field-facing changes
  (`next dev` can't run `api/*.js`).

## The rest of the system
- Wiki (operating manual): https://github.com/oskar-ott/BuhlOS/wiki
- Deep docs: [docs/](docs/) · rebuild history: [docs/rebuild-audit/](docs/rebuild-audit/)
