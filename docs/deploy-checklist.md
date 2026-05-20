# BuhlOS deploy checklist

Run-before-you-push list for any production deploy. The static checks in
`npm run predeploy` cover most of this automatically — but the human ones
(eye-test critical routes, confirm SW behaviour, watch the deploy land)
still matter.

## Before `vercel deploy --prod`

- [ ] On a branch that descends from `origin/main` (the predeploy guard
      checks this; don't bypass without reading the regression note).
- [ ] `git fetch && git status` shows the branch is rebased on the latest
      `origin/main` (no stale shell, no merge mess).
- [ ] `npm run check:admin-shell` passes — every `public/admin/*.html`
      calls `SHELL.boot()`.
- [ ] `npm run smoke:admin-routes` passes — the post-login route chain is
      intact and `/admin/operations` will render.
- [ ] If `_shell.js` / `_shell.css` / `sw.js` / any `public/admin/*` was
      touched: bump `CACHE_VERSION` in `public/sw.js`. Stale SW cache
      against a new shell contract has shipped a blank
      `/admin/operations` before. See
      `docs/regressions/admin-operations-blank.md`.

## Critical routes (must render visible content post-deploy)

These four are the load-bearing routes. If any of them goes blank or 500s,
the product is dead on arrival. Hit each in an incognito window after
deploy lands.

| Route                         | Who lands here          | Must show                                              |
| ----------------------------- | ----------------------- | ------------------------------------------------------ |
| `/login`                      | everyone signed-out     | sign-in form, no console errors                        |
| `/admin/operations`           | admin (post-login)      | left nav + topbar + Overview heading + content/empty   |
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
