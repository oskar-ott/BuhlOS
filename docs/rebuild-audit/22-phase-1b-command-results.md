# 22 · Phase 1B · command results

> Session record for the Phase 1B deep audit. Captures every command run, file touched, and check executed. **Documentation-only — no runtime or app code changed.**

---

## Session metadata

| | |
| --- | --- |
| **Date** | 2026-05-23 |
| **Worktree** | `/Users/oskar/Desktop/birdwood/.claude/worktrees/wizardly-wright-b1640e` |
| **Branch** | `phase-1b-rebuild-deep-audit` |
| **Base commit** | `dcac892` — `docs: align phase a branch naming` (tip of `phase-1-rebuild-audit`) |
| **Phase A status** | Committed on `phase-a-app-shell` as `a49dc82` (separate branch; not part of this 1B work). |
| **Audit docs on main?** | No (`main = 5cdfcaf`; audit commit `f7b748d` not an ancestor). |

---

## Pre-flight diagnostics

```
pwd                                  → /Users/oskar/Desktop/birdwood/.claude/worktrees/wizardly-wright-b1640e
git branch --show-current            → phase-1b-rebuild-deep-audit
git rev-parse HEAD                   → dcac8927f432ae00b5af581b55d857bc41d7e83c
git status                           → On branch phase-1b-rebuild-deep-audit; untracked .next/ and tsconfig.tsbuildinfo (Phase A dev artifacts; outside any branch state)
git remote -v                        → origin = https://github.com/oskar-ott/BuhlOS.git (fetch + push)
git log --oneline -n 20              → dcac892 docs: align phase a branch naming; f7b748d docs: add phase 1 rebuild audit; 5cdfcaf BuhlOS admin tools v2 — SPA layer (#241); …
find docs -maxdepth 3 -type f        → 15 audit/architecture/product/regressions/deploy-checklist docs already present
```

All four Phase 1 audit docs confirmed present (`docs/rebuild-audit/00-executive-summary.md`, `08-next-claude-code-prompt.md`, `docs/architecture/00-rebuild-non-negotiables.md`, `docs/product/00-core-operational-loops.md`).

---

## Deep inspection (read-only)

### Enumerations

| Command | Result |
| --- | --- |
| `ls public/*.html` | **10 root HTML surfaces** (admin, client, install, lh-home, login, my-day, my-gear, phil-hours, phil, project) |
| `ls public/admin/*.html` | **23 admin surfaces** (activity, approvals, assets, cash, crew, hours, index, itp, job-builder, job, jobs, materials, operations, plans, quote, quotes, reports, settings, snags, suppliers, support, temps, variations) |
| `ls public/components/` | **21 web-component-style JS files** (workspace-shell, cmd-palette, area-card, buhl-mark, empty-state, inbox-stack, job-header, list-row, open-in-field, product-chip, product-drawer, progress-bar, pulse-strip, queue, rate-flag, role-pill, seg-status, snag-button, sync, task-row, tools-menu) |
| `ls public/lib/` | 2 (approvals-badge, compliments) |
| `ls public/css/` | 2 (buhlos.css, buhlos-admin.css) |
| `ls api/*.js` | **86 endpoints** (flat; no domain folders) |
| `ls api/_lib/` | 8 (activity, auth, blob, job-audit, job-tasks, push, time-entries, validation) |
| `ls scripts/` | 8 (check-admin-shell, check-prod-branch, check-production-shell, check-sw-cache-version, make-icons, migrate-hours, reset-pin, smoke-admin-routes) |
| `ls api/time-entries*.js` | **10 endpoints** (time-entries + approve / bulk-approve / bulk-reject / export / on-site / overview / recent-jobs / reject / reopen) |

### Greps

