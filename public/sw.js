// Service worker for the Phil PWA (buhl electrical field app).
//
// Responsibilities:
//   - Enable "Add to Home Screen" / standalone install
//   - Handle Web Push notifications + click-to-open deep links
//   - Purge every legacy static-shell cache left behind by the
//     pre-cutover service worker (v1–v8 cached the old /admin shell)
//
// v12 (#135 Layer 2 — offline read cache; #575 safety fixes): the worker is
// push-only PLUS a NETWORK-FIRST offline read cache for the field worker's own
// pages. When online, navigations always return the live network response
// (never stale — network-first is what keeps the old layouts from resurrecting);
// a clone of each successful, NON-redirected, same-path /phil/* page and the
// immutable /_next/static assets it pulls is stored per-device. When offline,
// the worker serves that worker's last-seen copy of THE SAME page (styled +
// readable), or the self-contained /offline.html fallback if the page was never
// opened. Non-navigation app/API requests (and anything cross-origin, e.g. Blob
// photos) are never intercepted, so no stale API data is served (constitution
// P8 — degrade honestly from cache, never a blank screen).
//
// Cross-user privacy on a shared site phone (#575 P1a): the page cache holds the
// signed-in worker's rendered pages keyed by URL, so it MUST be wiped at every
// session boundary. The client purges it on BOTH sign-out and successful sign-in
// (purgePhilPageCaches → deletes any '-pages' cache). Sign-in is the load-
// bearing hook: a different worker can only take over by logging in, and that
// login wipes the previous worker's pages even when no explicit sign-out ran
// (cookie expiry, app kill). The SW itself can't read the httpOnly session
// cookie, so it can't identify the viewer offline — the purge-at-login boundary
// is what guarantees the cache only ever holds the current worker's pages. A
// version bump (below) also drops the prior version's '-pages' cache fleet-wide.
//
// Auth-redirect safety (#575 P1b): a /phil/* navigation on an invalid session is
// redirected to /v2/login; fetch FOLLOWS it (response.ok === true), so we gate
// caching on shouldCachePhilPage() — non-redirected + same-path only — to never
// store the login page under a protected Phil URL.
//
// Caches are version-scoped. NOTE: a normal app/page deploy does NOT roll these
// caches — scripts/check-sw-cache-version.js only forces a SW_VERSION bump when
// public/sw.js itself changes. Network-first means page content is always live
// online regardless; the version bump exists to drop stale SW *behaviour* and
// its caches when this file changes. The activate handler clears every other
// cache (prior sw versions + legacy buhl-shell-v1..v8 static shells).
//
// Push stays: the daily hour-reminder crons, office-inbox fan-out and
// snag digests (api/notifications.js) deliver through this worker, and
// existing field/admin devices hold live PushSubscriptions registered
// against this exact script URL. Keep this file at /sw.js — moving or
// deleting it orphans those subscriptions.
//
// Bump SW_VERSION on any behavioural change so the byte-diff update
// check rolls the fleet (scripts/check-sw-cache-version.js enforces).
const SW_VERSION = 'buhl-sw-v12';
const OFFLINE_URL = '/offline.html';
// Per-version runtime caches (#135 Layer 2). Version-scoped so a SW change drops
// them; PAGE_CACHE is also purged at sign-in/sign-out (client deletes '-pages').
const PAGE_CACHE = SW_VERSION + '-pages';
const ASSET_CACHE = SW_VERSION + '-assets';
const PAGE_CACHE_MAX = 40; // bound growth — FIFO-trim the oldest cached page
const ASSET_CACHE_MAX = 120; // #575 P2: bound the asset cache too (was unbounded)
// — generous vs PAGE_CACHE_MAX so a cached page keeps its (shared, immutable)
// /_next/static chunks and still renders styled offline.

