# 09 · Command results

Runtime checks executed at the end of the Phase 1 audit. Captures the exact output of each available command, an interpretation, and a verdict on whether the result blocks the rebuild.

Run date: **2026-05-22**
Run platform: macOS / darwin 25.3.0 / Node v25.6.1 / npm 11.9.0
Branch: `phase-1-rebuild-audit` (off `claude/wizardly-wright-b1640e`, HEAD `5cdfcaf`)

---

## Available scripts (from `package.json`)

```
npm run check:admin-shell
npm run check:sw-cache-version
npm run check:production-shell
npm run check:prod-branch
npm run smoke:admin-routes
npm run predeploy
npm run predeploy:prod
npm run predeploy:preview
npm run deploy:prod
npm run deploy:preview
```

**Notable absences (intentional for this repo today, but tracked for the rebuild):**

- ❌ `npm run dev` — no dev server (the repo has no build step / Next / Vite).
- ❌ `npm run build` — no build (Vercel serves `public/` zero-config).
- ❌ `npm run lint` — no lint config (`.eslintrc.*` absent).
- ❌ `npm run typecheck` — no TypeScript (`tsconfig.json` absent).
- ❌ `npm run test` — no test runner (no `vitest`/`jest`/`playwright` config; no `tests/` or `__tests__/`).
- ❌ `npm run format` — no Prettier config.

The rebuild adds all six of the above.

---

## Command 1 — `npm ls --depth=0`

**Purpose:** verify dependencies are installable / installed locally in this worktree.

```
birdwood-iv3232@1.0.0 /Users/oskar/Desktop/birdwood/.claude/worktrees/wizardly-wright-b1640e
+-- UNMET DEPENDENCY @anthropic-ai/sdk@^0.32.0
+-- UNMET DEPENDENCY @vercel/blob@^0.24.0
+-- UNMET DEPENDENCY bcryptjs@^2.4.3
+-- UNMET DEPENDENCY cookie@^0.6.0
+-- UNMET DEPENDENCY web-push@^3.6.7

npm error code ELSPROBLEMS
npm error missing: @anthropic-ai/sdk@^0.32.0, required by birdwood-iv3232@1.0.0
npm error missing: @vercel/blob@^0.24.0, required by birdwood-iv3232@1.0.0
npm error missing: bcryptjs@^2.4.3, required by birdwood-iv3232@1.0.0
npm error missing: cookie@^0.6.0, required by birdwood-iv3232@1.0.0
npm error missing: web-push@^3.6.7, required by birdwood-iv3232@1.0.0
```

**Interpretation:** `node_modules` was not installed in this worktree (worktrees inherit a checked-out tree but no installed deps). The package.json itself is correct — `@anthropic-ai/sdk` is unused in the JS surface today but is referenced as a dep, presumably for future API endpoints.

**Blocks rebuild?** **No.** `npm install` resolves it. The pre-deploy guards below ran with raw `node scripts/<x>.js` and they only need `fs`/`crypto`/`child_process` — all stdlib.

---

## Command 2 — `node scripts/check-admin-shell.js`

**Purpose:** every `public/admin/*.html` must call `SHELL.boot()` or have its own `boot()`. Catches the regression where a page rewrite drops the boot call and the page renders blank.

```
check-admin-shell · 23 files · 22 ok · 1 exempt · 0 failing
  exempt: index.html
OK   every admin page calls SHELL.boot().
```

**Exit code:** 0 ✅

**Interpretation:** all 23 admin HTML pages either explicitly call `SHELL.boot()` or are the redirect-only `admin/index.html`. The structural guard is healthy.

**Blocks rebuild?** No — the rebuild eliminates the `SHELL.boot()` contract entirely (Next.js mounting replaces it).

---

## Command 3 — `node scripts/check-sw-cache-version.js`

**Purpose:** if any of `public/admin/_shell.js`, `_shell.css`, `theme.css`, or `public/admin/*.html` change vs main, `CACHE_VERSION` in `public/sw.js` must bump. Catches the regression where the service worker serves stale shell assets after a deploy.

```
OK   admin shell changed AND CACHE_VERSION bumped (buhl-shell-v5 → buhl-shell-v7).
```

**Exit code:** 0 ✅

**Interpretation:** the current branch's shell files differ from main and `CACHE_VERSION` has been bumped from `v5` to `v7` — guard passes. (This is the SPA-layer + admin-tools v2 PRs that landed on main as `5cdfcaf`.)

