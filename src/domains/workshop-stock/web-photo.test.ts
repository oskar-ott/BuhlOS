import { describe, expect, it, vi } from "vitest";
import { findPhotoFor, needsWebPhoto } from "./web-photo";

const ITEM = { id: "i1", brand: "Clipsal", manufacturerCode: "2025WE", colourFinish: "White", variant: null };
const FOUND = { photoId: "p1", source: { domain: "clipsal.com", kind: "manufacturer", pageUrl: "https://www.clipsal.com/p" } };
const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (status: number, body: unknown) => ({ ok: false as const, error: { status, body, message: "x" } });
const lookup = (status: string, reasons: string[] = []) => ok({ status, reasons, candidate: null, sources: [] } as never);

describe("findPhotoFor", () => {
  it("uses the server's answer when the check is already on record — no second check", async () => {
    const deps = { findWebPhoto: vi.fn(async () => ok(FOUND)), lookupCode: vi.fn() };
    expect(await findPhotoFor(ITEM, deps as never)).toEqual({ kind: "found", photo: FOUND });
    expect(deps.lookupCode).not.toHaveBeenCalled();
  });

  it("no check yet: runs the item's own check, then asks once more", async () => {
    const findWebPhoto = vi.fn().mockResolvedValueOnce(fail(409, { error: "not_checked" })).mockResolvedValueOnce(ok(FOUND));
    const lookupCode = vi.fn(async () => lookup("manufacturer_code_matched"));
    const onChecking = vi.fn();
    expect(await findPhotoFor(ITEM, { findWebPhoto, lookupCode, onChecking } as never)).toEqual({ kind: "found", photo: FOUND });
    expect(lookupCode).toHaveBeenCalledWith({ brand: "Clipsal", manufacturerCode: "2025WE", colourFinish: "White", variantDetails: "" });
    expect(onChecking).toHaveBeenCalledTimes(1);
    expect(findWebPhoto).toHaveBeenCalledTimes(2);
  });

  it("nothing to use is 'none', not a failure: no match, no image on the page, no code", async () => {
    const noMatch = await findPhotoFor(ITEM, { findWebPhoto: vi.fn(async () => fail(409, { error: "not_checked" })), lookupCode: vi.fn(async () => lookup("no_match", ["The pages found don't show this exact code"])) } as never);
    expect(noMatch).toEqual({ kind: "none", text: "No product page found — the pages found don't show this exact code." });
    const noImage = await findPhotoFor(ITEM, { findWebPhoto: vi.fn(async () => fail(404, { error: "no_web_photo", sourceDomain: "rexel.com.au" })), lookupCode: vi.fn() } as never);
    expect(noImage).toEqual({ kind: "none", text: "The product page on rexel.com.au has no photo to use." });
    const findWebPhoto = vi.fn();
    expect((await findPhotoFor({ ...ITEM, manufacturerCode: null }, { findWebPhoto, lookupCode: vi.fn() } as never)).kind).toBe("none");
    expect(findWebPhoto).not.toHaveBeenCalled();
  });

  it("a failure the next item would hit too says stop: today's checks used up, a rate limit, no signal", async () => {
    const used = await findPhotoFor(ITEM, { findWebPhoto: vi.fn(async () => fail(409, { error: "not_checked" })), lookupCode: vi.fn(async () => lookup("unavailable", ["Today's online checks are used up — save it now and check it tomorrow"])) } as never);
    expect(used).toMatchObject({ kind: "error", stop: true, text: expect.stringContaining("used up") });
    expect(await findPhotoFor(ITEM, { findWebPhoto: vi.fn(async () => fail(429, { error: "web_photo_limit" })), lookupCode: vi.fn() } as never)).toMatchObject({ kind: "error", stop: true });
    expect(await findPhotoFor(ITEM, { findWebPhoto: vi.fn(async () => fail(0, null)), lookupCode: vi.fn() } as never)).toMatchObject({ kind: "error", stop: true });
    // one image that wouldn't load is that item's problem, not the run's
    expect(await findPhotoFor(ITEM, { findWebPhoto: vi.fn(async () => fail(502, { error: "web_photo_unavailable", sourceDomain: "jrt.com.au" })), lookupCode: vi.fn() } as never)).toMatchObject({ kind: "error", stop: false });
  });
});

describe("needsWebPhoto", () => {
  it("live items with a code and no photo", () => {
    const rows = [
      { id: "a", photoId: null, manufacturerCode: "X1", archivedAt: null },
      { id: "b", photoId: "p", manufacturerCode: "X2", archivedAt: null },
      { id: "c", photoId: null, manufacturerCode: null, archivedAt: null },
      { id: "d", photoId: null, manufacturerCode: "X3", archivedAt: "2026-11-01" },
    ];
    expect(needsWebPhoto(rows).map((r) => r.id)).toEqual(["a"]);
  });
});
