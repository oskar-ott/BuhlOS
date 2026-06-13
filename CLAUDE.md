# BuhlOS / Phil — contributor & agent entry point

Two surfaces, one product: **BuhlOS** (office/admin desktop) and **Phil** (field
mobile). Start here, then load the deeper docs you need.

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

## Backlog & process
- Issue conventions: [docs/issues.md](docs/issues.md) (nine sections, epics, labels)
- Backlog index: north-star epic #120; Phil epic #121
- Deploys are `main`-only via squashed PR; preview-verify field-facing changes
  (`next dev` can't run `api/*.js`).

## The rest of the system
- Wiki (operating manual): https://github.com/oskar-ott/BuhlOS/wiki
- Deep docs: [docs/](docs/) · rebuild history: [docs/rebuild-audit/](docs/rebuild-audit/)
