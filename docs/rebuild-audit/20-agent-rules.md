# 20 · Agent rules

> Mandatory rules for **every coding agent (Claude Code or otherwise)** that opens a session in this repository. Read this first; refuse any prompt that conflicts with it without asking.

---

## Pre-flight (always)

1. **Inspect branch / status first.** Before writing any code, run `git status`, `git branch --show-current`, `git log --oneline -n 10`, `pwd`. Confirm where you are.
2. **Read the audit docs first.** Specifically:
   - [00-executive-summary.md](00-executive-summary.md)
   - [10-product-definition.md](10-product-definition.md)
   - [13-ui-information-architecture.md](13-ui-information-architecture.md)
   - [14-technical-architecture-deep-dive.md](14-technical-architecture-deep-dive.md)
   - [15-risk-register.md](15-risk-register.md)
   - The phase brief for the phase you're in (`18-phase-a-implementation-brief.md`, `19-phase-b-hours-implementation-brief.md`, etc.).
3. **Confirm the phase.** Never build for a phase that hasn't been entered. Phase A before B; B before C; etc.
4. **If the prompt conflicts with the audit, stop and ask.** Do not infer a "best of both"; surface the conflict.

---

## Build posture

5. **Never build before knowing the current phase.** If the prompt doesn't say which phase, ask.
6. **Never overbuild beyond the phase.** Phase A is shells. Phase B is hours. Stop where the brief stops.
7. **Never mix phases in one PR.** A PR that adds the Phase A scaffold *and* Phase B hours is rejected, even if it works.
8. **Default to UNDER CONSTRUCTION when uncertain.** Per [13-ui-information-architecture.md] and [[feedback_hide_unfinished_features]].
9. **No "while I'm here" cleanups.** Out-of-scope tidy-ups (renaming files, removing dead code) become their own PR with their own scope.
10. **No new admin shells / Phil shells / login concepts.** One of each. Lint enforces.

---

## Deploy posture

11. **Never deploy unless explicitly instructed.** `vercel deploy --prod`, `vercel deploy`, `npm run deploy:prod` (removed in Phase A), `npm run deploy:preview` — all of these are off-limits without an explicit user instruction in the current turn.
12. **Never push directly to `main`.** Even with explicit instruction, push goes to a feature branch; PR follows; review follows; merge follows; Vercel auto-deploys.
13. **Never use `vercel deploy --prod` from local or a feature branch.** This is the failure mode that caused two production outages in three days. The `deploy:prod` script has been removed from `package.json`; do not add it back.
14. **Never bypass `GUARD_OVERRIDE`.** The override exists for emergency rollback via `vercel promote`. Coding agents have no reason to set it.
15. **Production rollback uses `vercel promote <previous-deploy>` only.** Never `--no-verify`, never `GUARD_OVERRIDE`, never amend a deployed commit.

---

## File posture

16. **Never delete features silently.** A feature being retired moves to `UnderConstructionPanel` placeholder for one release, then the file is deleted in a separate PR with explicit user approval.
17. **Never hide incomplete features.** UC entries are visible (per [13-ui-information-architecture.md]) — they're not removed from nav, they're not soft-hidden, they're not behind a flag.
18. **Never introduce deprecated naming.** "Site Office" and "Switchboard" (as product labels) are banned. ESLint enforces; if the lint catches you, fix the code, don't suppress the lint.
19. **Never modify production rewrites in shell phases.** `vercel.json` is read-only until the brief says otherwise (Phase C onward, one rewrite at a time).
20. **Never mix Phase A shell with Phase B hours.** Different sessions, different PRs, different reviews.
21. **Never create UI without the data model.** A new section / page / component must be backed by an entity in [12-domain-model-deep-dive.md]. If not, stop and ask.
22. **Never create data without ownership / status / audit rules.** A new entity must have its `created by`, `edited by`, `status`, and audit log entries defined in the doc *before* the code lands.
23. **Never create mock-only features that look live.** If fixtures are loaded, `DemoModeBanner` must be visible. The `BUHLOS_MOCK` silent-fallback pattern is banned.

---

## Documentation posture

