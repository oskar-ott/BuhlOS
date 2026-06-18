// Service worker for the Phil PWA (buhl electrical field app).
//
// Responsibilities:
//   - Enable "Add to Home Screen" / standalone install
//   - Handle Web Push notifications + click-to-open deep links
//   - Purge every legacy static-shell cache left behind by the
//     pre-cutover service worker (v1–v8 cached the old /admin shell)
//
// v11 (#135 Layer 2 — offline read cache): the worker is push-only PLUS a
// NETWORK-FIRST offline read cache for the field worker's own pages. When
// online, navigations always return the live network response (never stale —
// network-first is what keeps the old layouts from resurrecting); a clone of
// each successful /phil/* page and the immutable /_next/static assets it
// pulls is stored per-device. When offline, the worker serves that worker's
// last-seen copy of THE SAME page (styled + readable), or the self-contained
// /offline.html fallback if the page was never opened. Non-navigation app/API
// requests (and anything cross-origin, e.g. Blob photos) are never
// intercepted, so no stale API data is served (constitution P8 — degrade
// honestly from cache, never a blank screen).
//
// Caches are version-scoped (a deploy bumps SW_VERSION → activate drops the
// old ones) AND the page cache is purged on sign-out by the client (it deletes
// any '-pages' cache) so a shared device never serves the previous worker's
// pages. The activate handler also clears every legacy buhl-shell-v1..v8 cache.
//
// Push stays: the daily hour-reminder crons, office-inbox fan-out and
// snag digests (api/notifications.js) deliver through this worker, and
// existing field/admin devices hold live PushSubscriptions registered
// against this exact script URL. Keep this file at /sw.js — moving or
// deleting it orphans those subscriptions.
//
// Bump SW_VERSION on any behavioural change so the byte-diff update
// check rolls the fleet (scripts/check-sw-cache-version.js enforces).
const SW_VERSION = 'buhl-sw-v11';
const OFFLINE_URL = '/offline.html';
// Per-version runtime caches (#135 Layer 2). Version-scoped so a deploy drops
// them; PAGE_CACHE is also purged on sign-out (client deletes any '-pages').
const PAGE_CACHE = SW_VERSION + '-pages';
const ASSET_CACHE = SW_VERSION + '-assets';
const PAGE_CACHE_MAX = 40; // bound growth — FIFO-trim the oldest cached page

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

async function cachePage(request, response) {
  const cache = await caches.open(PAGE_CACHE);
  await cache.put(request, response);
  const keys = await cache.keys();
  // keys() is insertion-ordered → deleting the front is FIFO eviction.
  for (let i = 0; i < keys.length - PAGE_CACHE_MAX; i += 1) await cache.delete(keys[i]);
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
        if (isPhil && response && response.ok) {
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
      if (response && response.ok) event.waitUntil(cache.put(request, response.clone()));
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
