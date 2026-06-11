// Service worker for the Phil PWA (buhl electrical field app).
//
// Responsibilities:
//   - Enable "Add to Home Screen" / standalone install
//   - Handle Web Push notifications + click-to-open deep links
//   - Purge every legacy static-shell cache left behind by the
//     pre-cutover service worker (v1–v8 cached the old /admin shell)
//
// v9 (legacy-interface cutover): the legacy static surfaces (the old
// login/my-day pages, the old admin suite and its shared shell JS) were
// REMOVED from the product — old URLs now 307-redirect to the modern
// BuhlOS/Phil routes (see vercel.json + docs/route-ownership.md §6).
// This worker therefore caches NOTHING:
//   - the modern Next.js app ships its own immutable /_next/static
//     assets, which the browser HTTP cache handles fine;
//   - serving any HTML or shell JS from a SW cache is exactly how the
//     old layouts kept resurrecting after deploys. Never again.
// The activate handler deletes every cache this origin has ever made,
// so devices still carrying a buhl-shell-v1..v8 cache come clean the
// first time they fetch this version.
//
// Push stays: the daily hour-reminder crons, office-inbox fan-out and
// snag digests (api/notifications.js) deliver through this worker, and
// existing field/admin devices hold live PushSubscriptions registered
// against this exact script URL. Keep this file at /sw.js — moving or
// deleting it orphans those subscriptions.
//
// Bump SW_VERSION on any behavioural change so the byte-diff update
// check rolls the fleet (scripts/check-sw-cache-version.js enforces).
const SW_VERSION = 'buhl-sw-v9';

self.addEventListener('install', () => {
  // No precache. Take over from the legacy worker immediately.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Purge EVERY cache (buhl-shell-v1..v8 and anything else) — the
    // modern app must never be served from a SW cache.
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// No fetch handler: every request — navigations, assets, API — goes
// straight to the network. (A SW without a fetch listener never
// intercepts requests; install/push capability is unaffected.)

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