24. **Document command results.** Every Phase X session must produce a command-results document (`docs/rebuild-audit/22-phase-1b-command-results.md` for Phase 1B; equivalent for later phases) listing every command run, its outcome, and any fixes applied.
25. **Run tests and builds.** `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`, plus the 4 legacy guards. Capture results.
26. **Report exact changed files.** Final report includes `git status --short` output and a count of new vs modified.
27. **Update relevant docs in the same PR as the code.** If Phase B ships hours, the Phase B brief is marked complete, the executive summary gets a Phase B section, the risk register is reviewed for retired risks.
28. **No PR without a phase declaration.** Every PR title starts with `[Phase X]` or `[Phase 1B docs]` or similar.

---

## Communication posture

29. **Stop and ask when prompt conflicts with audit.** The audit docs are the source of truth; user prompts that contradict them get surfaced, not silently obeyed.
30. **Stop and ask when scope creeps.** If implementing Phase A starts to require Phase B work, stop. Ask whether the audit needs updating or the scope needs trimming.
31. **Stop and ask when a legacy endpoint is unsuitable.** Do not silently write a new endpoint that diverges from the legacy contract.
32. **Prefer small phase-bounded commits.** One feature, one PR, one preview verification.
33. **Surface the cost of ambiguity.** When the prompt is unclear, list the possible interpretations and ask which is meant.

---

## Specific bans (cheat sheet)

| Pattern | Banned by rule |
| --- | --- |
| `alert()` / `confirm()` / `prompt()` in product code | #18 (lint) |
| Inline `<style>` blocks in components | #18 (lint) |
| `window.location.href = ...` for in-app nav | UI rule (use `<Link>` / `useRouter`) |
| New static HTML in `public/` | #19, #21 |
| `any` in `src/` | TypeScript strict rule |
| Skipping Zod validation on an API mutation | API rule |
| Adding silent mock fallback (BUHLOS_MOCK pattern) | #23 |
| Adding "site office" / "switchboard" as product label | #18 |
| `vercel deploy --prod` from local / feature branch | #11, #12, #13 |
| Full-document writes to grow-collections in new endpoints | API rule |
| Editing `public/*.html`, `api/*.js`, `vercel.json` in Phase A | #19 |
| Removing or adding `vercel.json` rewrite in Phase A | #19 |
| Adding a `/buhlos/*` mirror route | banned in salvage map |
| Naming a file or folder `site-office` | #18 |
| Mixing Phase A scaffold with Phase B hours in one PR | #7, #20 |
| Building features beyond the phase brief | #6 |
| Pushing to `main` directly | #12 |
| Skipping CI checks / using `--no-verify` | #11, #14 |
| Deleting a feature without putting UC placeholder for one release first | #16 |

---

## Per-phase posture summary

| Phase | Posture |
| --- | --- |
| **A** | Build shells only. Don't touch legacy. Don't deploy. Don't push. |
| **B** | Build hours loop only. Don't cutover any route. Don't deploy directly. PR + Vercel auto-deploy. |
| **C** | Build gear loop. Execute `/login` + `/phil` + `/my-day` cutovers one at a time, each with its own PR + preview + rollback plan. |
| **D** | Build jobs + evidence + snags. Execute `/admin/*` cutovers section-by-section. |
| **E** | Build ITP / RFI / materials / plans / variations. Execute remaining `/admin/*` cutovers. |
| **F** | Build reporting + integrations + intelligence. Execute Xero push, AI plan rebuild. |
| **G** | Service worker rewrite + legacy quarantine. Delete `/buhlos/*` mirrors + dev surfaces. |

---

## Cross-references

- [10-product-definition.md](10-product-definition.md)
- [11-operational-workflow-map.md](11-operational-workflow-map.md)
- [12-domain-model-deep-dive.md](12-domain-model-deep-dive.md)
- [13-ui-information-architecture.md](13-ui-information-architecture.md)
- [14-technical-architecture-deep-dive.md](14-technical-architecture-deep-dive.md)
- [15-risk-register.md](15-risk-register.md)
- [16-migration-strategy.md](16-migration-strategy.md)
- [17-testing-and-quality-plan.md](17-testing-and-quality-plan.md)
- [18-phase-a-implementation-brief.md](18-phase-a-implementation-brief.md)
- [19-phase-b-hours-implementation-brief.md](19-phase-b-hours-implementation-brief.md)
- [21-rebuild-decision-record.md](21-rebuild-decision-record.md)
- [../architecture/00-rebuild-non-negotiables.md](../architecture/00-rebuild-non-negotiables.md)
