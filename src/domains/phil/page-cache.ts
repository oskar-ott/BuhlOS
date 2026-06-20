import { shouldCachePhilPage } from "./sw-cache-policy";

// Session-boundary purge for the offline read cache (#135 Layer 2, #575 P1a).
//
// The service worker caches the worker's own /phil/* pages per-device so they
// open offline. That cache MUST be cleared at every session boundary, or a
// shared site phone would serve the previous worker's pages to the next person —
// a privacy leak. Called at BOTH:
//   * sign-out (PhilSignOutButton), and
//   * successful sign-in (login-form) — the load-bearing hook, because a new
//     worker can only take over by logging in, so this runs even when no
//     explicit sign-out happened (cookie expiry, app kill).
// We match the SW's runtime page cache by its '-pages' suffix (buhl-sw-vN-pages)
// so this keeps working across SW version bumps. Best-effort and SSR-safe: it
// never throws and never blocks the flow it's called from.

export async function purgePhilPageCaches(
  cacheStorage: CacheStorage | undefined = typeof caches !== "undefined" ? caches : undefined
): Promise<void> {
  if (!cacheStorage) return;
  try {
    const keys = await cacheStorage.keys();
    await Promise.all(
      keys.filter((k) => k.endsWith("-pages")).map((k) => cacheStorage.delete(k))
    );
  } catch {
    // Best-effort — a purge failure must never strand the worker on sign-out.
  }
}

// Warm a Phil page document into the SW's read cache so it's available offline
// later (#575 follow-up — the soft-nav population gap).
//
// The SW only caches /phil/* pages on REAL document navigations, so pages a
// worker only ever reached via Next <Link> soft-nav are never cached — and so
// can't be served offline. When PhilOfflineLink is tapped ONLINE it calls this
// to fetch the destination's HTML document and store it in the same
// version-scoped '-pages' cache the SW uses (found by suffix, like the purge
// above — the client can't read the httpOnly SW_VERSION). We reuse the exact
// shouldCachePhilPage guard so an auth redirect (→ /v2/login) is never warmed
// into a protected URL, and we never fetch RSC/flight or API data (HTML only),
// keeping the #575 "no API/data cache" model intact. Best-effort: never throws.

export interface WarmPhilPageDeps {
  cacheStorage?: CacheStorage;
  fetchImpl?: typeof fetch;
  origin?: string;
}

export async function warmPhilPageCache(href: string, deps: WarmPhilPageDeps = {}): Promise<void> {
  const cacheStorage = deps.cacheStorage ?? (typeof caches !== "undefined" ? caches : undefined);
  const doFetch = deps.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : undefined);
  const origin = deps.origin ?? (typeof location !== "undefined" ? location.origin : undefined);
  if (!cacheStorage || !doFetch || !origin) return;
  try {
    const url = new URL(href, origin);
    // Only ever warm same-origin /phil/* documents.
    if (url.origin !== origin || !url.pathname.startsWith("/phil/")) return;
    const keys = await cacheStorage.keys();
    // Write into the SW's current page cache. activate prunes to one '-pages'
    // cache per version; if the SW hasn't created it yet, skip (the next real
    // navigation will cache the page anyway).
    const pagesName = keys.find((k) => k.endsWith("-pages"));
    if (!pagesName) return;
    const cache = await cacheStorage.open(pagesName);
    // Already cached → leave it (the live page is network-first online; cached
    // copies refresh on a real navigation/reload). Avoids redundant fetches.
    if (await cache.match(url.href)) return;
    const res = await doFetch(url.href, { credentials: "same-origin" });
    const safe = shouldCachePhilPage({
      requestPath: url.pathname,
      responseUrl: res.url,
      origin,
      ok: res.ok,
      redirected: res.redirected,
    });
    if (safe) await cache.put(url.href, res);
  } catch {
    // Best-effort — warming is an optimisation; a failure must never surface.
  }
}
