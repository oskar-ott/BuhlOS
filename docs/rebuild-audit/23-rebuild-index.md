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

## Phase D — planning + QA

| # | Doc | Purpose | Who should read | When |
| --- | --- | --- | --- | --- |
| 24 | [24-phase-d-jobs-evidence-plan.md](24-phase-d-jobs-evidence-plan.md) | Phase D scope, data model, routes, risks, acceptance criteria. §15.0 has 7 RESOLVED decisions; §15.1 has 2 open founder calls. | Phase D planning + future Phase D build sessions. | After Phase C ships; before the Phase D build session opens. |
| 25 | [25-phase-d-build-prompts.md](25-phase-d-build-prompts.md) | Paste-ready build prompts for D1, D2, D3, D4, D5, D6 — original phasing. **Note:** the D2/D3/D4 build prompts for the evidence loop are superseded by docs 28-30 per the [doc 28 §0 phasing reconciliation](28-d2-d3-d4-evidence-qa-checklist.md). D1, D5, D6 prompts remain authoritative. | Each Phase D build session that doesn't have a newer spec. | When opening each Dx build session. |
| 26 | [26-phase-d-testing-checklist.md](26-phase-d-testing-checklist.md) | Per-slice unit / integration / Playwright checklists, field test script, exit gates, regression matrix. Includes §A.1 grep test for the Next.js 15.5 RSC manifest pattern. Doc 28 supersedes §B.2 + §B.3 for the evidence loop; other sections still authoritative. | Build sessions + Oskar (preview verification) + on-call post-cutover. | Throughout Phase D execution. |
| 27 | [27-interface-usability-pass.md](27-interface-usability-pass.md) | Cross-cutting UX brief (Phil simplicity + BuhlOS clarity + 5-tone palette + 20-entry marker dictionary + screen-by-screen critique + ready-to-paste UI hardening prompt). Upstream of every Dx build prompt. | **Every Dx build session** (preflight). Oskar (review §3 principles + §6.2 dictionary + §19.1 open questions). | Before D1 starts. Re-read at each Dx start. |
| 28 | [28-d2-d3-d4-evidence-qa-checklist.md](28-d2-d3-d4-evidence-qa-checklist.md) | QA gate for the evidence loop. §A covers D2 (evidence domain + persistence API), §B covers D3 (Phil capture UI), §C covers D4 (admin review). §D regression matrix and §E production smoke on every Dx merge. **§0 reconciles this session's phasing with doc 25's** — the evidence loop's D2/D3/D4 names follow this session, not doc 25. Docs-only. | Every D2/D3/D4 build session pastes the relevant §. Reviewers gate on it. | When opening each evidence-loop slice. |
| 29 | [29-phase-d3-phil-capture-spec.md](29-phase-d3-phil-capture-spec.md) | D3 spec: Phil capture UI (sheet + Today's captures strip), file plan in `src/components/phil/`, state machine, validation, marker dictionary, acceptance criteria, paste-ready build prompt for Session 6. Docs-only. | Session 6 (D3 build) — paste the §13 build prompt. | After D2 ships and Phil capture is the next slice. |
| 30 | [30-phase-d4-admin-evidence-review-spec.md](30-phase-d4-admin-evidence-review-spec.md) | D4 spec: admin evidence review surface (queue + drawer + reject modal), mounted at `/v2/jobs/[jobId]/evidence` (no `/admin/jobs` cutover bundled), file plan in `src/components/admin/`, state machine, acceptance criteria, paste-ready build prompt for Session 7. Docs-only. | Session 7 (D4 build) — paste the §13 build prompt. | After D3 ships. |
| 31 | [31-interface-usability-post-d1-addendum.md](31-interface-usability-post-d1-addendum.md) | Post-D1 observations: real `/api/jobs` shape, doc 27 §15 quick-win status, existing RSC client-manifest debt, screen-critique updates from authed smoke, small polish-PR candidates, anti-patterns to actively avoid in D2/D3/D4, field test additions, new open questions. Delta to doc 27 — doc 27 remains binding. Docs-only. | Every D2/D3/D4 build session (alongside doc 27). Oskar (§5 polish list + §8 open questions). | Before D2/D3/D4 build sessions; reviewed at D6 polish. |

## Phase E — planning

| # | Doc | Purpose | Who should read | When |
| --- | --- | --- | --- | --- |
| 32 | [32-phase-e-plan.md](32-phase-e-plan.md) | Canonical Phase E plan. Umbrella scope (ITP / RFI / Materials), E1 recommended scope (ITP field-record + admin sign-off loop), data model, routes, audit, permissions, risks, decisions §15.1 (8 founder calls with recommended defaults). E2/E3/E4 explicitly deferred to their own plans. Supersedes the parallel proposal in PR #27. Docs-only. | Phase E planning approval (Oskar). Future E1 build sessions. | After D.5 hardening ships (PR #26 merged); before any E1 build prompt is run. |
| 33 | [33-phase-e-build-prompts.md](33-phase-e-build-prompts.md) | Paste-ready build prompts for E1a (domain + API extension), E1b (Phil ITP recording UI), E1c (admin ITP queue + sign-off). Common preamble shared across slices. E2/E3/E4 prompts not in this doc — added when those plans are written. | Each E1 build session pastes the relevant slice prompt. | When opening each E1x build session. |
| 34 | [34-phase-e-testing-checklist.md](34-phase-e-testing-checklist.md) | Per-slice QA gates for E1 (§A E1a, §B E1b, §C E1c), regression matrix (§D), production smoke after merge (§E), hard exit gates (§F), explicit not-in-scope list (§G). Mirrors doc 28 structure. | Every E1 build session pastes the relevant §. Reviewers gate on it. | Throughout E1 execution. |

## Audit — current state

| # | Doc | Purpose | Who should read | When |
| --- | --- | --- | --- | --- |
| 35 | [35-current-product-state-audit.md](35-current-product-state-audit.md) | Snapshot audit dated 2026-05-26 (post PR #34 E1a + PR #35 UI bible vNext). Built feature matrix, route map, domain state, UX findings, test coverage, prioritised P0/P1/P2/P3 gaps, next-5 PR plan, E1b readiness verdict, paste-ready prompt for the E1a runbook session. Docs-only. | Anyone opening a new session, reviewer, or PM wanting current ground truth. | Before scoping any new work or deciding what to merge next. |
| 36 | [36-documents-specs-readiness-note.md](36-documents-specs-readiness-note.md) | Post-E1 hardening readiness note for the Documents / Specs section. Where the data lives (`jobs/<id>/plans-index.json`), permissions audit, what the next slice should and should NOT do, file plan sketch. Docs-only. | Author of the next slice (Documents read-only viewer). | Before opening the Documents PR. |

## Phase E2 — shipped slice

| Slice | Scope | Status | PR | Merge commit |
| --- | --- | --- | --- | --- |
| E2 | Documents / Specs read-only viewer — Phil panel + admin queue at `/v2/jobs/[jobId]/documents` + `statsDocumentsCurrent` enrichment, no uploads / no AI takeoff / no markup | ⏳ pending merge | — | — |

**Phase E2 status:** read-only viewer landing on existing `/api/plans` data. See [phase-e2-documents-runbook.md](phase-e2-documents-runbook.md) for architecture, permissions, field test, and rollback.

## Phase C — runbook

| Doc | Purpose |
| --- | --- |
| [phase-c-rollout-runbook.md](phase-c-rollout-runbook.md) | Phase C rollout + on-call notes (added with PR #9). |

## Phase D — shipped slices

> Phasing reconciliation: the original [doc 25](25-phase-d-build-prompts.md) split
> D2/D3/D4/D5/D6 as evidence-API / Phil-capture / admin-Jobs-cutover /
> activity-cutover / exit-polish. The implemented sequence per [doc 28](28-d2-d3-d4-evidence-qa-checklist.md)
> §0 names the evidence loop's slices differently — see the table below
> for the actual ship history.

| Slice | Scope | Status | PR | Merge commit |
| --- | --- | --- | --- | --- |
| D1 | Phil jobs read-only foundation | ✅ shipped 2026-05-24 | [#11](https://github.com/oskar-ott/BuhlOS/pull/11) | `71a91fc` |
| D2 | Evidence domain + API foundation | ✅ shipped 2026-05-25 | [#13](https://github.com/oskar-ott/BuhlOS/pull/13) | `f2d65f6` |
| D3 | Phil evidence capture UI | ✅ shipped 2026-05-25 | [#14](https://github.com/oskar-ott/BuhlOS/pull/14) | `32cc15c` |
| D4 | Admin evidence review UI (`/v2/jobs/[jobId]/evidence`) | ✅ shipped 2026-05-25 | [#15](https://github.com/oskar-ott/BuhlOS/pull/15) | `4be5f98` |
| D5 | Evidence hardening (audit-log read + un-review + smoke) | ✅ shipped 2026-05-25 | [#16](https://github.com/oskar-ott/BuhlOS/pull/16) | `6a24eb0` |
| D5-fix | Evidence drawer history retry (catches just-written audit row) | ✅ shipped 2026-05-25 | [#17](https://github.com/oskar-ott/BuhlOS/pull/17) | `952ee49` |
| D.5 | Snags / defects loop (worker reports → admin transitions → status flows back) | ✅ shipped 2026-05-25 | [#18](https://github.com/oskar-ott/BuhlOS/pull/18) | `8f4cbe1` |
| D.5-fix-1 | Snag drawer history retry (verbatim port of #17 to `SnagDrawer`) | ✅ shipped 2026-05-25 (Session 7) | [#19](https://github.com/oskar-ott/BuhlOS/pull/19) | `7d13599` |
| D.5-fix-2 | Phil sees rejection reasons + tap-target hardening | ✅ shipped 2026-05-25 | [#20](https://github.com/oskar-ott/BuhlOS/pull/20) | `12572ef` |
| D6 | Admin jobs index (`/v2/jobs`) — discoverability for D4 + D.5 | ✅ shipped 2026-05-25 (Session 7) | [#21](https://github.com/oskar-ott/BuhlOS/pull/21) | `d4ced43` |

**Phase D status:** the operational loops Phase D set out to deliver are all live in production. Admin discoverability through the rebuild sidebar (D6) closes the last rollout gap. Remaining Phase D-adjacent work (cross-job snag triage queue, `/activity` feed, `/admin/jobs` cutover, full role-string normalisation in `api/_lib/auth.js#canWrite`) is documented in the individual runbooks under "Open questions / future work".

## Phase E — shipped slices

| Slice | Scope | Status | PR | Merge commit |
| --- | --- | --- | --- | --- |
| E1a | ITP domain + API extension (`src/domains/itp/*`, audit-log schema, `api/job-itps.js` V2 audit + PR #26 stale-read + independence rule + role-tier alignment, `api/jobs.js` statsItpsActive) | ✅ shipped 2026-05-25 | [#34](https://github.com/oskar-ott/BuhlOS/pull/34) | `996d848` |
| E1b | Phil ITP recording UI (`/phil/jobs/[jobId]/itps/[instanceId]` + section on job detail) | ✅ shipped 2026-05-26 | [#38](https://github.com/oskar-ott/BuhlOS/pull/38) | `f3146e2` |
| E1c | Admin ITP queue + sign-off + jobs-index ITP chip (`/v2/jobs/[jobId]/itps`) | ✅ shipped 2026-05-27 | [#39](https://github.com/oskar-ott/BuhlOS/pull/39) | `7629661` |

**Phase E status:** E1 is live end-to-end in production. Post-merge production smoke (27/27 routes + APIs) passed on 2026-05-27. Operational loop is: admin attaches → field records → admin signs off (with independence + override rule). See [phase-e1-itp-runbook.md](phase-e1-itp-runbook.md) for the architecture, audit dual-write, permissions matrix, field test script, rollback considerations, and the next-recommended-PR list.

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
