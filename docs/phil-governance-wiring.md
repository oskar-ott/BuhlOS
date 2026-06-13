# Phil Governance Wiring — institutionalisation report

**Role:** repository maintainer. **Date:** 2026-06-12. **Scope:** make the constitutional package actually govern. No philosophy, no redesign, no architecture. This document *recommends and prepares*; it executes nothing. Everything here is applied by the human-owned **ratification PR** (Step 2), not by an agent.

---

## 1 · Package status (verified)

| Document | Present | State |
|---|---|---|
| `phil-constitution.md` | ✅ | Law, board-amended, package header links siblings |
| `phil-architecture.md` | ✅ | Structure (amended conclusions; governs over the charter) |
| `phil-governance.md` | ✅ | Lifecycle + amendment + authority |
| `phil-field-validation.md` | ✅ | Evidence hierarchy; AI authority ends here |
| `phil-field-validation-kit.md` | ✅ | Runnable instrument (human-run) |
| `phil-implementation-roadmap.md` | ✅ | 5-phase execution |
| `phil-constitution-ratification.md` | ✅ | Marked "analysis only"; the amendment record |
| `phil-ux-architecture-v2.md` | ✅ | **HISTORICAL banner present** — "superseded in part" |
| `phil-ux-master-audit.md` | ✅ | **HISTORICAL/EVIDENCE banner present** |

**Cross-reference integrity:** clean. All package sibling links resolve; both superseded documents carry unmistakable historical banners pointing to their successors; the ratification analysis cannot be mistaken for current policy. **No inconsistencies found. No rewrites required.**

**One integrity risk, not a content defect:** the entire package is **untracked** (`git status` = `??`) on a local `main` that is **18 commits behind origin** (`e65cdbd` vs local `89cab59`) and **0 ahead**. Until committed, the supreme law governs nothing and is one `git clean` from gone. This is gap **G1** below and dictates Step 2.

---

## 2 · The ratification event (prepared — DO NOT auto-run)

Because every change in this repo's history is a squashed PR `(#NNN)` onto `main`, and because local `main` is 18 behind origin, **the ratification must be a PR branched off current `origin/main` — not a commit on local `main`.** Committing on the stale base would be unmergeable and would violate the repo's own main-only-via-PR norm.

**Prepared procedure** (run by the product owner; untracked package files travel into the new branch on checkout):

```bash
# 1. Branch from CURRENT origin, carrying the untracked package docs across
git fetch origin
git checkout -b governance/ratify-constitution-v1 origin/main

# 2. Stage ONLY the package — explicit paths (bad-pathspec/“verify committed tree” discipline;
#    do NOT git add -A — .design-cache/, .mcp.json, .claude/launch.json, supabase doc must NOT ride along)
git add docs/phil-constitution.md docs/phil-architecture.md docs/phil-governance.md \
        docs/phil-field-validation.md docs/phil-field-validation-kit.md \
        docs/phil-implementation-roadmap.md docs/phil-constitution-ratification.md \
        docs/phil-ux-architecture-v2.md docs/phil-ux-master-audit.md \
        docs/phil-governance-wiring.md
#    + the wiring artifacts from §3–§5 once dropped in (CLAUDE.md, the two templates, config.yml)

# 3. Verify the staged tree is exactly the package + wiring, nothing else
git status --short && git diff --cached --stat

# 4. Commit (message below), open the PR, let CI run, merge via squash like any change
```

**Commit title:** `feat(governance): ratify Phil Constitution v1.0`
**Commit body:**
```
Ratify the Phil constitutional package as the governing framework for the field app.

- ratify Constitution (supreme law, 15 principles, board-amended)
- ratify Architecture (stable concepts, elastic hierarchy, navigation philosophy)
- ratify Governance (lifecycle chain, amendment + authority rules)
- ratify Field Validation framework (evidence hierarchy; reality outranks reasoning)
- ratify Implementation Roadmap (5 phases)
- freeze historical audit + charter docs (banners in place)
- wire repository entry points (CLAUDE.md, issue/PR templates) to the package
- establish the constitutional development lifecycle

Behavioural tier (P4 framing, P13, P14, concepts) commences provisionally;
field session #132 ratifies it. See docs/phil-governance.md §2.

Closes nothing — this is the framework future issues derive from.
```

**Tag (after merge, on the squashed merge commit):**
```bash
git tag -a phil-constitution-v1.0-pre-field -m "Phil Constitution v1.0 — ratified, pre-field-validation"
git push origin phil-constitution-v1.0-pre-field
```
The `-pre-field` suffix is deliberate: it records that the behavioural tier is provisional. The post-field tag (`phil-constitution-v1.0`) is cut after Phase 4 freezes it.

