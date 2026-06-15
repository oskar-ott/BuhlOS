import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Vercel Blob SDK — the first such mock in the repo. The TS helper is
// the only caller, so we assert it drives `list`/`put` per api/_lib/blob.js's
// conventions without any real network.
const list = vi.fn();
const put = vi.fn();
vi.mock("@vercel/blob", () => ({
  list: (...args: unknown[]) => list(...args),
  put: (...args: unknown[]) => put(...args),
}));

import { isBlobConfigured, readJsonBlob, writeJsonBlob } from "./blob";

const ORIGINAL_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

beforeEach(() => {
  list.mockReset();
  put.mockReset();
  vi.unstubAllGlobals();
});

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = ORIGINAL_TOKEN;
});

describe("isBlobConfigured", () => {
  it("reflects the presence of the write token", () => {
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_x";
    expect(isBlobConfigured()).toBe(true);
    delete process.env.BLOB_READ_WRITE_TOKEN;
    expect(isBlobConfigured()).toBe(false);
  });
});

describe("readJsonBlob", () => {
  it("lists by key, matches the exact pathname, fetches and parses the JSON", async () => {
    list.mockResolvedValue({
      blobs: [{ pathname: "jobs/j1/job-control.json", url: "https://blob/x" }],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ workPackages: [] }) })
    );

    const out = await readJsonBlob<{ workPackages: unknown[] }>("jobs/j1/job-control.json");
    expect(out).toEqual({ workPackages: [] });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: "jobs/j1/job-control.json" })
    );
  });

  it("returns the fallback when the key does not exist (no throw)", async () => {
    list.mockResolvedValue({ blobs: [] });
    const out = await readJsonBlob("jobs/missing/job-control.json", { empty: true });
    expect(out).toEqual({ empty: true });
  });

  it("defaults the fallback to null", async () => {
    list.mockResolvedValue({ blobs: [{ pathname: "other", url: "u" }] });
    expect(await readJsonBlob("jobs/none.json")).toBeNull();
  });
});

describe("writeJsonBlob", () => {
  it("puts the serialized JSON at the exact key with api/_lib/blob.js options", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_x";
    put.mockResolvedValue({ url: "https://blob/x" });

    await writeJsonBlob("_runtime/probe.json", { ok: true });

    expect(put).toHaveBeenCalledTimes(1);
    const [key, body, opts] = put.mock.calls[0]!;
    expect(key).toBe("_runtime/probe.json");
    expect(body).toBe(JSON.stringify({ ok: true }));
    expect(opts).toMatchObject({
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });
  });
});
