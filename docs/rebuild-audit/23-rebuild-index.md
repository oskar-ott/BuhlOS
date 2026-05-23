# 23 · Rebuild audit index

> Table of contents for the full rebuild audit pack. Coding agents and human reviewers should consult this index before starting any phase.

---

## Phase 1 — Initial audit (committed `f7b748d`)

| # | Doc | Purpose | Who should read | When |
| --- | --- | --- | --- | --- |
| 00 | [00-executive-summary.md](00-executive-summary.md) | TL;DR + recommended strategy + risk + keep/rebuild/discard. | Everyone. | Always read first. |
| 01 | [01-current-route-map.md](01-current-route-map.md) | Every `vercel.json` rewrite + legacy URL surface. | Coding agents during cutover; reviewers. | When planning a route change. |
| 02 | [02-current-feature-inventory.md](02-current-feature-inventory.md) | Every legacy feature with status + ownership. | Reviewers; new joiners. | When checking "what does the legacy system already do?". |
| 03 | [03-data-model-audit.md](03-data-model-audit.md) | Field-by-field audit of legacy data shapes. | Domain authors. | Phase B+ when wiring real data. |
| 04 | [04-ui-ux-audit.md](04-ui-ux-audit.md) | Legacy UI failures + the rebuild's UX north star. | UI work. | Before any UI session. |
| 05 | [05-auth-and-permissions-audit.md](05-auth-and-permissions-audit.md) | Auth + role taxonomy + permission gaps. | Auth work. | Phase A + B (login + first gated mutations). |
| 06 | [06-deployment-audit.md](06-deployment-audit.md) | Deploy failure modes + the new deploy policy. | Everyone. | Before merging anything to `main`. |
| 07 | [07-salvage-map.md](07-salvage-map.md) | What survives the rebuild (table by file). | Domain authors. | Phase B+. |
| 08 | [08-next-claude-code-prompt.md](08-next-claude-code-prompt.md) | The exact Phase A prompt. | Phase A session. | When starting Phase A. |
| 09 | [09-command-results.md](09-command-results.md) | Phase 1 session record. | Reviewers. | Historical reference. |

## Phase 1B — Deep audit (this batch)

| # | Doc | Purpose | Who should read | When |
| --- | --- | --- | --- | --- |
| 10 | [10-product-definition.md](10-product-definition.md) | What BuhlOS / Phil actually are. Bans the "generic SaaS dashboard" framing. | **Everyone, always.** Especially coding agents. | First, before any code thinking. |
| 11 | [11-operational-workflow-map.md](11-operational-workflow-map.md) | 28 workflows the system must support with phase assignments. | Domain authors. PMs. | When picking up a new phase or feature. |
| 12 | [12-domain-model-deep-dive.md](12-domain-model-deep-dive.md) | Entity-by-entity schema with universal fields and per-phase minimum models. | Domain authors. | Phase B+ when writing `src/domains/<x>/schema.ts`. |
| 13 | [13-ui-information-architecture.md](13-ui-information-architecture.md) | Sidebar / tab bar / per-section contracts for Admin + Phil. | UI work. | Before any new screen. |
| 14 | [14-technical-architecture-deep-dive.md](14-technical-architecture-deep-dive.md) | Current diagnosis + target architecture + binding code rules. | Everyone. | Before writing any code in `src/`. |
| 15 | [15-risk-register.md](15-risk-register.md) | 25 categorised risks with mitigations + phase ownership. | Risk reviewers. PRs touching deploy or routing. | When evaluating a change's blast radius. |
| 16 | [16-migration-strategy.md](16-migration-strategy.md) | Phase map + per-cutover preconditions / rollback. | Anyone planning a cutover. | Phase C+ when flipping rewrites. |
| 17 | [17-testing-and-quality-plan.md](17-testing-and-quality-plan.md) | Test stack + per-phase acceptance criteria + CI gates. | Test authors. CI maintainers. | Phase A baseline + each phase. |
| 18 | [18-phase-a-implementation-brief.md](18-phase-a-implementation-brief.md) | Exact brief for Phase A (foundation only). | Phase A session. | When starting Phase A. |
| 19 | [19-phase-b-hours-implementation-brief.md](19-phase-b-hours-implementation-brief.md) | Exact brief for Phase B (hours loop). | Phase B session. | When starting Phase B. |
| 20 | [20-agent-rules.md](20-agent-rules.md) | Mandatory rules for every coding agent. | **Every coding agent, every session.** | Before doing anything else. |
| 21 | [21-rebuild-decision-record.md](21-rebuild-decision-record.md) | ADR-style record of 20 binding decisions. | Reviewers. Anyone proposing a change to the plan. | When questioning a "why is it like this". |
| 22 | [22-phase-1b-command-results.md](22-phase-1b-command-results.md) | Phase 1B session record. | Reviewers. Historical reference. | Audit trail. |
| 23 | [23-rebuild-index.md](23-rebuild-index.md) | This document. | Everyone. | When unsure where to find something. |