| Pattern | Hits (outside docs) | Notable findings |
| --- | --- | --- |
| `Switchboard` (case-insensitive) | 117 | Mostly electrical-equipment usage (allowed). Product-label leaks: `public/admin/_shell.js:9` ("BuhlOS site office — shared shell JS" comment), `public/sw.js:32` (historical comment). |
| `site[-_ ]?office` (case-insensitive) | 60 | Real product-label leaks in: `public/lh-home.html:801` ("Switch to site office view" link + "Site office →" labels), `public/login.html:14,541,648,741,744` (page comments + "Site office · BuhlOS" eyebrow), `public/css/buhlos-admin.css:2` (header comment), `public/phil.html:1548-1549` ("Clients use the Site Office portal" + "Go to Site Office" button — **user-facing**), `public/dev/site-office/` folder, `public/admin/settings.html:78` (text mentioning the localStorage key). |
| `BUHLOS_MOCK` | multiple in `public/admin/operations.html` + `public/admin/admin-data.js:310` | Silent fallback hydrates STATE if API empty (lines 1670–1692, 2372, 2546–2547). |
| `MOCK_` constants | multiple in `public/phil.html` | `MOCK_JOBS`, `MOCK_AREAS`, `MOCK_TASKS`, `MOCK_HOURS` defined and used as silent fallbacks throughout the file. |
| `localStorage` writers | **12 files** | `install-prompt.js`, `lh-home.html`, `my-day.html`, `login.html`, `admin/operations.html`, `admin/variations.html`, `admin/_shell.js`, `admin/reports.html`, `admin/settings.html`, `components/cmd-palette.js`, `components/workspace-shell.js`, `dev/site-office/components.html`. |
| Deprecated localStorage keys | **2 keys** | `buhl-site-office-tweaks` (TWEAK_KEY in `admin/_shell.js:24`) + `buhl-site-office-density` (DENSITY_KEY in `components/workspace-shell.js:76`). |
| `process.env.*` references in `api/` + `scripts/` | **20 unique** | `SESSION_SECRET`, `BLOB_READ_WRITE_TOKEN`, `VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT`, `ANTHROPIC_API_KEY`, `PLANS_AI_MODEL`, `PLANS_AI_INPUT/OUTPUT_USD_PER_MTOK`, `PLANS_MAX_USD_PER_JOB`, `RESEND_API_KEY`, `CRON_SECRET`, `ADMIN_ALERT_EMAIL`, `SNAG_EMAIL_FROM`, `GUARD_OVERRIDE`, `DRY_RUN`, `BLOB_CACHE_DISABLE`, `NEW_PIN`, `USERNAME`, `ADMIN_USER_ID`, `NODE_ENV` (implicit). |
| `deploy:prod` / `vercel deploy --prod` | in `package.json` + comments in `scripts/check-prod-branch.js`, `check-production-shell.js`, `check-admin-shell.js`, `smoke-admin-routes.js` | `deploy:prod` script exists in legacy package.json (`vercel deploy --prod --yes`). `predeploy:prod` runs `check-prod-branch`. Override `GUARD_OVERRIDE=YES-I-KNOW` documented as the bypass used during the two prod outages. |

### Service worker / manifest

- **`public/sw.js`** — v5 cache; stale-while-revalidate for admin shell only; no API caching; push notifications. Version history visible in comments (v1 → v5; each bump tied to a specific prior outage).
- **`public/manifest.json`** — `name: BuhlOS`, `start_url: /my-day` (legacy tradie home; flips to `/phil/my-day` in Phase C). Shortcuts include `"Log today's hours" → /my-day?openHours=1`.

### Hours backend (validated for Phase B reusability)

- **`api/time-entries.js`** — HTTP routes: GET (own / approver scope / userId override), POST (create draft or submit), PATCH (edit own draft/rejected or admin any), DELETE (own draft). Permissions: admin / LH gates baked into `handleGet` and `handleCreate`.
- **`api/_lib/time-entries.js`** — storage at `users/<userId>/time-entries/<date>.json` + audit at `users/<userId>/time-entries-audit/<yyyy-mm>.json`. Status enum `['draft', 'submitted', 'approved', 'rejected']`. Helpers: `autoSplitOT` (ordinary = min(total, 8); overtime = max(0, total - 8)), `calcTotalHours`, `validateEntryShape`.
- **Verdict:** keep verbatim for Phase B (per ADR-002 + ADR-009 in [21-rebuild-decision-record.md]).

### Big files (>100KB) in `public/`

- `public/project.html` — 482 KB (9,599 lines, legacy 9.6K-line project page).
- `public/admin.html` — 436 KB (8,180 lines, legacy 8K-line admin).
- `public/admin/job.html` — 283 KB (4,772 lines).
- `public/admin/operations.html` — 163 KB (3,246 lines).

These are the legacy weight; rebuild keeps no file >100KB in `src/`.

---

## Branch operations

