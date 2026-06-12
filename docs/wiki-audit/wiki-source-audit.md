# Wiki source audit — what the GitHub Wiki was built from

Build date: 2026-06-12 (overnight run, resumed 04:01). Repo state: `main @ cf9c776`. Author: Claude Code (wiki build session). The deliverable is the GitHub Wiki; this file records what was inspected, what was found, and the decisions behind the wiki's structure so the next person (or agent) can refresh it instead of re-discovering the project.

## What was inspected

- **Repo state**: `git status/log` (main, `cf9c776`), full file tree to depth 3, `package.json` (scripts, deps, Node 24), `next.config.ts`, `vercel.json` (via route agent), `.github/workflows/{ci,preview-smoke}.yml`, `.github/ISSUE_TEMPLATE/*`.
- **Routes/surfaces** (verified by a dedicated exploration pass): every `public/*.html` + `public/admin/*.html`, every `src/app/**` page, `src/middleware.ts`, `src/lib/auth/landing.ts`, `public/manifest.json` (start_url `/my-day`), `public/sw.js` (`buhl-shell-v8`), `docs/route-ownership.md`, AdminSidebar/PhilTabBar nav, naming guards (`scripts/check-route-ownership.js`, `src/naming/deprecated-naming.test.ts`).
- **API layer**: all ~100 `api/*.js` endpoints + `api/_lib/*` (blob, blob-guards, backup(+manifest), auth, push, email(+templates), feature-flags, validation, time-entries, supabase-env, test-data); blob store catalog (exact + prefix stores); deprecated endpoints (`hours.js` 410-on-write, `job-timeline.js`).
- **Domain layer**: every `src/domains/*` (schemas/types for Job, TimeEntry, Evidence, Observation, Snag, MaterialRequest, ITP, Document, GearAsset, StructurePreset; pure logic: `jobs/progress.ts`, `jobs/taskState.ts`, `phil/job-command-model.ts`, `phil/needs-you.ts`, `timesheets/weekly-closeout.ts`, `timesheets/service.ts` — `STANDARD_DAY_HOURS = 7.6`/456min, `qa/time-entry-attribution.ts`).
- **Supabase**: `supabase/migrations/2026061114…` + `…212723` (31 tables, RLS on / 0 policies), `scripts/importers/*`, `docs/supabase-{environment,importer-plan,migration-research-audit}.md`, `api/_lib/supabase-env.js`.
- **Docs**: `README.md`, `OVERVIEW.md` (stale-flagged), `docs/product/*`, `docs/architecture/*`, all 37+ `docs/rebuild-audit/*`, ~25 feature docs, `docs/testing/*`, `docs/qa/*`, `docs/field-readiness/*`, `docs/regressions/*`, `docs/issues.md`.
- **GitHub**: repo metadata (`hasWikiEnabled: true`, wiki git repo **not initialized**), all **242 issues** (`gh issue list --state all`, aggregated per epic), the 18 epic umbrellas + north-star #120 (body read in full), label taxonomy (`gh label list`).
- **Tests/guards**: vitest suites, `tests/playwright/smoke/*`, the 9-script guard suite wired into CI/predeploy.

## Verified tech-stack determination

Mixed, deliberately: legacy static HTML/JS (`public/`, routed by `vercel.json` rewrites, production for several modules) + Next.js 15 App Router/React 19/TS strict (`src/`, the rebuild) + shared plain-JS Vercel serverless API (`api/*.js`) + Vercel Blob JSON as the system of record. **No Google Sheets/googleapis/service accounts anywhere** (historical claims are stale). **No Xero API code** — only `xeroEmployeeId` fields + CSV exports. Anthropic API used in `plans.js` (vision takeoff), `quotes.js` (estimate review), `tags.js` (OCR). Resend email; web-push (VAPID). Supabase Postgres: schema applied, **zero production traffic**.

## Current modules — status classification (the wiki's "brutally clear" layer)

