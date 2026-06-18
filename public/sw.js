// Service worker for the Phil PWA (buhl electrical field app).
//
// Responsibilities:
//   - Enable "Add to Home Screen" / standalone install
//   - Handle Web Push notifications + click-to-open deep links
//   - Purge every legacy static-shell cache left behind by the
//     pre-cutover service worker (v1–v8 cached the old /admin shell)
//
// v10 (#135 Layer 1 — honest offline fallback): the modern Next.js app
// still ships its own immutable /_next/static assets (the browser HTTP
// cache handles those), and this worker STILL never serves modern HTML or
// shell JS from a cache — that is exactly how the old layouts kept
// resurrecting after deploys. The ONE thing it now caches is a single
// self-contained fallback page (/offline.html, no external assets): when a
// navigation fails with no signal, the worker serves it instead of the
// browser's dead-dinosaur error (constitution P8 — degrade honestly, never
// a blank screen). Caching last-loaded job/my-day/plans data is the
// separate Layer 2; this layer carries no user data and no stale-API risk.
//
// The activate handler deletes every OTHER cache (buhl-shell-v1..v8 and any
// prior sw cache), keeping only the current version's fallback cache, so
// stale shells still come clean on first fetch of this version.
//
// Push stays: the daily hour-reminder crons, office-inbox fan-out and
// snag digests (api/notifications.js) deliver through this worker, and
// existing field/admin devices hold live PushSubscriptions registered
// against this exact script URL. Keep this file at /sw.js — moving or
// deleting it orphans those subscriptions.
//
// Bump SW_VERSION on any behavioural change so the byte-diff update
// check rolls the fleet (scripts/check-sw-cache-version.js enforces).
const SW_VERSION = 'buhl-sw-v10';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  // Precache only the self-contained offline fallback, then take over.
  event.waitUntil(caches.open(SW_VERSION).then((cache) => cache.add(OFFLINE_URL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop every cache except this version's (clears buhl-shell-v1..v8 and
    // any prior sw cache); modern HTML/JS is still never served from cache.
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== SW_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Fetch: network-first for NAVIGATIONS only, with the offline page as the
// sole cached fallback. Non-navigation requests (assets, API) are never
// intercepted — they go straight to the network exactly as before, so no
// stale HTML/JS/API data can be served. Online behaviour is unchanged.
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request).catch(async () => {
      const cache = await caches.open(SW_VERSION);
      return (await cache.match(OFFLINE_URL)) || Response.error();
    }),
  );
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
