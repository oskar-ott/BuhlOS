import { describe, expect, it } from "vitest";
import {
  pushRecent,
  sanitizeRecents,
  readRecentItems,
  recordRecentItem,
  RECENTS_CAP,
  RECENTS_KEY,
  type RecentItem,
  type RecentsStorage,
} from "./recent-items";

/**
 * #215 — recents ring buffer. The live tracker writes from a mount effect and
 * the palette reads on open; the mechanics (add / de-dupe / cap / corrupt
 * tolerance) are pure + storage-injectable, so they're pinned here without a
 * DOM (the vitest runner is node-env).
 */

function memStorage(initial?: Record<string, string>): RecentsStorage & { dump(): Record<string, string> } {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

function item(path: string, at = 1, type: RecentItem["type"] = "job"): RecentItem {
  return { path, title: path.replace(/\W/g, " ").trim(), type, at };
}

describe("pushRecent (pure ring buffer)", () => {
  it("prepends the newest item", () => {
    const out = pushRecent([item("/a"), item("/b")], item("/c"));
    expect(out.map((r) => r.path)).toEqual(["/c", "/a", "/b"]);
  });

  it("de-dupes by path, bumping a repeat visit to the top", () => {
    const out = pushRecent([item("/a"), item("/b"), item("/c")], item("/b", 99));
    expect(out.map((r) => r.path)).toEqual(["/b", "/a", "/c"]);
    expect(out[0]!.at).toBe(99); // the fresher timestamp wins
    expect(out).toHaveLength(3); // no duplicate row
  });

  it("caps the buffer at RECENTS_CAP, dropping the oldest", () => {
    let buf: RecentItem[] = [];
    for (let i = 0; i < RECENTS_CAP + 5; i++) buf = pushRecent(buf, item(`/p${i}`, i));
    expect(buf).toHaveLength(RECENTS_CAP);
    // newest first → the last pushed is at the head, the oldest survivors trail
    expect(buf[0]!.path).toBe(`/p${RECENTS_CAP + 4}`);
    expect(buf.some((r) => r.path === "/p0")).toBe(false);
  });

  it("never mutates the input array", () => {
    const input = [item("/a")];
    const snapshot = [...input];
    pushRecent(input, item("/b"));
    expect(input).toEqual(snapshot);
  });
});

describe("sanitizeRecents (corrupt-tolerant read)", () => {
  it("returns [] for non-arrays / junk", () => {
    expect(sanitizeRecents(null)).toEqual([]);
    expect(sanitizeRecents("nope")).toEqual([]);
    expect(sanitizeRecents({ path: "/a" })).toEqual([]);
  });

  it("drops malformed entries but keeps valid ones", () => {
    const raw = [
      { path: "/a", title: "A", type: "job", at: 2 },
      { path: "", title: "blank path", type: "job", at: 1 }, // empty path
      { path: "/b", title: "B", type: "weird", at: 1 }, // bad type
      { path: "/c", title: 5, type: "employee", at: 1 }, // non-string title
      { path: "/d", title: "D", type: "employee", at: "x" }, // non-number at
      { path: "/e", title: "E", type: "employee", at: 3 },
    ];
    expect(sanitizeRecents(raw).map((r) => r.path)).toEqual(["/a", "/e"]);
  });

  it("de-dupes a duplicated path on read and honours the cap", () => {
    const raw = Array.from({ length: RECENTS_CAP + 3 }, (_, i) => ({
      path: `/p${i}`,
      title: `P${i}`,
      type: "job",
      at: i,
    }));
    raw.push({ path: "/p0", title: "dupe", type: "job", at: 999 });
    const out = sanitizeRecents(raw);
    expect(out).toHaveLength(RECENTS_CAP);
    expect(out.filter((r) => r.path === "/p0")).toHaveLength(1);
  });
});

describe("readRecentItems / recordRecentItem (storage layer)", () => {
  it("reads [] when the key is absent or storage is null", () => {
    expect(readRecentItems(memStorage())).toEqual([]);
    expect(readRecentItems(null)).toEqual([]);
  });

  it("tolerates corrupt JSON by reading []", () => {
    const s = memStorage({ [RECENTS_KEY]: "{not json" });
    expect(readRecentItems(s)).toEqual([]);
  });

  it("records a visit and reads it back", () => {
    const s = memStorage();
    recordRecentItem({ path: "/v2/jobs/j1", title: "Magill Rd", type: "job", at: 10 }, s);
    expect(readRecentItems(s)).toEqual([
      { path: "/v2/jobs/j1", title: "Magill Rd", type: "job", at: 10 },
    ]);
  });

  it("ignores a blank path or title (nothing to navigate back to)", () => {
    const s = memStorage();
    recordRecentItem({ path: "  ", title: "x", type: "job" }, s);
    recordRecentItem({ path: "/v2/jobs/j1", title: "   ", type: "job" }, s);
    expect(readRecentItems(s)).toEqual([]);
  });

  it("de-dupes/bumps across successive records and persists newest-first", () => {
    const s = memStorage();
    recordRecentItem({ path: "/v2/jobs/j1", title: "One", type: "job", at: 1 }, s);
    recordRecentItem({ path: "/employees/u1", title: "Sparky", type: "employee", at: 2 }, s);
    recordRecentItem({ path: "/v2/jobs/j1", title: "One", type: "job", at: 3 }, s);
    expect(readRecentItems(s).map((r) => r.path)).toEqual(["/v2/jobs/j1", "/employees/u1"]);
  });

  it("is a no-op when storage is unavailable", () => {
    expect(() => recordRecentItem({ path: "/a", title: "A", type: "job" }, null)).not.toThrow();
  });
});