- **Built and usable**: hours loop (daily + weekly closeout + bulk/week approve + reopen), jobs v2 (index/hub/builder/presets/duplicate/publish/canonical progress), Phil (My Day, jobs list, job bible, capture v2, hours incl. rejected-resubmit, gear, onboarding), evidence review, observations + snag/material conversions, material requests, snags v2, ITP loop (templates→instances→recording→witness→sign-off), plans read viewer + markups + AI takeoff, gear register, employees/invites, backups, flags, audit log.
- **Built but incomplete**: weekly closeout lacks committed payroll export (#126); ITP lacks v2 authoring (#284); plans upload still legacy-only; material requests lack POs (#318); Phil lacks offline (#135/#143); analytics = legacy reports only.
- **Built but legacy** (production, replacement planned): quotes module, materials/PO/invoice match, plans upload, `/admin/operations` SPA + remaining `/admin/*.html`, `/my-day`, `/lh`, `/client`, old `/phil` prototype.
- **Planned, not built**: RFI (#276) & variations (#280) modules, Xero (epic #184), v2 quoting (epic #168), scope-of-work spine (#364/#366/#367), QR labels (#303), test-and-tag (#305), AI assistant (epic #165), AI drawings ladder (epic #167), client portal rebuild (epic #269), offline sync engine (#158).
- **Unclear/needs decision**: tabbed Phil job interface (design cached in `.design-cache/`, not ratified — #133 gated on #132); audit-log durability (#355); quoting migrate-vs-integrate (#172).
- **Should exist, no issue found** (proposed in the wiki's Issue-Map, deliberately not created): installed-app entry cutover to new Phil (manifest `start_url` + legacy landing + redirects); v2 cross-job snags inbox (or explicit scope-into-#187); LH home rebuild (`/lh`); wiki-touch maintenance rule.

## Issue-base findings

242 issues (232 open/10 closed), 18 epics, conventions enforced by `docs/issues.md` + templates. Fresh backlog (generated 2026-06-11) → no stale issues. Overlap clusters documented in the wiki Issue-Map (money-capture family #369→#370→#280→#372; search #161→#188/#144; templates #191 on closed #192; as-builts #233 vs #291/#299; file imports behind #310; vans #307/#326; leave semantics #127/#333/#137). Stale *references*: #120 body says "~210 issues" (now 242); `ROLL_OUT_STATUS.md` lists PR #76 as open (merged `5d1723e`).

## Wiki structure decision

35 pages published to the GitHub Wiki (the spec's 29 preferred pages adapted to repo reality, plus justified extras: Current-State, Supabase-Migration, Materials-and-Suppliers, Agent-Playbook, Issue-Conventions, Docs-Index). Every workflow page uses Currently-built / Intended-direction / Gaps-with-issue-links. Naming guard respected ("Switchboard"/"Site Office" appear only as deprecated-naming notes in Glossary/Design pages).

## How to refresh this wiki

1. Re-verify the snapshot line (`main @ <sha>`) and the Current-State loop table against `docs/field-readiness/` + recent merges.
2. Re-run the issue aggregation (`gh issue list --state all --limit 500 --json number,title,state,labels`) and update Issue-Map counts + closed lists.
3. Touch the workflow page for any merged behaviour change (the wiki proposes a standing wiki-touch rule).
4. Don't re-audit from scratch — extend this file and the rebuild-audit pack's freshest snapshot instead.

## Post-build addendum (same night, ~04:45)

**PR #376 — the legacy interface cutover — merged onto origin/main at 01:21 (`c92d1b1`) while this wiki was being built against the local checkout (`cf9c776`).** Caught during the final memory pass; verified against origin (`git fetch` + PR body + tree inspection); the wiki received a same-night correction commit (`8304549`).

What changed: the entire legacy static estate is deleted (only `client.html` survives); every legacy URL 307s to canonical (matrix in `docs/route-ownership.md` §6); manifest = "Phil" with `start_url /phil/my-day` (entry-point gap resolved — installed apps now land on new Phil); SW v9 push-only; LH lands `/phil/my-day`; legacy-only capabilities honestly retired to the backlog (payroll export #126, plan upload #194/#197, materials money #268/#318, quotes #168/#172/#183, variations/reports/cash/suppliers/temps/settings/support, asset create/edit); new guards `check:legacy-quarantine` + `smoke:legacy-redirects`.

Wiki classification deltas vs the body of this audit: "built but legacy (production)" category is now empty except `client.html`; quotes/plans-upload/materials-money moved to "planned, not built (UI retired, API+data intact)". Proposed-missing-issues list updated: cutover proposal dropped (shipped as #376); added asset-create/edit and supplier-register-UI proposals.

**Git state warning for the next session:** local `main` and `origin/main` have diverged — origin has `c92d1b1` (#376); local has 6 unpushed commits (5 Supabase-arc commits + this audit doc). Rebase local onto origin/main before pushing; pushing main deploys production.