**Blocks rebuild?** No — the rebuild drops the SW shell cache altogether (Next.js handles asset hashing).

---

## Command 4 — `node scripts/check-production-shell.js`

**Purpose:** production HTML must contain BuhlOS Command Centre markers and must NOT contain the `Birdwood IV3232` fingerprint at the root. Catches the regression where a prototype branch was deployed and `/` came up Birdwood instead of login.

```
check-production-shell · 0 issues

OK   production shell contains the BuhlOS Command Centre, no Birdwood IV3232.
```

**Exit code:** 0 ✅

**Interpretation:** clean. No legacy prototype HTML at root. The "BuhlOS · Command Centre" markers are present in `public/admin/operations.html`.

**Blocks rebuild?** No.

---

## Command 5 — `node scripts/smoke-admin-routes.js`

**Purpose:** end-to-end static check that the post-login route chain is intact: vercel.json rewrites, login.html redirects, admin/index.html redirects, operations.html role gate, _shell.js auto-boot fallback, api/auth.js existence. 31 checks.

```
smoke-admin-routes · 31 checks · 31 pass · 0 fail

PASS vercel.json rewrites /admin/operations → /admin/operations.html
PASS vercel.json rewrites /admin → /admin/index.html
PASS vercel.json does NOT rewrite / → /jobs.html (legacy prototype fingerprint)
PASS login.html redirects admin role to /admin/operations
PASS admin/index.html redirects admin role to /admin/operations
PASS admin/operations.html is the BuhlOS Command Centre shell
PASS admin/operations.html defines its own async boot() and calls it
PASS admin/operations.html boot() is wrapped in try/catch/finally
PASS admin/operations.html has splash element + dismissSplash + showBootError
PASS admin/operations.html has splash watchdog (12s safety timer)
PASS admin/operations.html accepts expanded admin-capable roles
PASS admin/operations.html routes leadingHand to /lh, not /jobs
PASS Command Centre has actionable alert pipeline
PASS Labour module has approve / reject actions
PASS Job Builder v1 has stage editor + publish
PASS Job Builder v2 has job setup panel + validation + independent review
PASS ITP / QA v1 has checkpoint renderer + severity
PASS ITP v2 has dashboard + review modal + needs_info + independent-review rule
PASS Plans v1 has revision + publish table
PASS Plans v2 has drawing # + type + area/stage linking + Phil-readiness + upload UC
PASS Variations v1 has KPI tiles + status transitions
PASS Variations v2 has creation form + invoiced status + source + builder ref
PASS Sidebar count badges (computeCounts + renderSidebarBadges)
PASS Mock data layer (admin-data.js) loaded by shell
PASS Reports v2 has computed metrics renderer + Builder performance + honest UC tags
PASS No "Birdwood IV3232" title or "Switchboard" as a section
PASS _shell.js exposes SHELL.boot via window.SHELL
PASS _shell.js has DOMContentLoaded auto-boot fallback
PASS _shell.js has blank-shell detector (last-line recovery)
PASS safeBoot wraps boot() with a top-level try/catch
PASS api/auth.js endpoint exists (login depends on it)

OK   /admin/operations route chain is intact.
```

**Exit code:** 0 ✅

**Interpretation:** 31/31 static structural checks pass. The legacy product on this branch's HEAD is in a consistent state.

**Blocks rebuild?** No. Notably: the smoke test asserts `Switchboard` is not a section name — this is the deprecated-naming guard at work. The audit's broader naming-purge (Site Office in `_shell.js`, in `phil.html` body text, in `login.html` comments, in `buhl-site-office-tweaks` localStorage key) is **not** covered by this script. The rebuild's `00-rebuild-non-negotiables.md` covers that gap going forward.

---

## Command 6 — `node scripts/check-prod-branch.js` (NOT executed)

**Purpose:** verify HEAD === origin/main before allowing `predeploy:prod`. Has an env-var bypass (`GUARD_OVERRIDE=YES-I-KNOW`).

**Not run** because:
- I am not running a production deploy.
- HEAD is currently `5cdfcaf` (the merge to main), but the branch name is `phase-1-rebuild-audit`. The check would correctly compare HEAD-SHA == origin/main-SHA regardless of branch name, but the user has explicitly forbidden production deploys this phase.

**Blocks rebuild?** No — this script is for `predeploy:prod` only. It is **the script that was bypassed** in both production outages, so the rebuild removes the bypass.