> **Not done automatically, by design.** A maintainer prepares the ratification; the keeper ratifies. The branch, the commit and the tag are the product owner's act.

---

## 3 · Repository wiring — exact recommendations (no duplication; link, don't copy)

Every place a human or agent starts work, ranked by how many contributors pass through it:

| Entry point | Today | Recommendation |
|---|---|---|
| **Repo-root agent loader** | **MISSING** | **Add `CLAUDE.md`** (draft in §3a). Highest leverage: it's what Claude Code, cloud review, and any agent auto-load; right now there is no repo-shared agent law (only per-user `MEMORY.md`). |
| `.github/ISSUE_TEMPLATE/feature.yml` | nine-section, no constitution | Add a **Constitutional alignment** block (§4) |
| `.github/pull_request_template.md` | BuhlOS/Phil checks, no constitution | Add a **Constitutional compliance** block (§5) |
| `.github/ISSUE_TEMPLATE/config.yml` | links `docs/issues.md` | Add a second contact link to the Constitution (§3b) |
| `README.md` | project intro | One line under a "Governance" heading linking the package (§3c) |
| Wiki `Agent-Playbook` (separate repo) | agent rules, links in-repo docs | Add the package to "Read first, every session" (§3d) |
| Wiki `Issue-Conventions` / `Home` | conventions | Cross-link the Constitution as the layer above conventions (§3d) |
| `docs/issues.md` | nine-section conventions | One pointer line: Phil-surface issues also cite principles (§3e) |

