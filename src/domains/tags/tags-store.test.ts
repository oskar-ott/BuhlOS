import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Pure unit contract for api/_lib/tags-store.js `tagsFromBlob` — the ONE
 * shape-normaliser every tags.json reader uses (page #641, expiry feed, reminder
 * cron, job-stats). Legacy bare-array blobs must yield their rows; anything
 * unrecognised must yield [] without throwing.
 */
const requireFromHere = createRequire(import.meta.url);
const { tagsFromBlob } = requireFromHere("../../../api/_lib/tags-store.js") as {
  tagsFromBlob: (blob: unknown) => unknown[];
};

describe("tagsFromBlob", () => {
  it("legacy BARE ARRAY → the array itself", () => {
    const rows = [{ id: "t1" }, { id: "t2" }];
    expect(tagsFromBlob(rows)).toBe(rows);
  });
  it("modern { tags: [...] } → the inner array", () => {
    const rows = [{ id: "m1" }];
    expect(tagsFromBlob({ tags: rows })).toBe(rows);
  });
  it("empty shapes → []", () => {
    expect(tagsFromBlob({ tags: [] })).toEqual([]);
    expect(tagsFromBlob([])).toEqual([]);
  });
  it("unrecognised / malformed shapes → [] (never throws)", () => {
    for (const bad of [null, undefined, {}, { tags: "x" }, { tags: 5 }, { tags: null }, { foo: 1 }, 42, "str", true]) {
      expect(tagsFromBlob(bad as unknown)).toEqual([]);
    }
  });
});
