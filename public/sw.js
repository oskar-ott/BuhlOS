// Service worker for buhl PWA.
//
// Responsibilities:
//   - Enable "Add to Home Screen" / standalone install
//   - Handle Web Push notifications + click-to-open deep links
//   - Stale-while-revalidate cache for the admin static shell (HTML +
//     CSS + JS) so cold-start admin loads paint chrome from cache
//     while the network fetches a fresh copy in the background.
//
// API responses are intentionally NEVER cached — the app is online-
// first, and stale API data would be worse than an honest "no
// connection". Only static-shell assets sit in this cache: the admin
// HTML pages, _shell.css/.js, and the components / theme that the
// shell loads on every admin page.

// Bump on any change to the static-shell asset list or admin shell JS
// behaviour so the activate handler purges old caches and the next
// fetch re-pulls fresh. Reports of "blank /admin/operations" after
// the perf-pass landings traced to SW serving stale _shell.js from
// the v1 cache; bumping to v2 forces a clean refresh.
//
// v3 (PR #234 follow-up): _shell.js gained the auto-boot fallback and
// blank-shell detector, and operations.html / activity.html / cash.html
// / materials.html each gained the previously-missing SHELL.boot()
// call. Existing clients on the v2 cache still served the pre-fix
// _shell.js out of cache → blank page persisted post-deploy. Bumping
// to v3 invalidates the stale cache. Going forward, predeploy guard
// (scripts/check-sw-cache-version.js) refuses to ship if shell files
// change without a CACHE_VERSION bump.
//
// v4 (production-admin-shell integration): operations.html is now the
// BuhlOS Command Centre SPA (replacing the site-office shell at that
// path). _shell.js still serves the other admin pages but the shape
// of what's at /admin/operations changed entirely. Bumping invalidates
// any cache that has the old site-office operations.html cached.
// v5 (admin real-product buildout): operations.html grew the sidebar
// count badges, mock-data fallback (admin-data.js), and full v1 modules
// for Job Builder / ITP / Plans / Variations with their renderers and
// state-chip CSS. SPA contract unchanged but bundle is materially bigger.
//
// v6 (admin-tools v2, SPA layer): Job Builder gained job-setup panel +
// validation + independent-review toggle. ITP gained dashboard + review
// modal + the itp_review_self rule + needs_info status. Plans gained
// drawing #, type, area/stage linking, upload UC, Phil-readiness toggle.
// Variations gained creation modal + invoiced status + source/builder-ref.
// Reports went from dead UC tiles to honest computed metrics + Builder
// performance.
//
// v7 (admin-tools v2 merge of #240 + #241): the per-page admin tools
// (job-builder/itp/plans/variations/reports.html) now ALSO have real
// implementations via _shell.js (from #240). Both architectures coexist:
// per-page tools at /admin/<name> use the site-office shell; the SPA
// at /admin/operations holds the same v2 tools as internal tabs.
const CACHE_VERSION = 'buhl-shell-v7';
const STATIC_SHELL = [
  // Admin shell — every admin page boot needs these. Caching them
  // means cold loads paint sidebar + topbar from disk while the
  // network roundtrip lands fresh CSS/JS in the background.
  '/admin/_shell.css',
  '/admin/_shell.js',
  // Theme + key brand assets — used everywhere.
  '/theme.css',
  '/manifest.json',
  '/BUHL_LOGO.png',
  '/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE_VERSION);
      await cache.addAll(STATIC_SHELL);
    } catch (e) {
      // Pre-cache failure shouldn't block install — the SW still
      // ships push handling and the fetch handler falls back to
      // network for any URL that isn't in cache.
      console.warn('SW pre-cache failed', e && e.message);
    }
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Purge old shell caches when CACHE_VERSION bumps.
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k.startsWith('buhl-shell-') && k !== CACHE_VERSION)
          .map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// Cache strategy:
//   - GET requests to STATIC_SHELL paths: cache-first, revalidate in
//     the background (stale-while-revalidate)
//   - Everything else (API, dynamic content, photos, etc.): pass
//     through to network with no caching
//
// We deliberately don't cache HTML pages themselves — they're tiny
// and serving stale HTML can leak old role gates or routing logic.
// Only the shared CSS/JS that every admin page loads is cached.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // Only intercept same-origin requests for the static shell list.
  if (url.origin !== self.location.origin) return;
  if (!STATIC_SHELL.includes(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(event.request);
    // Kick off a background refresh so the next page load gets fresh.
    const network = fetch(event.request).then(res => {
      // Only cache successful responses. Errors fall through.
      if (res && res.ok) cache.put(event.request, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);
    if (cached) return cached;
    // First visit: no cached copy. Wait for the network response.
    const fresh = await network;
    return fresh || new Response('', { status: 504, statusText: 'offline' });
  })());
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
