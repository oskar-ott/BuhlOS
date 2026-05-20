# Regression: blank `/admin/operations`

**Symptom.** A logged-in admin lands on `buhlos.com/admin/operations` and
sees a blank white page. The shell skeleton (left nav, top bar, page area)
never appears. No errors are visible to the user; the only signal is in the
browser console.

**This regression has now happened repeatedly.** Each occurrence had a
different root cause but the same user-facing symptom, which is why this
note exists — to capture the failure-mode-agnostic guardrails that now
prevent any cause from shipping blank to production.

## Root causes so far

| When         | PR     | Root cause                                                                                         | One-line fix                                     |
| ------------ | ------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 2026-05-12   | #35    | `Site office · Phase 03 · overview rebuild` rewrote `operations.html` and dropped the trailing `SHELL.boot();` call. With no boot, the shell skeleton never mounts and `PAGE.render` is never invoked. | Restore `SHELL.boot();` at the end of the script. |
| 2026-05-14   | #205   | A throw inside `loadOverview` / `paintOverview` left the page on the "Loading…" placeholder forever. The page had no top-level try/catch. | Wrap `render` in try/catch; surface an error card. |
| 2026-05-14   | #228   | The service worker was serving a pre-perf-pass `_shell.js` that didn't match the new shell API. Stale-cache mismatch → uncaught throw → blank. | Bump SW cache version; add `safeBoot` outer try/catch. |
| 2026-05-20   | #4f69fcd | A worktree branched off a tiny pre-BuhlOS prototype (only `index.html` / `jobs.html` / `login.html` / `phil.html` at the root, no `public/admin/*`) was deployed to `buhlos.com` via `vercel deploy --prod`. The deploy replaced the BuhlOS build with the legacy Birdwood horizontal-tab page entirely. | Pre-deploy branch-ancestry guard; rejected divergent worktrees. |
| 2026-05-21   | *(this one)* | Same as #35 — `operations.html` was again missing `SHELL.boot();` (the prior fix had been lost in a branch reset). Audit also found `activity.html`, `cash.html`, and `materials.html` had **never** had `SHELL.boot();` and would also render blank on first visit. | Restore `SHELL.boot();` in all four pages; add static + runtime guards. |

## The structural problem

Every `/admin/<page>.html` follows this contract:

1. `<link rel="stylesheet" href="/admin/_shell.css">`
2. `<script src="/admin/_shell.js"></script>` — defines `window.SHELL`
3. inline `<script>` defines `window.PAGE = { id, title, render }`
4. **explicitly calls `SHELL.boot()`** at the end of the inline script

If step 4 is missed, the page renders blank. There is no visible error
because `boot()` was never invoked — the shell skeleton (`#app`, `#side`,
`#topbar`, `#page`) is never injected, `PAGE.render` is never called, the
try/catch inside `safeBoot` is never reached, the SW cache is irrelevant.
The page is `<body></body>` and the user stares at white.

A single forgotten line in a single file would turn the whole admin landing
page blank. That is the regression that keeps happening, and that is the
class of failure we now guard against at multiple layers.

## Guardrails now in place

These layers stack — each one independently prevents the blank-page
symptom. We keep all of them because each addresses a different failure
mode (developer forgot, build skipped, runtime threw, branch was wrong).

1. **Convention** — every admin page ends with `SHELL.boot();`. Easy to
   read, easy to grep, no magic.
2. **Static check before deploy** — `scripts/check-admin-shell.js`. Scans
   every `public/admin/*.html` for the explicit `SHELL.boot();` call and
   fails the build if any page is missing it. Runs as `npm run
   check:admin-shell` and via the `predeploy:prod` hook in
   `package.json`. CI / `vercel deploy --prod` won't run if any admin
   page would render blank.
3. **Route smoke test before deploy** — `scripts/smoke-admin-routes.js`.
   Asserts the post-login chain end-to-end:
   - `vercel.json` rewrites `/admin` and `/admin/operations`
   - `login.html` redirects admin → `/admin/operations`
   - `admin/index.html` redirects admin → `/admin/operations`
   - `operations.html` defines `window.PAGE`, calls `SHELL.boot()`, has
     loading + error states, and wraps `render` in try/catch
   - `_shell.js` exposes `SHELL.boot`, has the auto-boot fallback and
     blank-shell detector, and `safeBoot` try/catches `boot()`
   - `api/auth.js` exists
