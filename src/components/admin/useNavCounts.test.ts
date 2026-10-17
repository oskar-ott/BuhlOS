import { describe, expect, it } from "vitest";
import { deriveNavCounts, type NavCountPayloads } from "./useNavCounts";

/**
 * deriveNavCounts is the pure reducer behind the sidebar badges. The contract
 * that matters: real numbers from real payloads, and — per the honesty rule —
 * NO key (and so no badge) when a source failed, never a fabricated 0.
 */

const EMPTY: NavCountPayloads = {
  stats: null,
  hours: null,
  gear: null,
};

describe("deriveNavCounts", () => {
  it("derives every wired count from well-formed payloads", () => {
    const counts = deriveNavCounts({
      stats: {
        jobs: { active: 7 },
        users: { byRole: { admin: 2, leadingHand: 3, tradie: 10, client: 5 } },
      },
      hours: { entries: [{}, {}, {}] },
      gear: { tags: [{}, {}], calibrations: [{}] },
    });

    expect(counts).toEqual({
      jobs: 7,
      people: 15, // 2 + 3 + 10 — clients excluded
      hours: 3,
      gear: 3, // tags + calibrations
    });
  });

  it("omits a key entirely when its source failed (null) — never a fake 0", () => {
    expect(deriveNavCounts(EMPTY)).toEqual({});
  });

  it("distinguishes loaded-empty (0) from failed (absent)", () => {
    const loadedEmpty = deriveNavCounts({
      ...EMPTY,
      hours: { entries: [] },
      gear: { tags: [], calibrations: [] },
    });
    expect(loadedEmpty.hours).toBe(0);
    expect(loadedEmpty.gear).toBe(0);
    // Failed sources still absent.
    expect(loadedEmpty.jobs).toBeUndefined();
    expect(loadedEmpty.people).toBeUndefined();
  });

  it("sums gear from tags and calibrations independently", () => {
    expect(deriveNavCounts({ ...EMPTY, gear: { tags: [{}, {}] } }).gear).toBe(2);
    expect(deriveNavCounts({ ...EMPTY, gear: { calibrations: [{}] } }).gear).toBe(1);
    expect(deriveNavCounts({ ...EMPTY, gear: { tags: [], calibrations: [] } }).gear).toBe(0);
  });

  it("reads partial admin-stats without inventing the missing sub-counts", () => {
    const counts = deriveNavCounts({ ...EMPTY, stats: { jobs: { active: 5 } } });
    expect(counts.jobs).toBe(5);
    expect(counts.people).toBeUndefined();
  });

  it("survives garbage payloads without throwing or fabricating", () => {
    const counts = deriveNavCounts({
      stats: 42,
      hours: "nope",
      gear: true,
    });
    expect(counts).toEqual({});
  });
});

/**
 * 2026-10-15 (shorter-paths audit D1): a page that already computed a count
 * seeds the hook, and only the sources the seed does not answer are fetched.
 * The planner is pure; the fan-out is checked against a recorded fetch.
 */
import { afterEach, beforeEach, vi } from "vitest";
import {
  NAV_SOURCES,
  STALE_MS,
  __resetNavCountsCache,
  applySeed,
  loadNavCounts,
  mergeFetched,
  sourcesCoveredBy,
  sourcesToFetch,
} from "./useNavCounts";

describe("nav-count seeds — the planner (pure)", () => {
  const NOW = 1_000_000;

  it("a seed covers a source only when it answers EVERY key of that source", () => {
    expect(sourcesCoveredBy({ hours: 3 })).toEqual(["hours"]);
    expect(sourcesCoveredBy({ jobs: 4 })).toEqual([]); // admin-stats also answers people
    expect(sourcesCoveredBy({ jobs: 4, people: 9 })).toEqual(["stats"]);
    expect(sourcesCoveredBy({ hours: undefined })).toEqual([]); // absent = honest unknown
    expect(sourcesCoveredBy(undefined)).toEqual([]);
  });

  it("no seed, no cache → nothing to render yet and every source to fetch", () => {
    const cache = applySeed(null, undefined, NOW);
    expect(cache).toBeNull();
    expect(sourcesToFetch(cache)).toEqual([...NAV_SOURCES]);
  });

  it("a seed renders at once and takes its source off the fetch list", () => {
    const cache = applySeed(null, { hours: 3 }, NOW);
    expect(cache?.counts).toEqual({ hours: 3 });
    expect(sourcesToFetch(cache)).toEqual(["stats", "gear"]); // the approver walk is NOT fetched
  });

  it("a seed of 0 is a real number — the hours walk is still skipped", () => {
    const cache = applySeed(null, { hours: 0 }, NOW);
    expect(cache?.counts.hours).toBe(0);
    expect(sourcesToFetch(cache)).not.toContain("hours");
  });

  it("a seed wins over a fresh cached value; a stale cache is dropped first", () => {
    const fresh = mergeFetched(null, { hours: 7, gear: 1 }, ["hours", "gear"], NOW);
    const seeded = applySeed(fresh, { hours: 2 }, NOW + 1_000);
    expect(seeded?.counts).toEqual({ hours: 2, gear: 1 });
    expect(seeded?.at).toBe(NOW); // the window started with the first fill

    const stale = applySeed(fresh, { hours: 2 }, NOW + STALE_MS);
    expect(stale?.counts).toEqual({ hours: 2 }); // gear's old number is gone, not kept past its window
    expect(sourcesToFetch(stale)).toEqual(["stats", "gear"]);
  });

  it("a fetched result fills gaps but never overwrites a seed for the same key", () => {
    const seeded = applySeed(null, { hours: 2 }, NOW);
    const merged = mergeFetched(seeded, { jobs: 5, people: 8 }, ["stats", "gear"], NOW + 10);
    expect(merged.counts).toEqual({ hours: 2, jobs: 5, people: 8 });
    // gear was fetched and failed (no key): covered, so it isn't re-hit on the
    // next navigation inside the window — and still no badge, never a 0.
    expect(merged.counts.gear).toBeUndefined();
    expect(sourcesToFetch(merged)).toEqual([]);
  });
});

describe("loadNavCounts — fetches only the sources asked for", () => {
  let urls: string[];
  beforeEach(() => {
    __resetNavCountsCache();
    urls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        const body = url.startsWith("/api/admin-stats")
          ? { jobs: { active: 4 }, users: { byRole: { admin: 1, leadingHand: 2, tradie: 6 } } }
          : url.startsWith("/api/tags-expiring")
            ? { tags: [{}], calibrations: [] }
            : { entries: [{}, {}] };
        return { ok: true, json: async () => body };
      })
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetNavCountsCache();
  });

  it("with the hours source seeded elsewhere, the approver-queue endpoint is never called", async () => {
    const counts = await loadNavCounts(["stats", "gear"]);
    expect(urls.some((u) => u.includes("scope=approver"))).toBe(false);
    expect(urls).toHaveLength(2);
    expect(counts).toEqual({ jobs: 4, people: 9, gear: 1 });
    expect(counts.hours).toBeUndefined(); // not fetched → absent, not 0
  });

  it("the default is still the full fan-out", async () => {
    const counts = await loadNavCounts();
    expect(urls).toHaveLength(3);
    expect(counts).toEqual({ jobs: 4, people: 9, gear: 1, hours: 2 });
  });

  it("two navs mounting together share one in-flight request per source", async () => {
    await Promise.all([loadNavCounts(["gear"]), loadNavCounts(["gear"])]);
    expect(urls).toEqual(["/api/tags-expiring"]);
  });
});
