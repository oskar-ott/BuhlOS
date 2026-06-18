// Sign-out purge for the offline read cache (#135 Layer 2).
//
// The service worker caches the worker's own /phil/* pages per-device so they
// open offline. On sign-out that cache MUST be cleared, or a shared site phone
// would serve the previous worker's pages to the next person — a privacy leak.
// We match the SW's runtime page cache by its '-pages' suffix (buhl-sw-vN-pages)
// so this keeps working across SW version bumps. Best-effort and SSR-safe: it
// never throws and never blocks sign-out.

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
