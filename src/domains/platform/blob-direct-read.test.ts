import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Deterministic-URL fast path for readBlob. Measured from syd1: list() costs
 * ~0.9s (store-origin API) while the CDN GET is ~10-70ms, and the old shape
 * paid the list on EVERY read. The fast path fetches the derived public URL
 * directly; the ONLY authority for "genuine absence → fallback" remains
 * list() (#576 discipline) — a bare 404 never returns the fallback.
 *
 * blob.js is CJS loaded via createRequire (vi.mock can't reach its SDK
 * imports), so it exposes explicit test seams: __setTestOverrides /
 * __learnPublicHost / __getPublicHost / __encodeKey.
 */
const requireFromHere = createRequire(import.meta.url);
const blob = requireFromHere(requireFromHere.resolve("../../../api/_lib/blob.js")) as {
  readBlobFresh: (key: string, fallback?: unknown) => Promise<unknown>;
  __setTestOverrides: (o: Record<string, unknown> | null) => void;
  __learnPublicHost: (url: string, pathname: string) => void;
  __getPublicHost: () => string | null;
  __encodeKey: (key: string) => string;
  __seedPublicHost: (raw: unknown) => string | null;
  __ttlFor: (key: string) => number;
};

const HOST = "store123.public.blob.vercel-storage.com";
const jsonRes = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const statusRes = (status: number) => ({ ok: false, status, json: async () => ({}) });

afterEach(() => blob.__setTestOverrides(null));

describe("__encodeKey / __learnPublicHost", () => {
  it("encodes segments but preserves slashes", () => {
    expect(blob.__encodeKey("users/u 1/time-entries/2026-07-20.json")).toBe(
      "users/u%201/time-entries/2026-07-20.json"
    );
  });

  it("learns the host only from a URL whose path matches the pathname exactly", () => {
    blob.__setTestOverrides({}); // resets host
    blob.__learnPublicHost(`https://${HOST}/a-RANDOMSUFFIX.json`, "a.json");
    expect(blob.__getPublicHost()).toBeNull();
    blob.__learnPublicHost(`https://${HOST}/a.json`, "a.json");
    expect(blob.__getPublicHost()).toBe(HOST);
  });

  it("never throws on a garbage URL", () => {
    expect(() => blob.__learnPublicHost("not a url", "a.json")).not.toThrow();
  });
});

describe("readBlob fast path", () => {
  it("with a learned host, reads via the derived URL and never calls list()", async () => {
    const fetch = vi.fn(async (url: string) => {
      expect(url).toContain(`https://${HOST}/k1.json?t=`);
      return jsonRes({ hello: 1 });
    });
    const list = vi.fn();
    blob.__setTestOverrides({ fetch, list });
    blob.__learnPublicHost(`https://${HOST}/k1.json`, "k1.json");
    expect(await blob.readBlobFresh("k1.json", null)).toEqual({ hello: 1 });
    expect(list).not.toHaveBeenCalled();
  });

  it("404 on the derived URL falls through to list() — legacy suffix blob still resolves", async () => {
    const legacyUrl = `https://${HOST}/k2-RANDOM.json`;
    const fetch = vi.fn(async (url: string) =>
      url.startsWith(legacyUrl) ? jsonRes({ legacy: true }) : statusRes(404)
    );
    const list = vi.fn(async () => ({ blobs: [{ pathname: "k2.json", url: legacyUrl }] }));
    blob.__setTestOverrides({ fetch, list });
    blob.__learnPublicHost(`https://${HOST}/seed.json`, "seed.json");
    expect(await blob.readBlobFresh("k2.json", null)).toEqual({ legacy: true });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("404 on the derived URL + list() finds nothing → fallback (absence stays list-decided)", async () => {
    const fetch = vi.fn(async () => statusRes(404));
    const list = vi.fn(async () => ({ blobs: [] }));
    blob.__setTestOverrides({ fetch, list });
    blob.__learnPublicHost(`https://${HOST}/seed.json`, "seed.json");
    expect(await blob.readBlobFresh("k3.json", "FB")).toBe("FB");
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("non-404 error on the derived URL degrades WITHOUT deciding absence via list()", async () => {
    const fetch = vi.fn(async () => statusRes(500));
    const list = vi.fn();
    blob.__setTestOverrides({ fetch, list });
    blob.__learnPublicHost(`https://${HOST}/seed.json`, "seed.json");
    // BlobReadError → readBlobFresh degrades to fallback, uncached.
    expect(await blob.readBlobFresh("k4.json", "FB")).toBe("FB");
    expect(list).not.toHaveBeenCalled();
  });

  it("with no learned host, behaves exactly like the old list-then-fetch path", async () => {
    const url = `https://${HOST}/k5.json`;
    const fetch = vi.fn(async (u: string) =>
      u.startsWith(url) ? jsonRes({ v: 5 }) : statusRes(404)
    );
    const list = vi.fn(async () => ({ blobs: [{ pathname: "k5.json", url }] }));
    blob.__setTestOverrides({ fetch, list }); // resets host to null
    expect(await blob.readBlobFresh("k5.json", null)).toEqual({ v: 5 });
    expect(list).toHaveBeenCalledTimes(1);
    // ...and that successful list() taught the host for the NEXT read:
    expect(blob.__getPublicHost()).toBe(HOST);
    const fetch2 = vi.fn(async () => jsonRes({ v: 6 }));
    const list2 = vi.fn();
    blob.__setTestOverrides({ fetch: fetch2, list: list2 });
    blob.__learnPublicHost(url, "k5.json"); // overrides reset host; re-learn
    expect(await blob.readBlobFresh("k5.json", null)).toEqual({ v: 6 });
    expect(list2).not.toHaveBeenCalled();
  });

  it("a put() teaches the host (write-then-read takes the fast path)", async () => {
    const put = vi.fn(async (key: string) => ({ url: `https://${HOST}/${key}` }));
    const fetch = vi.fn(async () => jsonRes({ w: 1 }));
    const list = vi.fn();
    blob.__setTestOverrides({ put, fetch, list });
    const { writeBlob } = blob as unknown as {
      writeBlob: (key: string, data: unknown) => Promise<void>;
    };
    await writeBlob("k6.json", { w: 1 });
    expect(blob.__getPublicHost()).toBe(HOST);
  });
});

describe("BLOB_PUBLIC_HOST seed + self-healing fast path (2026-10-26)", () => {
  it("accepts a store host, rejects anything else (a wrong seed can only cost a round trip, never a read)", () => {
    expect(blob.__seedPublicHost(` ${HOST} `)).toBe(HOST);
    expect(blob.__seedPublicHost("Store123.PUBLIC.blob.vercel-storage.com")).toBe(HOST);
    expect(blob.__seedPublicHost("https://store123.public.blob.vercel-storage.com")).toBeNull();
    expect(blob.__seedPublicHost("evil.example.com")).toBeNull();
    expect(blob.__seedPublicHost("")).toBeNull();
    expect(blob.__seedPublicHost(undefined)).toBeNull();
  });

  it("a derived-URL fetch that gets NO answer forgets the host and falls back to list() — never a failed read", async () => {
    const url = `https://${HOST}/k7.json`;
    let calls = 0;
    const fetch = vi.fn(async (u: string) => {
      calls += 1;
      if (calls === 1) throw new Error("getaddrinfo ENOTFOUND"); // the seeded host is wrong
      return u.startsWith(url) ? jsonRes({ v: 7 }) : statusRes(404);
    });
    const list = vi.fn(async () => ({ blobs: [{ pathname: "k7.json", url }] }));
    blob.__setTestOverrides({ fetch, list });
    blob.__learnPublicHost("https://wrong.public.blob.vercel-storage.com/k7.json", "k7.json");
    expect(await blob.readBlobFresh("k7.json", "FB")).toEqual({ v: 7 });
    expect(list).toHaveBeenCalledTimes(1);
    // ...and the real host is learned from that list() for the next read.
    expect(blob.__getPublicHost()).toBe(HOST);
  });

  it("slow-changing config stores keep for 30s; everything else for 5s", () => {
    expect(blob.__ttlFor("users.json")).toBe(30000);
    expect(blob.__ttlFor("flags.json")).toBe(30000);
    expect(blob.__ttlFor("jobs.json")).toBe(5000);
    expect(blob.__ttlFor("users/u1/time-entries/2026-10-26.json")).toBe(5000);
  });
});