| Command | Result |
| --- | --- |
| (on `wizardly-wright-b1640e` worktree, branch `phase-a-app-shell`) `git add` + `git commit` for the 54 Phase A files | **a49dc82** — `Phase A · Next.js + TypeScript foundation alongside legacy (additive)` (54 files changed, +2189 / -3) |
| `git checkout -b phase-1b-rebuild-deep-audit dcac892` | switched to new branch at `dcac892`; working tree clean (.next/ and tsconfig.tsbuildinfo are untracked dev artifacts, not part of any branch) |

No push. No deploy.

---

## Files created (this session, all in `docs/rebuild-audit/`)

1. `10-product-definition.md`
2. `11-operational-workflow-map.md`
3. `12-domain-model-deep-dive.md`
4. `13-ui-information-architecture.md`
5. `14-technical-architecture-deep-dive.md`
6. `15-risk-register.md`
7. `16-migration-strategy.md`
8. `17-testing-and-quality-plan.md`
9. `18-phase-a-implementation-brief.md`
10. `19-phase-b-hours-implementation-brief.md`
11. `20-agent-rules.md`
12. `21-rebuild-decision-record.md`
13. `22-phase-1b-command-results.md` (this file)
14. `23-rebuild-index.md`

## Files updated (this session, all in `docs/rebuild-audit/`)

15. `00-executive-summary.md` — added Phase 1B section.
16. `08-next-claude-code-prompt.md` — updated required-reads list + audit-not-on-main guidance.

**Total: 14 new + 2 updated docs.** No runtime / app code changed. No `public/`, `api/`, `scripts/`, `vercel.json`, `package.json` (on this branch), `OVERVIEW.md`, or `src/` modifications.

---

## Checks / builds / tests run

Phase 1B is documentation-only; no new tests written; no build needed. The pre-existing checks were not re-run on the audit branch (the Phase A branch ran them earlier in the session, all passing).

| Check | Status (when last run) | Notes |
| --- | --- | --- |
| `npm install` | ✅ (on phase-a-app-shell, 481 packages in 27s) | Audit branch does not require install |
| `npm run typecheck` | ✅ (on phase-a-app-shell) | n/a on audit branch |
| `npm run lint` | ✅ (on phase-a-app-shell) | n/a on audit branch |
| `npm run test` | ✅ 7/7 vitest (on phase-a-app-shell) | n/a on audit branch |
| `npm run build` | ✅ (on phase-a-app-shell) | n/a on audit branch |
| `npm run check:admin-shell` | ✅ 23 files · 22 ok · 1 exempt | applies to legacy public/admin/* — unchanged by 1B |
| `npm run check:sw-cache-version` | ✅ no admin shell file changes vs f7b748d | unchanged |
| `npm run check:production-shell` | ✅ production shell intact | unchanged |
| `npm run smoke:admin-routes` | ✅ 18 PASS | unchanged |

---

## Blockers

**None.** Phase 1B audit completed without issue.

---

## Confirmations

- ✅ **Only docs changed.** All 14 new + 2 updated files are under `docs/rebuild-audit/`. Verified with `git diff --stat dcac892 -- src public api scripts vercel.json package.json OVERVIEW.md migrate-*.js recover-*.js seed-*.js unify-*.js` (returns empty).
- ✅ **No runtime code changed.**
- ✅ **No deploy occurred.** `vercel deploy` was not invoked.
- ✅ **No push occurred.** Branch `phase-1b-rebuild-deep-audit` is local only.
- ✅ **No legacy file touched.**
- ✅ **No `vercel.json` rewrite flipped.**

---

## Recommended next action

1. **Review the Phase 1B audit pack.** Start with [00-executive-summary.md](00-executive-summary.md) §Phase 1B section, then [23-rebuild-index.md](23-rebuild-index.md), then any doc that surfaces a decision you want to revisit.
2. **Decide whether to commit Phase 1B docs.** This document and the 13 others alongside it form a single commit on `phase-1b-rebuild-deep-audit`. Commit when satisfied; do not push.
3. **Decide whether to merge Phase 1B + Phase A to `main`.** Recommended order:
   - PR `phase-1b-rebuild-deep-audit → main` first (docs only; low risk).
   - PR `phase-a-app-shell → main` second (foundation; preview-verified).
4. **Start Phase B** using [19-phase-b-hours-implementation-brief.md](19-phase-b-hours-implementation-brief.md) as the prompt. Phase B requires Phase A to be on `main`.

The exact Phase A prompt to paste into the next Claude Code session is at:

- **File:** `docs/rebuild-audit/08-next-claude-code-prompt.md`
- **Updated:** yes (Phase 1B pre-read list now mandatory + audit-not-on-main guidance updated).
