# Legacy-interface cutover (2026-06-12)

> Deprecated historical reference only where it describes the old estate.
> The **contract** that survives this doc lives in
> [`docs/route-ownership.md`](route-ownership.md) §1/§3/§6/§7/§11 and the
> guards listed at the end.

The product had two parallel interfaces since the rebuild started: the legacy
static estate (`public/*.html` + `_shell.js` shells, vercel rewrites, a caching
service worker) and the modern Next.js surfaces (BuhlOS admin + Phil field).
Old layouts repeatedly resurfaced in production — stale HTML, rewrites serving
deleted shells, SW caches replaying old assets, "open the old page" links in
modern chrome.

This cutover removed the legacy interface entirely. **BuhlOS** (desktop/office)
and **Phil** (mobile/field) are the only interfaces; every legacy URL
`307`-redirects to its canonical modern route; nothing can serve, cache, link
or fall back to the old UI; and guards fail any PR that tries.

## What was deleted (git history is the archive)

- **Entry/auth:** `login.html` (incl. its private `landingFor()`)
- **Field:** `phil.html`, `my-day.html`, `my-gear.html`, `phil-hours.html`,
  `project.html`, `lh-home.html`, `install.html`, `install-prompt.js`,
  `log-hours-sheet.js`, `mobile-nav.js`
- **Admin:** `admin.html` (pre-BuhlOS 8k-line admin) + the entire
  `public/admin/` suite (24 module pages, `_shell.js`, `_shell.css`,
  mock `admin-data.js`)
- **Dev galleries:** `public/dev/components/`, `public/dev/site-office/`
- **Shared legacy assets:** `public/components/*.js` (21 web components),
  `public/lib/*.js`, `css/buhlos-admin.css`, `BUHL_LOGO.png`, `logo.png`
- **vercel.json:** all ~45 legacy rewrites (including `/` → `login.html` and
  the whole `/buhlos/*` alias tree)

## What replaced it

- **Redirect matrix** (`vercel.json` `redirects`, all `307`): see
  route-ownership §6. Old bookmarks, installed PWAs (old `start_url
  /my-day`) and historical push deep-links all land on the modern app.
- **Root `/`** is owned by `src/app/page.tsx` (session → `landingFor(role)`,
  else `/v2/login`).
- **Landing:** leading hands now land on `/phil/my-day` (the legacy `/lh` home
  is gone; LHs keep `/v2/jobs` read access). Admin → `/command-centre`,
  field → `/phil/my-day`, client → `/client`.
- **Service worker v9** (`buhl-sw-v9`): push-only; no precache, no fetch
  handler; `activate` purges every cache (devices on `buhl-shell-v1..v8` come
  clean). Push handlers + `/phil/my-day` deep-link defaults kept — existing
  subscriptions stay live because the `/sw.js` URL is unchanged.
- **Manifest** is the Phil manifest: `name "Phil"`, `start_url /phil/my-day`.
  Modern Phil pages link it (`src/app/phil/layout.tsx`) so the app stays
  installable.
- **PWA wiring in modern shells:** `PwaRegistrar` (in `PhilShell` +
  `AdminShell`) registers `/sw.js` and silently refreshes the push
  subscription when permission is already granted; `PushNotificationsCard`
  (`/v2/phil` + `/command-centre`) is the explicit opt-in — replacing the
  legacy pages' auto-prompt.
- **Push payload URLs** in `api/*.js` now emit only canonical modern routes
  (`/phil/my-day`, `/phil/jobs/:id#phil-job-snags`, `/command-centre`,
  `/hours`, `/employees`, `/v2/jobs/:id`).

## The one kept exception

`public/client.html` (+ its two `/client*` rewrites, `theme.css`,
`css/buhlos.css`) — the read-only **client portal**. It is external-customer
facing and has no modern replacement yet (#271 / Epic 16). It is
self-contained: no legacy shell, no legacy components. When #271 lands, retire
all four files and the rewrites (route-ownership §12.1).

## Capability honestly removed (legacy-only tools with no modern equivalent)

These existed only in the legacy admin suite. Their UI affordances in the
modern app were rewritten to honest "retired in the legacy cutover — on the
backlog" copy (no fake links, per the no-fake-UI rule):

| Capability | Old home | Modern state |
| --- | --- | --- |
| Plan/spec upload + revision curation (+ AI takeoff UI) | `/admin/plans` | Read-only viewers on the job pages; uploader = backlog |
| Materials takeoff / POs / invoice match | `/admin/materials` | `/material-requests` covers field requests only |
| Asset create/edit/archive | `/admin/assets` | `/gear` register is assign/return; editor = backlog |
| Structure editing for jobs with archived rooms/tasks | `/admin/jobs` editor | Builder locks structure for those jobs (honest notice) |
| Quotes / variations / reports / cash / suppliers / temps / settings / support / activity | `/admin/*` modules | No modern equivalent; URLs redirect to `/command-centre`; backlog epics cover rebuilds |

## Guards that keep it dead

- `scripts/check-legacy-quarantine.js` (predeploy + CI) — absence of every
  deleted path; no servable HTML but `client.html`; redirect matrix intact;
  Phil manifest; push-only SW; no legacy URL literals / banned phrases /
  deprecated names in live code.
- `scripts/check-production-shell.js` — root owned by Next; high-traffic
  legacy entries redirect; modern shells intact; prototype marker banned.
- `scripts/check-admin-shell.js` — `public/admin` stays deleted.
- `scripts/smoke-admin-routes.js` — static admin chain into `/command-centre`.
- `scripts/check-sw-cache-version.js` — `sw.js` change ⇒ `SW_VERSION` bump.
- `src/naming/deprecated-naming.test.ts` + `src/routing/legacy-redirects.test.ts`
  — the same contracts at unit level (`npm run test:unit`).
- `npm run smoke:legacy-redirects -- <url>` — live redirect/404 matrix against
  any deployment; run it on the PR preview and after the production deploy.
