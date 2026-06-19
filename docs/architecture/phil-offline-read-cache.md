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
> **Validation status (#575):** the pure cache-policy predicates
> (`shouldCachePhilPage` / `overflowCount`) and the sw.js drift-guard tokens are
> **unit-tested**, and `check`/`build`/`check:sw-cache-version` are green. The
> **live service-worker runtime** — offline serving on an installed PWA,
> auth-redirect non-caching on a real navigation `fetch`, and cross-session purge
> on a shared device — is **not exercisable by `next dev` or the test suite** and
> is **still owed a manual DevTools/airplane validation on a PR preview** before
> it can be called field-proven. Do not read "shipped" above as "field-validated".

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
- Cross-origin resources, including Blob-hosted photos.
- Non-`GET` requests.
- **Auth redirects** — see P1b below.
- Non-2xx responses.

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
