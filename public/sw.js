// Minimal service worker for buhl PWA:
//   - Enables "Add to Home Screen" / standalone install
//   - Handles Web Push notifications + click-to-open deep link
//
// No offline caching yet (intentional — the app is online-first; stale data
// would be worse than an honest "no connection"). Future: cache /theme.css
// and logo for cold-start paint, never API responses.

self.addEventListener('install', (event) => {
  // Activate this SW immediately — we don't gate anything behind old versions.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// ── Push: show a notification ───────────────────────────────
// Server (api/notifications.js send-daily-reminders) posts JSON like:
//   { title: '...', body: '...', url: '/my-day?openHours=1' }
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
    // surface; the header logo (BUHL_LOGO.png) is too tall and gets cropped.
    // 192 for the main icon, 192 again for badge — Android scales down for
    // the tiny badge spot. iOS Safari ignores both at present.
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: payload.tag || 'buhl-reminder',
    renotify: true,
    requireInteraction: false,
    data: { url: payload.url || '/my-day?openHours=1' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// ── Notification click: focus existing tab, or open deep link ───
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/my-day';
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
