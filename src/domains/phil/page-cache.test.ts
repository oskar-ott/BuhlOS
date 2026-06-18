import { describe, expect, it, vi } from "vitest";

import { purgePhilPageCaches } from "./page-cache";

/**
 * Sign-out purge of the offline page cache (#135 Layer 2). A fake CacheStorage
 * is injected — only the '-pages' cache(s) must be deleted, never the offline
 * fallback precache or the asset cache.
 */
function fakeCacheStorage(keys: string[]) {
  const deleted: string[] = [];
  const cs = {
    keys: async () => keys,
    delete: async (k: string) => {
      deleted.push(k);
      return true;
    },
  } as unknown as CacheStorage;
  return { cs, deleted };
}

describe("purgePhilPageCaches", () => {
  it("deletes only the '-pages' cache(s), leaving the fallback + asset caches", async () => {
    const { cs, deleted } = fakeCacheStorage([
      "buhl-sw-v11",
      "buhl-sw-v11-pages",
      "buhl-sw-v11-assets",
      "buhl-sw-v10-pages",
    ]);
    await purgePhilPageCaches(cs);
    expect(deleted.sort()).toEqual(["buhl-sw-v10-pages", "buhl-sw-v11-pages"]);
  });

  it("is a no-op when CacheStorage is unavailable (SSR)", async () => {
    await expect(purgePhilPageCaches(undefined)).resolves.toBeUndefined();
  });

  it("never throws if the cache API rejects (best-effort)", async () => {
    const cs = {
      keys: async () => {
        throw new Error("nope");
      },
      delete: vi.fn(),
    } as unknown as CacheStorage;
    await expect(purgePhilPageCaches(cs)).resolves.toBeUndefined();
  });
});
