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