### 3a · Proposed `CLAUDE.md` (repo root) — ready to apply
```markdown
# BuhlOS / Phil — contributor & agent entry point

Two surfaces, one product: **BuhlOS** (office/admin desktop) and **Phil** (field
mobile). Start here, then load the deeper docs you need.

## Phil is governed by a constitution — load it before Phil work
Any change a field worker can see or feel derives from the package, in this order
of authority:
1. [docs/phil-constitution.md](docs/phil-constitution.md) — supreme law (15 principles)
2. [docs/phil-governance.md](docs/phil-governance.md) — how change flows; amendment rules
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

## Backlog & process
- Issue conventions: [docs/issues.md](docs/issues.md) (nine sections, epics, labels)
- Backlog index: north-star epic #120; Phil epic #121
- Deploys are `main`-only via squashed PR; preview-verify field-facing changes
  (`next dev` can't run `api/*.js`).

## The rest of the system
- Wiki (operating manual): https://github.com/oskar-ott/BuhlOS/wiki
- Deep docs: [docs/](docs/) · rebuild history: [docs/rebuild-audit/](docs/rebuild-audit/)
```

### 3b · `config.yml` additional contact link
```yaml
  - name: Phil Constitution (field-app governance)
    url: https://github.com/oskar-ott/BuhlOS/blob/main/docs/phil-constitution.md
    about: The supreme law for Phil. Field-surface issues must align with it.
```

### 3c · `README.md` — one section (place near the top)
```markdown
## Governance
Phil (the field app) is governed by a ratified constitution. All field-surface
work derives from [the constitutional package](docs/phil-constitution.md)
(law → governance → architecture → field validation → roadmap).
```

### 3d · Wiki (separate repo `BuhlOS.wiki`) — additions, not new pages
- `Agent-Playbook.md` "Read first, every session": add a line —
  *"For any Phil-surface task, load the constitutional package ([docs/phil-constitution.md](https://github.com/oskar-ott/BuhlOS/blob/main/docs/phil-constitution.md) → governance → architecture). Do not reopen settled philosophy."*
- `Issue-Conventions.md` and `Home.md`: one cross-link each placing the Constitution as the authority above the conventions. (Wiki edits ride the wiki repo, not the ratification PR — note in the PR description so they aren't forgotten.)

### 3e · `docs/issues.md` — one pointer line (in "Standing product rules")
*"Phil-surface issues additionally cite the constitutional principle(s) they serve and name the UI slot they enter or remove — see `docs/phil-governance.md` §4."*

---

## 4 · Issue template governance (additive block for `feature.yml`)

Insert **above** the existing `Problem` field (keeps all nine sections intact; adds the constitutional gate first):

```yaml
  - type: textarea
    id: constitutional_alignment
    attributes:
      label: Constitutional alignment
      description: "Required for Phil-surface issues. See docs/phil-governance.md §4. Non-Phil issues may write 'n/a'."
      value: |
        **Principles served:** P… , P…
        **Worker outcome:** the field result, in site language.
        **Cognitive / navigation impact:** what Level it touches; does it ADD a top-level surface? (P10 — if yes, what is REMOVED?)
        **Why existing principles don't already cover this:** (if they do, this may be a design decision, not a new issue.)
    validations:
      required: true
```

Rationale: the block forces the §4 checks (principle citation · budget check · no-theatre) at creation, where they're cheapest. "n/a" for non-Phil keeps it non-bureaucratic for BuhlOS-only work.

---

## 5 · PR template governance (additive block for `pull_request_template.md`)

Append after `## Summary`:

```markdown
## Constitutional compliance (Phil surfaces)

- [ ] Principles addressed: P… (or n/a — not a field surface)
- [ ] Architecture touched? (concepts/hierarchy/navigation) — link `docs/phil-architecture.md` section, or "no"
- [ ] Cognitive budget (P10): top-level section count unchanged — or one added / one removed
- [ ] No new permanent top-level navigation introduced without removal
- [ ] Field validation: required for L1-surface changes (the what-now answer / job hero) — done / not applicable
- [ ] Constitution conflict? If yes — **STOP**, amend the Constitution first (governance §3). Do not ship the conflict.
```

---

## 6 · Enforcement — consistency without bureaucracy

Governance today relies on humans (and agents) *remembering*. Three lightweight mechanisms move it from memory to mechanism, in increasing effort:

1. **Templates as the default path (zero CI):** §4/§5 blocks mean the questions are asked every time without anyone enforcing. This alone covers ~80%.
2. **Two CI guards, already chartered (roadmap Phase 2 / governance §5):**
   - **Budget gate** — a render test asserting the Phil job-page top-level section count ≤ N; a PR raising it fails unless it removes one. Mechanises P10. Pattern already exists in the repo (`check:shell-contract`, `check:role-literals`).
   - **Floor gate** — a grep-style test banning sub-12px/≤44px classes in `src/components/phil/**` (lands with issue #423). Mechanises P8's numbers.
   Add both to `npm run check` and the predeploy chain so they run like every other guard.
3. **A one-line CI reminder (cheapest signal):** a PR-comment workflow that, when files under `src/**/phil/**` or `src/app/phil/**` change, posts *"Phil surface touched — confirm the constitutional checklist (docs/phil-governance.md §5)."* No blocking, just a nudge.

No approvals boards, no sign-off matrices, no new roles. The templates do the work; the two guards catch the two things humans reliably forget (section creep, type drift).

---

## 7 · Lifecycle consistency (no bypass paths)

The chain is expressed identically in `phil-governance.md §1`, the roadmap, and the field-validation doc:

```
Constitution → Governance → Architecture → Epic → Issue → PR
  → Implementation → Field Validation → Amendment (evidence only) ↺
```

**Bypass audit:**
- *Issue without an epic?* — `config.yml` allows blank issues (`blank_issues_enabled: true`). That's a bypass of the Issue layer. **Recommendation:** keep blank issues enabled (low friction for bugs) but the §4 block lives only in `feature.yml`; bug template stays lean. Acceptable — bugs aren't philosophy.
- *PR without an issue?* — possible today. The PR template's constitutional block catches field-surface PRs regardless. Acceptable.
- *Direct push to `main`?* — the repo norm is PR-only; recommend a branch-protection rule on `main` (require PR + CI) if not already set, so the lifecycle's PR layer can't be skipped. **This is the only true bypass and is one GitHub setting.**
- *Amendment without evidence?* — governance §3 + field-validation evidence hierarchy block this in writing; the templates route conflicts to amendment-first. No mechanical gap.

---

## 8 · Backlog migration strategy (no issues touched)

This is **not new work** — it is exactly roadmap **Phase 2** and ratification-analysis **§6**, restated as a migration:

```
Current Phil backlog (#421–#427, #132–#149, #368, bible-adjacents)
        ↓  constitution review (already done — ratification §6)
   KEEP: #421 #423 #424 #425 #426 #427 #138 #139 #143 #135 #147 #148 #149 #368 #132
 REWRITE: #422 (→ "what now?") · #145 (→ today-relevance)
   MERGE: #136 → into #422
   BLOCK: #133 (P9-criterion experiment) · #144 (until spine lands)
   CLOSE: #146 (P12 — hidden-only gestures)
   +FILE: Epic 19 (re-parent the above) · P10 budget-guard issue · run-lens (conditional on field demand)
        ↓
Constitution-aligned backlog, every issue citing its principle
```

**Execution rule:** runs as a single pass *after* the ratification PR merges (so the principles are committed law to cite), gated on the product owner's "go". It is the content of Epic 19. **Nothing executes from this document.**

---

## 9 · Governance gaps, ranked by risk

| # | Gap | Risk | Why it matters at 5yr/2000-issue scale | Close by |
|---|---|---|---|---|
| **G1** | **Package uncommitted, on `main` 18 behind origin** | 🔴 Critical | The supreme law governs nothing and can vanish; can't be cited by issues/PRs until it exists at a stable ref | The ratification PR (§2) — do this first |
| **G2** | **No `CLAUDE.md` / repo agent loader** | 🔴 Critical | Most future issues/PRs will be agent-authored; an agent that never loads the law can't obey it. Per-user `MEMORY.md` ≠ repo-shared | §3a (in the ratification PR) |
| **G3** | **Templates carry no constitutional hook** | 🟠 High | Without the prompt at creation, alignment depends on memory; drift is silent and compounds | §4/§5 (in the ratification PR) |
| **G4** | **Enforcement is human-only** (budget/floor gates unbuilt) | 🟠 High | P10/P8 are the two principles that erode invisibly (section creep already observed twice in a week) | Roadmap Phase 2 CI guards (§6) |
| **G5** | **`main` not provably branch-protected** | 🟡 Medium | A direct push bypasses the entire lifecycle's PR layer | One GitHub setting (§7) |
| **G6** | **Single ratification/amendment keeper** | 🟡 Medium | Correct at 8 staff; a bus-factor and a bottleneck at 800. Succession rule exists in governance §6 but is dormant | Activate the ≤3 product council when staff > ~30 (governance §6) |
| **G7** | **Wiki lives in a separate repo** | 🟡 Medium | Agent-Playbook can drift from the in-repo package; two sources of "read first" | §3d cross-links + a periodic wiki-touch (already a proposed wiki issue) |
| **G8** | **No historical versioning of the law** | 🟢 Low | "What did the Constitution say in 2027?" needs answering for amendment audits | The `-pre-field` / `v1.0` tags (§2) + amendments recorded in-document; sufficient at this scale |
| **G9** | **Provisional tier has no hard expiry enforcement** | 🟢 Low | The 30-day clock (governance §2) is written, not alarmed | A calendar reminder; not worth automation |

G1–G3 all close in the **single ratification PR**. G4 is the next epic's CI work. G5 is one setting. The rest are scale-triggered and already have written answers.

---

## 10 · Final report

**1. Constitutional package status:** Complete and internally consistent. 6 package docs + ratification analysis + 2 banner-marked historical docs. Cross-references clean. No content defect. **Uncommitted** (G1).

**2. Repository governance readiness: 38 / 100.**
| Dimension | Score | Note |
|---|---|---|
| Package completeness & integrity | 18/20 | −2: uncommitted/unstable ref |
| Discoverability & entry-point wiring | 3/25 | No CLAUDE.md, templates unwired, separate wiki |
| Enforcement automation | 4/20 | All human-memory; guards chartered not built |
| Lifecycle & amendment definition | 11/15 | Well-defined in writing; not yet active |
| Authority & succession | 6/10 | Keeper named; succession dormant |
| Ratification readiness | 6/10 | Procedure clear; blocked by divergence until PR |
The package is excellent; the *repository* barely governs yet, because law that is uncommitted and unwired is law in name only. **Projected after the ratification PR + CLAUDE.md + templates: ~82/100**, residual gap = automated enforcement (G4) and single-keeper (G6).

**3. Remaining governance gaps:** G1–G9 above; G1–G3 are the blockers, all closed by one PR.

**4. Ratification checklist:**
- [ ] Branch `governance/ratify-constitution-v1` off `origin/main` (§2)
- [ ] Stage the package **explicitly** + the wiring artifacts (CLAUDE.md, template edits, config.yml link)
- [ ] Verify staged tree = package + wiring only (no `.design-cache`, `.mcp.json`, supabase doc)
- [ ] Commit with the §2 message; open PR; CI green; squash-merge
- [ ] Tag `phil-constitution-v1.0-pre-field` on the merge commit
- [ ] Apply wiki cross-links (separate repo; note in PR)
- [ ] Confirm `main` branch protection (require PR + CI) — G5

**5. Wiring checklist:** CLAUDE.md (§3a) · feature.yml block (§4) · PR template block (§5) · config.yml link (§3b) · README section (§3c) · wiki Agent-Playbook/Issue-Conventions lines (§3d) · docs/issues.md pointer (§3e). All additive; none duplicate content; all link to the package.

**6. Ready to begin constitutional implementation?**
**Not yet — by one PR.** The framework is sound and the procedure is prepared, but a constitution that is uncommitted (G1) and unloadable by agents (G2) cannot govern the work that follows. **Merge the ratification PR (which closes G1–G3 together), set branch protection (G5), and the repository is ready** for Phase 1 of the roadmap and the Phase-2 backlog migration. The two enforcement guards (G4) ride Phase 2; they harden governance but do not block its start.

The institutionalisation is prepared, not performed. Ratification is the keeper's act.