---

## Command 7 — TypeScript typecheck (NOT applicable)

**Purpose:** `tsc --noEmit`. Would catch type errors.

**Not run** because:
- `tsconfig.json` does not exist in this repo.
- All current code is vanilla JavaScript.

**Blocks rebuild?** No — the rebuild *introduces* TypeScript. There is nothing to typecheck today.

---

## Command 8 — Build (NOT applicable)

**Purpose:** `next build` / equivalent. Would compile.

**Not run** because:
- No build step exists.
- Vercel serves `public/` zero-config and treats `api/*.js` as serverless functions natively.

**Blocks rebuild?** No.

---

## Command 9 — Lint (NOT applicable)

**Purpose:** `eslint` / `next lint`. Would flag style issues.

**Not run** because:
- No `.eslintrc.*` file.
- No lint script.

**Blocks rebuild?** No.

---

## Command 10 — Tests (NOT applicable)

**Purpose:** `vitest` / `jest` / `playwright`. Would run automated tests.

**Not run** because:
- No test runner configured.
- No `tests/` or `__tests__/` directory.
- No test files of any kind.

**Blocks rebuild?** No — but the **lack of tests is itself a finding**. The rebuild's Phase A acceptance includes the first ever automated test (`tests/phase-a.spec.ts`).

---

## Command 11 — `git status` and `git log`

**Purpose:** confirm the working tree is clean before declaring Phase 1 complete (except for the new untracked docs).

```
On branch phase-1-rebuild-audit
Untracked files:
  (use "git add <file>..." to include in what will be committed)
        docs/architecture/
        docs/product/
        docs/rebuild-audit/

nothing added to commit but untracked files present (use "git add" to track)

---
5cdfcaf BuhlOS admin tools v2 — SPA layer (#241)
a21cb07 Merge remote-tracking branch 'origin/main' into feat/admin-tools-v2
6e2fbe1 Admin tools pass-1 — Job Builder · ITP / QA · Plans · Variations · Reports (#240)
```

**Interpretation:** the branch contains only audit deliverables (untracked under `docs/`). No source files modified. HEAD is unchanged from origin/main's tip (`5cdfcaf`). Clean except for the new docs — which is exactly what Phase 1 produces.

**Blocks rebuild?** No.

---

## Summary

| Command                            | Status         | Blocks rebuild? |
| ---------------------------------- | -------------- | --------------- |
| `npm ls --depth=0`                 | ❌ unmet deps (worktree only) | No — `npm install` resolves |
| `check:admin-shell`                | ✅ PASS         | No              |
| `check:sw-cache-version`           | ✅ PASS         | No              |
| `check:production-shell`           | ✅ PASS         | No              |
| `smoke:admin-routes`               | ✅ PASS (31/31) | No              |
| `check:prod-branch`                | ➖ not run (prod-only) | No        |
| TypeScript typecheck                | ➖ N/A          | No (rebuild adds) |
| Build                              | ➖ N/A          | No (rebuild adds) |
| Lint                               | ➖ N/A          | No (rebuild adds) |
| Tests                              | ➖ N/A          | No (rebuild adds; finding) |
| `git status` / `git log`           | ✅ clean        | No              |

**Overall verdict:** the legacy product on this branch is in a structurally consistent state per the existing guards. The audit found no broken file references, no missing `SHELL.boot()` calls, no stale-cache violations, no production-shell fingerprint issues, no broken route chains for the canonical `/admin/operations` SPA.

**However**, the audit also found that the **guards do not cover** several known issues:
- Phil's `?action=signin` endpoint mismatch (broken login).
- Manifest `start_url` pointing at the legacy `/my-day`.
- The 6 user-facing "Site Office" / "site-office" strings in `phil.html`, `_shell.js`, `login.html`.
- The `buhl-site-office-tweaks` localStorage key.
- The `BUHLOS_MOCK` fallback writing fake data without a visible banner.
- Three coexisting admin architectures.
- Two coexisting Phil surfaces.
- `vercel deploy --prod` from local branches (the cause of both production outages).

These are addressed by the rebuild's [non-negotiables](../architecture/00-rebuild-non-negotiables.md) and [deployment policy](06-deployment-audit.md).

**Nothing blocks the rebuild.** The next step is to commit and merge this audit branch, then start Phase A using the prompt in [08-next-claude-code-prompt.md](08-next-claude-code-prompt.md).
