import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { allPhotoIds, MAX_ITEM_PHOTOS } from "./format";

/** More photos of an item (2026-11-16): the gallery's order and the phone's copy of the server's limit. */
const requireFromHere = createRequire(import.meta.url);

describe("allPhotoIds", () => {
  it("the main photo first, then the others in order; never twice", () => {
    expect(allPhotoIds({ photoId: "m", photos: [{ id: "a" }, { id: "b" }] })).toEqual(["m", "a", "b"]);
    expect(allPhotoIds({ photoId: "m", photos: [{ id: "m" }, { id: "a" }] })).toEqual(["m", "a"]);
    expect(allPhotoIds({ photoId: null, photos: [{ id: "a" }] })).toEqual(["a"]);
    expect(allPhotoIds({ photoId: null })).toEqual([]);
  });
});

describe("parity", () => {
  it("the phone's limit is the server's", () => {
    expect(MAX_ITEM_PHOTOS).toBe(requireFromHere("../../../api/_lib/workshop-stock/store.js").MAX_ITEM_PHOTOS);
  });
});