## Phase 1 / 1B supporting docs

| Doc | Purpose |
| --- | --- |
| [../architecture/00-rebuild-non-negotiables.md](../architecture/00-rebuild-non-negotiables.md) | Binding engineering rules (Phase 1A; supplemented by [14] and [20]). |
| [../architecture/01-target-rebuild-structure.md](../architecture/01-target-rebuild-structure.md) | Original folder layout (Phase 1A; refined by [14]). |
| [../product/00-core-operational-loops.md](../product/00-core-operational-loops.md) | Operational loops (Phase 1A; superseded for the rebuild by [11]). |
| [../product/01-mvp-rebuild-scope.md](../product/01-mvp-rebuild-scope.md) | Phase scope (Phase 1A; refined by [16] and [18][19]). |
| [../regressions/admin-operations-blank.md](../regressions/admin-operations-blank.md) | Six production blank-page incidents feeding several risks in [15]. |
| [../deploy-checklist.md](../deploy-checklist.md) | Legacy deploy checklist; carried forward where relevant by [16] + [17]. |

---

## Doc reading order by audience

### Coding agent starting a new phase

1. [20-agent-rules.md](20-agent-rules.md) — posture.
2. [23-rebuild-index.md](23-rebuild-index.md) — this index.
3. [00-executive-summary.md](00-executive-summary.md) — TL;DR.
4. [10-product-definition.md](10-product-definition.md) — what we're building.
5. [14-technical-architecture-deep-dive.md](14-technical-architecture-deep-dive.md) — how we're building it.
6. The current phase brief (18 / 19 / future).
7. The relevant `[14]` route claim list before mounting any new route.

### Reviewer / approver

1. [00-executive-summary.md](00-executive-summary.md)
2. [15-risk-register.md](15-risk-register.md) — risk to evaluate.
3. [16-migration-strategy.md](16-migration-strategy.md) — phase ordering.
4. [17-testing-and-quality-plan.md](17-testing-and-quality-plan.md) — exit criteria.
5. [21-rebuild-decision-record.md](21-rebuild-decision-record.md) — decisions worth challenging.

### Product / PM

1. [10-product-definition.md](10-product-definition.md)
2. [11-operational-workflow-map.md](11-operational-workflow-map.md)
3. [13-ui-information-architecture.md](13-ui-information-architecture.md)

### Domain author writing new schemas

1. [12-domain-model-deep-dive.md](12-domain-model-deep-dive.md)
2. [11-operational-workflow-map.md](11-operational-workflow-map.md) — workflow context for the entity.
3. [03-data-model-audit.md](03-data-model-audit.md) — legacy field-by-field reference.
4. [14-technical-architecture-deep-dive.md](14-technical-architecture-deep-dive.md) §C, E — file layout + code rules.

### Anyone touching deploy / routing

1. [06-deployment-audit.md](06-deployment-audit.md) (Phase 1A).
2. [16-migration-strategy.md](16-migration-strategy.md) — cutover preconditions.
3. [15-risk-register.md](15-risk-register.md) — R-01 through R-06, R-22.

---

## What to do if a doc and the code disagree

1. **Stop.** Surface the discrepancy.
2. **The doc takes precedence** until a new ADR is added superseding the prior decision (per [20-agent-rules.md] #29 and [21-rebuild-decision-record.md] process).
3. **Update the relevant doc** in the same PR as any code change that would otherwise create drift.

---

## Adding new docs

- Numbered above 23 as Phase 1C / 2 / future audits land.
- Every new doc gets an entry in this index + a row in the "Doc reading order" sections.
- Cross-reference to / from existing docs.