self.addEventListener('install', (event) => {
  // Precache only the self-contained offline fallback, then take over.
  event.waitUntil(caches.open(SW_VERSION).then((cache) => cache.add(OFFLINE_URL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Keep this version's caches (fallback + pages + assets); drop everything
    // else (buhl-shell-v1..v8 and any prior sw version), so stale shells and
    // stale cached pages come clean on first fetch of this version.
    const keep = new Set([SW_VERSION, PAGE_CACHE, ASSET_CACHE]);
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// FIFO-trim a cache to `max` entries. keys() is insertion-ordered, so deleting
// from the front evicts the oldest (mirrors overflowCount() in
// src/domains/phil/sw-cache-policy.ts).
async function trimCache(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i += 1) await cache.delete(keys[i]);
}

async function cachePage(request, response) {
  const cache = await caches.open(PAGE_CACHE);
  await cache.put(request, response);
  await trimCache(PAGE_CACHE, PAGE_CACHE_MAX);
}

// MIRROR of shouldCachePhilPage() in src/domains/phil/sw-cache-policy.ts — this
// plain SW script can't import app modules. Keep the two in lockstep and bump
// SW_VERSION on any change. #575 P1b: only cache a successful, non-redirected,
// same-origin, same-path /phil/* document, so an auth redirect to /v2/login is
// never stored under the protected Phil URL.
function shouldCachePhilPage(requestUrl, response) {
  if (!response || !response.ok || response.redirected) return false;
  let finalUrl;
  try { finalUrl = new URL(response.url); } catch (e) { return false; }
  if (finalUrl.origin !== self.location.origin) return false;
  return finalUrl.pathname === requestUrl.pathname;
}

// Fetch strategy (GET only):
//   1. /phil/* navigations → NETWORK-FIRST: live page when online (+ cache a
//      clone per-device); offline → that worker's last-seen copy of this page,
//      else /offline.html.
//   2. same-origin /_next/static/* (immutable hashed build assets) → CACHE-
//      FIRST, so a cached page renders styled + interactive offline.
//   Everything else (APIs, cross-origin Blob photos, other origins) is NOT
//   intercepted — no stale API data is ever served.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  let url;
  try { url = new URL(request.url); } catch (e) { return; }
  const sameOrigin = url.origin === self.location.origin;

  if (request.mode === 'navigate') {
    const isPhil = sameOrigin && url.pathname.startsWith('/phil/');
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (isPhil && shouldCachePhilPage(url, response)) {
          event.waitUntil(cachePage(request, response.clone()));
        }
        return response;
      } catch (e) {
        if (isPhil) {
          const cached = await caches.open(PAGE_CACHE).then((c) => c.match(request));
          if (cached) return cached;
        }
        const fallback = await caches.open(SW_VERSION).then((c) => c.match(OFFLINE_URL));
        return fallback || Response.error();
      }
    })());
    return;
  }

  if (sameOrigin && url.pathname.startsWith('/_next/static/')) {
    event.respondWith((async () => {
      const cache = await caches.open(ASSET_CACHE);
      const hit = await cache.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      if (response && response.ok) {
        // Cache then FIFO-trim so a long-lived field device can't grow the
        // immutable-asset cache without bound (#575 P2).
        event.waitUntil(
          cache.put(request, response.clone()).then(() => trimCache(ASSET_CACHE, ASSET_CACHE_MAX)),
        );
      }
      return response;
    })());
  }
});

// ── Push: show a notification ───────────────────────────────
// Server (api/notifications.js) posts JSON like:
//   { title: '...', body: '...', url: '/phil/my-day?fixDate=...' }
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: 'buhl', body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || 'buhl electrical';
  const options = {
    body: payload.body || '',
    // Purpose-built PWA icons render correctly in Android's notification
    // surface; 192 for the main icon, 192 again for badge — Android
    // scales down for the tiny badge spot. iOS Safari ignores both.
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: payload.tag || 'buhl-reminder',
    renotify: true,
    requireInteraction: false,
    data: { url: payload.url || '/phil/my-day' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// ── Notification click: focus existing tab, or open deep link ───
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/phil/my-day';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      // Reuse an existing buhl tab if present.
      try {
        const u = new URL(client.url);
        if (u.origin === self.location.origin) {
          await client.focus();
          if ('navigate' in client) {
            client.navigate(targetUrl).catch(() => {});
          }
          return;
        }
      } catch (e) { /* ignore */ }
    }
    await self.clients.openWindow(targetUrl);
  })());
});
