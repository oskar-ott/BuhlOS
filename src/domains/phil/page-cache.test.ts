import { describe, expect, it, vi } from "vitest";

import { purgePhilPageCaches, warmPhilPageCache } from "./page-cache";

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

/**
 * Cache-warm of a Phil page document (#575 follow-up — the soft-nav population
 * gap). A fake CacheStorage + fetch are injected; warming must write the
 * destination HTML into the SW's '-pages' cache, but only for a safe,
 * non-redirected, same-path /phil/* document (the shouldCachePhilPage guard).
 */
const ORIGIN = "https://buhlos.com";

function fakeCacheEnv(cacheNames: string[], seed: Array<{ name: string; url: string }> = []) {
  const stores = new Map<string, Map<string, unknown>>();
  for (const n of cacheNames) stores.set(n, new Map());
  for (const s of seed) stores.get(s.name)?.set(s.url, { seeded: true });
  const putCalls: Array<{ cache: string; url: string }> = [];
  const cacheStorage = {
    keys: async () => [...stores.keys()],
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name)!;
      return {
        match: async (url: string) => m.get(url),
        put: async (url: string, res: unknown) => {
          m.set(url, res);
          putCalls.push({ cache: name, url });
        },
      };
    },
  } as unknown as CacheStorage;
  return { cacheStorage, putCalls };
}

function fakeFetch(res: { ok: boolean; redirected: boolean; url: string }) {
  return vi.fn(async () => res as unknown as Response) as unknown as typeof fetch;
}

describe("warmPhilPageCache", () => {
  it("warms a valid, non-redirected, same-path /phil page into the '-pages' cache", async () => {
    const { cacheStorage, putCalls } = fakeCacheEnv([
      "buhl-sw-v12",
      "buhl-sw-v12-pages",
      "buhl-sw-v12-assets",
    ]);
    const fetchImpl = fakeFetch({ ok: true, redirected: false, url: `${ORIGIN}/phil/jobs/x` });
    await warmPhilPageCache("/phil/jobs/x", { cacheStorage, fetchImpl, origin: ORIGIN });
    expect(putCalls).toEqual([{ cache: "buhl-sw-v12-pages", url: `${ORIGIN}/phil/jobs/x` }]);
  });

  it("REFUSES to warm an auth redirect (→ /v2/login) under the Phil URL", async () => {
    const { cacheStorage, putCalls } = fakeCacheEnv(["buhl-sw-v12-pages"]);
    const fetchImpl = fakeFetch({ ok: true, redirected: true, url: `${ORIGIN}/v2/login` });
    await warmPhilPageCache("/phil/my-day", { cacheStorage, fetchImpl, origin: ORIGIN });
    expect(putCalls).toEqual([]);
  });

  it("skips the fetch entirely when the page is already cached", async () => {
    const { cacheStorage, putCalls } = fakeCacheEnv(
      ["buhl-sw-v12-pages"],
      [{ name: "buhl-sw-v12-pages", url: `${ORIGIN}/phil/jobs/x` }],
    );
    const fetchImpl = fakeFetch({ ok: true, redirected: false, url: `${ORIGIN}/phil/jobs/x` });
    await warmPhilPageCache("/phil/jobs/x", { cacheStorage, fetchImpl, origin: ORIGIN });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(putCalls).toEqual([]);
  });

  it("keys the warm by the fragment-less URL so a '#section' link still matches", async () => {
    const { cacheStorage, putCalls } = fakeCacheEnv(["buhl-sw-v12-pages"]);
    // The Needs-you feed links to /phil/jobs/x#phil-job-snags; the SW serves the
    // navigation keyed without the hash, so the warm must store it the same way.
    const fetchImpl = fakeFetch({ ok: true, redirected: false, url: `${ORIGIN}/phil/jobs/x` });
    await warmPhilPageCache("/phil/jobs/x#phil-job-snags", { cacheStorage, fetchImpl, origin: ORIGIN });
    expect(putCalls).toEqual([{ cache: "buhl-sw-v12-pages", url: `${ORIGIN}/phil/jobs/x` }]);
  });

  it("preserves the query string in the warm key (matches the SW navigation key)", async () => {
    const { cacheStorage, putCalls } = fakeCacheEnv(["buhl-sw-v12-pages"]);
    const fetchImpl = fakeFetch({
      ok: true,
      redirected: false,
      url: `${ORIGIN}/phil/my-day?fixDate=2026-06-20`,
    });
    await warmPhilPageCache("/phil/my-day?fixDate=2026-06-20", { cacheStorage, fetchImpl, origin: ORIGIN });
    expect(putCalls).toEqual([
      { cache: "buhl-sw-v12-pages", url: `${ORIGIN}/phil/my-day?fixDate=2026-06-20` },
    ]);
  });

  it("is a no-op for a non-/phil href (never warms admin/other surfaces)", async () => {
    const { cacheStorage, putCalls } = fakeCacheEnv(["buhl-sw-v12-pages"]);
    const fetchImpl = fakeFetch({ ok: true, redirected: false, url: `${ORIGIN}/v2/jobs/x` });
    await warmPhilPageCache("/v2/jobs/x", { cacheStorage, fetchImpl, origin: ORIGIN });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(putCalls).toEqual([]);
  });

  it("is a no-op when the SW has not created a '-pages' cache yet", async () => {
    const { cacheStorage, putCalls } = fakeCacheEnv(["buhl-sw-v12", "buhl-sw-v12-assets"]);
    const fetchImpl = fakeFetch({ ok: true, redirected: false, url: `${ORIGIN}/phil/jobs/x` });
    await warmPhilPageCache("/phil/jobs/x", { cacheStorage, fetchImpl, origin: ORIGIN });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(putCalls).toEqual([]);
  });

  it("never throws if fetch rejects (best-effort optimisation)", async () => {
    const { cacheStorage, putCalls } = fakeCacheEnv(["buhl-sw-v12-pages"]);
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(
      warmPhilPageCache("/phil/jobs/x", { cacheStorage, fetchImpl, origin: ORIGIN }),
    ).resolves.toBeUndefined();
    expect(putCalls).toEqual([]);
  });
});
