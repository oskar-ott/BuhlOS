# Phil offline read cache — model, scoping & safety (#135 L2, #575)

> **Status:** shipped. The Phil PWA service worker (`public/sw.js`) is **push +
> a network-first offline READ cache** for `/phil/*` pages and their immutable
> assets. There is **no offline write/outbox yet** — field writes are the
> network-only honest baseline (`philWrite`, [phil-write-idempotency.md](./phil-write-idempotency.md)).
> This doc is the source of truth for what the read cache caches, how it is
> scoped, and the auth/privacy guarantees. The decisions live in code in
> `src/domains/phil/sw-cache-policy.ts` (pure, unit-tested) and are transcribed
> into `public/sw.js` (a plain SW script can't import app modules).
>
> **Validation status (#575):** the pure logic (`shouldCachePhilPage`,
> `overflowCount`, `decidePhilLinkNavigation`, `warmPhilPageCache`) and the sw.js
> drift-guard tokens are **unit-tested**, and `check`/`build`/`check:sw-cache-version`
> are green. Cache population, offline serving of a cached page, auth-redirect
> non-caching, and cross-session purge were **verified live on a PR preview**
> (DevTools cache inspection + a real network cut). The **offline in-app tap path**
> (`PhilOfflineLink`) carries its own acceptance test (see "Offline in-app
> navigation" below) and should be confirmed on a phone/preview before it's
> called field-proven. Do not read "shipped" above as "field-validated".

## The model (network-first read cache)

- **Pages** — a `/phil/*` navigation is **network-first**: online the worker
  always gets the live page (network-first is what stops old layouts
  resurrecting). A clone of each *successful, non-redirected, same-path* page is
  stored in `buhl-sw-vN-pages`. Offline, the worker is served their last-seen
  copy of **the same URL**, else the self-contained `/offline.html` fallback.
- **Assets** — same-origin `/_next/static/*` (immutable, content-hashed build
  chunks) are **cache-first** in `buhl-sw-vN-assets`, so a cached page renders
  styled and interactive offline.
- **Everything else is NOT intercepted** — APIs, cross-origin Blob photos, other
  origins. No stale API data is ever served (constitution **P8**: degrade
  honestly from cache, never a blank screen, never *wrong* data).

## What is deliberately NOT cached

- API responses / `/api/*` (always live or honestly unavailable).
- **RSC / App-Router flight payloads** (the `?_rsc=` / `RSC: 1` fetches a Next
  `<Link>` soft-nav issues) — caching these would grow the stale-data surface and
  fight the no-API-data model. See "Offline in-app navigation" below for how we
  reach cached *documents* without caching flight.
- Cross-origin resources, including Blob-hosted photos.
- Non-`GET` requests.
- **Auth redirects** — see P1b below.
- Non-2xx responses.

## Offline in-app navigation (#575 follow-up — `PhilOfflineLink`)

The SW only caches/serves pages for **real document navigations**
(`request.mode === 'navigate'` — initial load, reload, `window.location.assign`).
A Next.js `<Link>` tap does a **client-side App-Router/RSC navigation**, which is
*not* a document request, so the SW neither populates nor serves the page cache
for it. Two consequences, both fixed here (found while validating PR #597 — reload
and history worked offline, but tapping My Day → Jobs → Job did not):

- **Retrieval gap:** offline, a `<Link>` tap fires an RSC `fetch` the SW doesn't
  intercept → a dead tap (no cached doc, no fallback).
- **Population gap:** online, a page reached *only* by soft-nav is never written
  to the page cache, so it isn't there to serve offline later.

**`PhilOfflineLink`** (`src/components/phil/PhilOfflineLink.tsx`) is a drop-in
`<Link>` replacement for Phil internal navigation that renders an identical
anchor and decides at click time via the pure
`decidePhilLinkNavigation` (`src/domains/phil/offline-link.ts`):

- **offline →** `preventDefault()` + `window.location.assign(href)` — a real
  document navigation the SW serves from `buhl-sw-vN-pages` (or `/offline.html`).
- **online →** behave like a normal `<Link>` (snappy soft-nav) **and**
  fire-and-forget `warmPhilPageCache(href)` (`src/domains/phil/page-cache.ts`),
  which fetches the destination **HTML document** and stores it in the same
  `'-pages'` cache the SW uses — reusing the exact `shouldCachePhilPage` guard so
  an auth redirect is never warmed in, and **never** fetching RSC/flight or API.
- Modified / middle / new-tab clicks, non-`_self` targets and object hrefs are
  left entirely to the browser.

Wired on **every** navigational Phil internal link: the tab bar (`PhilTabBar`),
jobs list rows (`PhilJobsList`), all back links (`PhilBackLink`), the My Day hero
(`PhilMyDayHero`) and Needs-you feed (`PhilNeedsYouFeed`), job detail + its
in-body panels (`PhilJobDetail`, `PhilJobCommandPanel` route links,
`JobItpPanel`, `JobTagsPanel`), the week strip/summary (`PhilWeekStrip`,
`PhilWeekSummary`) and the ITP recording back link (`ITPRecording`). The only
`next/link` left is inside `PhilOfflineLink` itself; in-page `#` anchors stay
plain `<a>`. **No SW change** — the SW's existing navigate handling already serves
the forced document navigation; this is purely the client reaching it.

The "More" tab (`/v2/phil`, a non-`/phil` route) is wrapped too: offline it
hard-navigates to the honest `/offline.html` card (the SW only caches `/phil/*`),
which is better than a dead RSC soft-nav; online the warm is a no-op (it guards
`/phil/*`).

**Manual acceptance test (the in-app tap path — must pass before merge):**

1. Online: open `/phil/my-day`.
2. Tap through to `/phil/jobs`, then tap into a job (normal UI taps).
3. Go offline (DevTools → Network → Offline, or airplane mode).
4. Navigate around inside the job via the in-app links.
5. Tap **back** to My Day.
6. Tap **forward** into the same job again **from the normal UI**.
7. Expected: the cached job page opens — **not** a dead navigation, **not** the
   login page. A page never opened online shows the `/offline.html` "No signal"
   card.

## Cache scoping & cross-user privacy (#575 P1a)

The page cache holds the signed-in worker's rendered pages **keyed by URL only**.
A shared site phone must never serve worker A's cached pages to worker B.

**The SW cannot identify the viewer offline.** The session cookie (`buhl_session`)
is **httpOnly**, so the service worker can't read it, and offline there is no
server to ask. URL-keying alone therefore cannot partition by user inside the SW.

**Guarantee instead: the cache is wiped at every session boundary**, so it only
ever holds the *current* login session's pages.

- `purgePhilPageCaches()` (`src/domains/phil/page-cache.ts`) deletes every
  `*-pages` cache. Best-effort, SSR-safe, never throws.
- Called on **sign-out** (`PhilSignOutButton`) **and on successful sign-in**
  (`login-form`). **Sign-in is the load-bearing hook**: a different worker can
  only take over the device by logging in, and that login purges the previous
  worker's pages — so the guarantee holds **even when no explicit sign-out ran**
  (cookie expiry, app kill). Sign-out purge remains as the clean-exit path.
- A **SW version bump** additionally drops the prior version's `*-pages` cache
  fleet-wide on `activate` (defense in depth).

**Residual, documented, out of scope:** if worker B uses worker A's *still-valid*
session without logging in (shared unlocked phone, no session change), B sees A's
pages — but B also sees A's *live* pages online; this is a device-lock / session-
sharing problem, not a cache leak, and no cache scoping can address it.

**Why not per-user cache names / response-header stamping?** Both need a viewer
id the SW can trust. The only authoritative source is a server response header
(the httpOnly cookie is unreadable in the SW), which means touching middleware
and persisting an "active viewer" across SW restarts to use it offline. Purge-at-
session-boundary achieves the same privacy guarantee with no auth/middleware
change and the strongest posture (it *destroys* the other worker's data rather
than partitioning it). Header-stamped per-user caches remain a possible future
hardening if the cache is ever extended to survive across logins.

## Auth-redirect caching prevention (#575 P1b)

On a `/phil/*` navigation with an **invalid session**, middleware (`src/middleware.ts`)
`redirect`s to `/v2/login`. A navigation `fetch()` **follows** the redirect, so
`response.ok` is `true` — caching naively would store the **login page under
`/phil/my-day`** and serve it offline as the worker's day screen.

`shouldCachePhilPage()` gates caching: a response is cached **only if** it is
`ok`, **not** `redirected`, same-origin, and its final pathname **equals** the
requested path. The redirect to `/v2/login` fails on both `redirected` and the
path check — fail closed.

## Cache growth bounds (#575 P2)

Both runtime caches are FIFO-bounded (oldest evicted first; `caches.keys()` is
insertion-ordered):

- `PAGE_CACHE_MAX = 40` pages.
- `ASSET_CACHE_MAX = 120` assets — generous relative to the page bound so a
  cached page keeps its (shared, immutable) `/_next/static` chunks and still
  renders styled offline, while a long-lived field device can't grow the asset
  cache without bound.

## SW_VERSION bump rule (#575 P3 — corrected)

`scripts/check-sw-cache-version.js` forces a `SW_VERSION` bump **only when
`public/sw.js` itself changes** — a normal app/page deploy does **not** roll
these caches. That is safe precisely *because* the read cache is network-first:
page content is always live online regardless of cache version. The version bump
exists to drop stale SW **behaviour** (and its caches) when `sw.js` changes, and
to keep fleet rollout auditable. (The earlier header comment implying "a deploy
bumps SW_VERSION → activate drops the old ones" was misleading and has been
corrected.)

## Push is unchanged

`public/sw.js` also owns Web Push (`push` + `notificationclick` + deep links).
Installed field/admin devices hold live `PushSubscription`s registered against
this exact `/sw.js` URL. **Do not move or delete the file**; preserve the push
handlers. The #575 fixes touch only the fetch/caching path.

## Offline write / outbox — NOT implemented (decision)

No offline mutation/outbox was added in the #575 work. The current write client
(`philWrite`) is the honest, network-only baseline: one definite outcome per
write, surfaced for one-tap retry, nothing pretended-saved (P8).

A first outbox action is gated on a genuinely replay-safe end-to-end path **with
a clear field entry point**:

| Candidate | Server replay safety | Blocker for an offline outbox |
|---|---|---|
| Observation / field note | idempotency wired (`observations-create-idempotency-api.test.ts`) | needs a **text-only** Phil entry point (capture is photo-first) + confirm the idempotency key flows through the queued replay |
| Task toggle | state-set, naturally idempotent-ish | confirm a replayed toggle can't produce a false success state |
| Evidence / photo | evidence-create idempotency wired (`api/evidence.js`) | the **Blob upload** side effect is **not** idempotent — replay double-uploads; not safe end-to-end |
| Hours | per `phil-write-idempotency.md` | confirm idempotency before any queue |

**Recommended first tranche:** a durable (IndexedDB) **field-note outbox** built
on `philWrite`, once a text-only observation entry point exists and the
idempotency key is threaded through replay. Tracked under
[#499](https://github.com/oskar-ott/BuhlOS/issues/499) /
[#498](https://github.com/oskar-ott/BuhlOS/issues/498) /
[#143](https://github.com/oskar-ott/BuhlOS/issues/143) /
[#158](https://github.com/oskar-ott/BuhlOS/issues/158). It must use IndexedDB
(not localStorage), carry an idempotency key + sync status per item, never report
optimistic permanent success, and keep failed items visible/retryable.

## Constitution impact

This is a **read-cache safety fix**, not a constitutional or task-model change.

- **Existing principle (P8 — interruption is the environment):** "degrade
  honestly from cache, never a blank screen." The fixes *strengthen* P8 by
  ensuring the cache never serves **wrong** content (another worker's pages, or a
  login screen masquerading as the day page).
- **Task-led architecture:** untouched. The cache is a URL-keyed projection of
  rendered page HTML — it does not read, write, or deepen area-owned task arrays,
  and makes no `taskInstanceId` / per-task-proof claims.
- **Docs to update:** this file (new). `public/sw.js` header comment and
  `scripts/check-sw-cache-version.js` comment corrected in place.
- **Wiki impact:** behaviour change to Phil offline caching → **wiki sync
  required after merge** (the wiki-touch rule), not before.
