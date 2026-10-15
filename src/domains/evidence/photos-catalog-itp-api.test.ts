import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PhotoCatalogResponseSchema } from "./photo-gallery";

/**
 * api/photos-catalog.js — the simple-ITP source (option 1: ITP report photos
 * show in the job photo gallery). Real handler vs mocked blob/auth/flags/store.
 *
 * Pinned: flag off → no ITP rows and no store touch; flag on → rows carry
 * report + area context and a count; a store failure keeps the snag/dwelling
 * photos and names the gap (itpError); source=snags skips the store; the
 * response still parses against the client schema.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const ffPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const dbPath = requireFromHere.resolve("../../../api/_lib/supabase-db.js");
const storePath = requireFromHere.resolve("../../../api/_lib/itp-simple-store.js");
const handlerPath = requireFromHere.resolve("../../../api/photos-catalog.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let handler: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let store: Record<string, any>;
let flags: Record<string, boolean>;

const ADMIN = { id: "u_boss", name: "Boss", role: "admin", assignedJobIds: [] };

function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
    send(b: unknown) {
      this.body = b;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(query: Record<string, string> = {}): Promise<any> {
  const res = createRes();
  await handler({ method: "GET", query: { jobId: "j1", ...query }, headers: {} }, res);
  return res;
}

beforeEach(() => {
  flags = { job_photos: true, itp_simple: true };
  store = {
    resolveTenantId: vi.fn(async () => "tenant-1"),
    listJobPhotos: vi.fn(async () => [
      {
        id: "p1",
        url: "memory://itp-1.jpg",
        caption: "GPOs",
        takenBy: "Sparky",
        createdAt: "2026-09-20T01:00:00.000Z",
        areaName: "Kitchen",
        reportId: "r1",
        reportTitle: "Rough-in",
      },
    ]),
  };
  delete requireFromHere.cache[handlerPath];
  const fake = (path: string, exports: unknown) => {
    requireFromHere.cache[path] = { id: path, filename: path, loaded: true, exports } as NodeJS.Module;
  };
  fake(blobPath, {
    readBlob: vi.fn(async (key: string, fallback: unknown) => {
      if (key === "jobs.json") return { jobs: [{ id: "j1", name: "100 Arthur St", areaGroups: [] }] };
      if (key === "jobs/j1/data.json") {
        return {
          snags: [
            {
              id: "s1",
              desc: "Cover missing",
              photos: [{ id: "sp1", url: "memory://snag.jpg", addedAt: "2026-09-01T00:00:00Z" }],
            },
          ],
        };
      }
      return fallback;
    }),
    setNoCache: vi.fn(),
  });
  fake(authPath, {
    requireAuth: vi.fn(async () => ADMIN),
    canManageJob: vi.fn(() => true),
    isStaffRole: vi.fn(() => true),
  });
  fake(ffPath, { isFlagEnabled: vi.fn(async (key: string) => !!flags[key]) });
  fake(dbPath, { getDb: vi.fn(() => ({}) as unknown) });
  fake(storePath, store);
  handler = requireFromHere(handlerPath);
});

describe("api/photos-catalog — simple ITP photos", () => {
  it("adds ITP report photos with report + area context when itp_simple is on", async () => {
    const res = await call();
    expect(res.statusCode).toBe(200);
    const itp = res.body.photos.find((p: { source: string }) => p.source === "itp");
    expect(itp).toMatchObject({
      id: "p1",
      url: "memory://itp-1.jpg",
      addedBy: "Sparky",
      addedAt: "2026-09-20T01:00:00.000Z",
      reportId: "r1",
      reportTitle: "Rough-in",
      areaName: "Kitchen",
      caption: "GPOs",
    });
    expect(res.body.counts).toEqual({ total: 2, snag: 1, dwelling: 0, itp: 1 });
    // Newest first across sources.
    expect(res.body.photos.map((p: { id: string }) => p.id)).toEqual(["p1", "sp1"]);
    expect(res.body.itpError).toBeUndefined();
    expect(store.listJobPhotos).toHaveBeenCalledWith({}, "tenant-1", "j1");
    expect(PhotoCatalogResponseSchema.safeParse(res.body).success).toBe(true);
  });

  it("leaves the ITP source out entirely when itp_simple is off — no store touch", async () => {
    flags.itp_simple = false;
    const res = await call();
    expect(res.body.photos.every((p: { source: string }) => p.source !== "itp")).toBe(true);
    expect(res.body.counts.itp).toBe(0);
    expect(store.resolveTenantId).not.toHaveBeenCalled();
  });

  it("keeps the snag photos and names the gap when the ITP store fails", async () => {
    store.listJobPhotos.mockRejectedValueOnce(new Error("connection refused"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call();
    spy.mockRestore();
    expect(res.statusCode).toBe(200);
    expect(res.body.photos.map((p: { id: string }) => p.id)).toEqual(["sp1"]);
    expect(res.body.itpError).toBe("ITP report photos couldn't load");
    const parsed = PhotoCatalogResponseSchema.safeParse(res.body);
    expect(parsed.success && parsed.data.itpError).toBe("ITP report photos couldn't load");
  });

  it("treats an unprovisioned tenant as a named gap, not an empty list", async () => {
    store.resolveTenantId.mockResolvedValueOnce(null);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call();
    spy.mockRestore();
    expect(res.body.itpError).toBe("ITP report photos couldn't load");
    expect(store.listJobPhotos).not.toHaveBeenCalled();
  });

  it("source=snags skips the ITP store; source=itp returns only ITP rows", async () => {
    const snagsOnly = await call({ source: "snags" });
    expect(store.listJobPhotos).not.toHaveBeenCalled();
    expect(snagsOnly.body.photos.map((p: { id: string }) => p.id)).toEqual(["sp1"]);

    const itpOnly = await call({ source: "itp" });
    expect(itpOnly.body.photos.map((p: { id: string }) => p.id)).toEqual(["p1"]);
  });

  it("CSV rows name the report and the area", async () => {
    const res = await call({ format: "csv", source: "itp" });
    const lines = String(res.body).trim().split("\n");
    expect(lines[1]).toBe("itp,p1,ITP: Rough-in · GPOs,,,Kitchen,Sparky,2026-09-20T01:00:00.000Z,memory://itp-1.jpg");
  });
});
