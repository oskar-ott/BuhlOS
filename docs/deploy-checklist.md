# BuhlOS deploy checklist

Run-before-you-push list for any production deploy. The static checks in
`npm run predeploy` cover most of this automatically — but the human ones
(eye-test critical routes, confirm SW behaviour, watch the deploy land)
still matter.

## Production deploys from `main` only

**Do not run `vercel deploy --prod` from a feature branch.** This has shipped
a wrong build to `buhlos.com` more than once (the Birdwood prototype on
2026-05-20, and again on 2026-05-22). `scripts/check-prod-branch.js` blocks
this — `predeploy:prod` will refuse unless HEAD equals `origin/main`. The
correct workflow:

1. Open a PR against `main`
2. Wait for `predeploy` checks to go green
3. Merge the PR
4. Vercel auto-deploys `main` to production

If a previous direct-deploy has the Vercel production alias pinned to a
non-main build, the user-driven step is `vercel promote <main-deployment-url>`
or use the Vercel dashboard's "Promote to production" button on the latest
`main` deploy. The auto-deploy from `main` won't reach `buhlos.com` until
the manual override is undone.

## Before `vercel deploy --prod`

- [ ] On `main` (the `check:prod-branch` guard enforces this; bypass only
      with `GUARD_OVERRIDE=YES-I-KNOW` and only for emergency reverts).
- [ ] `git fetch && git status` shows the branch is rebased on the latest
      `origin/main` (no stale shell, no merge mess).
- [ ] `npm run check:admin-shell` passes — every `public/admin/*.html`
      either calls `SHELL.boot()` (site-office shell) or its own `boot()`
      (standalone SPA).
- [ ] `npm run check:production-shell` passes — production HTML contains
      the BuhlOS Command Centre markers and no `Birdwood IV3232` fingerprint
      anywhere at root level.
- [ ] `npm run smoke:admin-routes` passes — the post-login route chain
      (vercel rewrites + login redirect + role gate + splash defences)
      is intact.
- [ ] `npm run check:sw-cache-version` passes — if `_shell.js` / `_shell.css`
      / `theme.css` / any `public/admin/*.html` was touched, `CACHE_VERSION`
      in `public/sw.js` must be bumped. Stale SW cache against a new shell
      contract has shipped a blank `/admin/operations` before.
- [ ] `npm run check:prod-branch` passes — only meaningful if you are on
      `main` and intend to deploy from `main` directly. CI and Vercel's
      GitHub integration both run from `main`, so this is mostly a
      developer-machine safety.

## Critical routes (must render visible content post-deploy)

These five are the load-bearing routes. If any of them goes blank or 500s,
the product is dead on arrival. Hit each in an incognito window after
deploy lands.

| Route                         | Who lands here          | Must show                                              |
| ----------------------------- | ----------------------- | ------------------------------------------------------ |
| `/`                           | everyone (default)      | sign-in form — NEVER the Birdwood prototype            |
| `/login`                      | everyone signed-out     | sign-in form, no console errors                        |
| `/admin/operations`           | admin (post-login)      | BuhlOS Command Centre — left sidebar with BL mark, splash dismisses, no blank |
| `/lh`                         | leading hand (post-login) | leading-hand home (field control surface)            |
| `/my-day`                     | tradie (post-login)     | today's hours + jobs                                   |

The pre-deploy smoke test (`scripts/smoke-admin-routes.js`) covers the
static contract for `/admin/operations` end-to-end. The other three need
an eye-test until equivalent smokes are written.

## After `vercel deploy --prod` lands

- [ ] Open `buhlos.com/admin/operations` in an incognito window. Sign in
      as an admin. Confirm:
  - left-side navigation visible (bühl admin · site office)
  - "Run / Deliver / People / Win / Settings" section headers
  - Overview heading with today's date
  - pulse strip with four cards
  - no white/blank page at any point
  - no uncaught errors in devtools console
- [ ] If the page IS blank, run the diagnostic flow in
      `docs/regressions/admin-operations-blank.md` — do not ad-hoc patch.
- [ ] Sign in as a leading-hand user; confirm `/lh` renders, not
      `/admin/operations` (LH should never see the admin shell).
- [ ] Sign in as a tradie; confirm `/my-day` renders.

## Rollback

`vercel promote <previous-deployment-url>` brings the previous deploy
back online without rebuilding. The dashboard at vercel.com shows the
last 30 deploys with promote buttons. Used at least once before (see
PR #4f69fcd commit message) — keep it as the first response when a
post-deploy smoke check finds blank routes.

## Things that have shipped blank before — don't repeat

- A worktree branched off a tiny pre-BuhlOS prototype was deployed and
  replaced the BuhlOS build with the legacy Birdwood horizontal-tab page.
  → Pre-deploy guard now rejects divergent branches.
- An admin page was rewritten without the trailing `SHELL.boot();` call.
  → `check:admin-shell` now fails the deploy.
- The service worker cached a pre-perf-pass `_shell.js` against a new
  shell API. → Bump `CACHE_VERSION` whenever the shell changes.
- A page-render throw left the page on "Loading…" forever. → `safeBoot`
  + per-page render try/catch + 5s blank-shell detector now catch it.

See `docs/regressions/admin-operations-blank.md` for full details on
each of these.