4. **Runtime auto-boot fallback** — `_shell.js` schedules
   `safeBoot()` on `DOMContentLoaded` if no page has called `SHELL.boot()`
   yet. If the page forgets, the shell still mounts; we just log a
   console warning so the convention is restored in code review.
5. **Runtime blank-shell detector** — `_shell.js` waits 5s after DOM ready
   and, if `#app` still isn't in the document, replaces the body with a
   visible "Admin shell didn't load" recovery panel with reload / login
   actions. The user is never left looking at white.
6. **Top-level safeBoot try/catch** (PR #228) — any uncaught throw in
   `boot()` (auth, fan-out, sidebar render, `PAGE.render`) is caught and
   surfaced as a visible "Couldn't load the admin shell" panel with a
   reload button + stack trace.
7. **Per-page render try/catch** (PR #205) — `operations.html` (and any
   page following the same pattern) wraps its own `loadOverview` /
   `paintOverview` in try/catch and surfaces a "Couldn't load the command
   centre" message if data fetching throws.
8. **Per-fetch timeouts** (PR #205) — slow optional fetches
   (`/api/materials-summary`, `/api/time-entries-overview`) race a 6–8s
   timeout and resolve to null if late, so a single hung connection
   never freezes the whole page.
9. **Service worker cache version bump** (PR #228) — when the shell API
   changes, bumping `CACHE_VERSION` in `sw.js` forces every client to
   re-fetch `_shell.css` / `_shell.js` / `theme.css` so SW-cached
   stale assets can't paint a blank page against a new page contract.
10. **Pre-deploy branch-ancestry guard** (PR #4f69fcd, on
    `prod-base-from-origin-main` — also enforced here) — `vercel deploy
    --prod` won't run if the current branch isn't a descendant of
    `origin/main`, so a prototype branch can't replace prod again.

## Critical files

| File                                       | Why critical                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| `public/admin/operations.html`             | Post-login admin landing. If this renders blank, the product is dead on arrival.      |
| `public/admin/_shell.js`                   | The shell. Without it, no admin page renders. Auto-boot + blank detector live here.   |
| `public/admin/index.html`                  | `/admin` → `/admin/operations` role-aware redirect. Tradies/clients are routed away.  |
| `public/login.html`                        | Post-login redirect map. Admin → `/admin/operations`.                                 |
| `vercel.json`                              | Owns the `/admin/operations` → `/admin/operations.html` rewrite.                      |
| `scripts/check-admin-shell.js`             | Static guard — every admin page must call `SHELL.boot()`.                             |
| `scripts/smoke-admin-routes.js`            | Route-chain smoke test — covers vercel.json + login + redirect + render contract.     |

## When this fires again

If `/admin/operations` shows blank in production:

1. Open browser devtools console. Look for:
   - `SHELL: page did not call SHELL.boot() — auto-booting` — the page is
     missing the explicit call. Auto-boot saved it at runtime but fix
     the page in code.
   - `SHELL: blank shell detected after 5s — emergency fallback` — boot
     ran but `#app` never mounted. Look at the prior errors.
   - `SHELL.boot failed` — boot threw. The error message + stack are in
     the console and in the visible recovery panel.
   - `operations render failed` — `PAGE.render` threw. The error is in
     the visible "Couldn't load the command centre" card.
2. Check the service worker. Hard refresh (Cmd-Shift-R) or unregister at
   `chrome://serviceworker-internals`. If a hard refresh resolves the
   blank, the SW is serving stale assets — bump `CACHE_VERSION` in
   `public/sw.js` and redeploy.
3. Run the static guards locally:
   ```
   npm run check:admin-shell
   npm run smoke:admin-routes
   ```
   If either fails on `main`, that's how this shipped.
4. Cross-check `vercel.json` rewrites and the live deployment's actual
   served file at `/admin/operations` (use curl, not the browser, to
   bypass the SW cache).

Do not just patch the symptom. The whole point of layering 10 guardrails
is that any single missing layer should not break production. If we
reach this note again, ask which layer failed and why, and add layer 11.
