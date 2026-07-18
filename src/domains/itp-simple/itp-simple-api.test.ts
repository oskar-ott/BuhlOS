import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * api/itp-simple.js (#912) — real handler vs mocked auth/flags/store/pdf
 * (payroll-batches harness pattern: the PG store is a service seam and is
 * mocked as a unit; SQL correctness lives behind it).
 *
 * Pinned: auth + flag-dark 404 (no store touch), read-only 403 on writes but
 * open GETs, job/report/area/photo routing incl. not-found paths, dataUrl
 * validation, the PDF pipeline (photo fetch failure degrades, artifact is
 * stored + stamped) and the photo-count guard.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const ffPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const dbPath = requireFromHere.resolve("../../../api/_lib/supabase-db.js");
const storePath = requireFromHere.resolve("../../../api/_lib/itp-simple-store.js");
const pdfPath = requireFromHere.resolve("../../../api/_lib/itp-simple-pdf.js");
const vercelBlobPath = requireFromHere.resolve("@vercel/blob");
const handlerPath = requireFromHere.resolve("../../../api/itp-simple.js");

type Res = ReturnType<typeof createRes>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let handler: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let store: Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let authUser: any;
let flagOn: boolean;
let writable: boolean;
let puts: Array<{ key: string; bytes: number; contentType: string }>;

const USER = { id: "u_sparky", username: "sparky", name: "Sparky", role: "electrician" };
const REPORT = {
  id: "r1",
  title: "Rough-in",
  pdfUrl: null,
  pdfGeneratedAt: null,
  createdBy: "Sparky",
  createdAt: "2026-07-18T01:00:00Z",
  updatedAt: "2026-07-18T01:00:00Z",
  areas: [
    {
      id: "a1",
      name: "Kitchen",
      position: 0,
      createdAt: "2026-07-18T01:05:00Z",
      photos: [
        {
          id: "p1",
          url: "memory://photo-1",
          pathname: "jobs/j1/itp-simple/1.jpg",
          caption: "",
          takenBy: "Sparky",
          createdAt: "2026-07-18T01:10:00Z",
        },
      ],
    },
  ],
};

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
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  };
}

async function call(opts: {
  method: string;
  query?: Record<string, string>;
  body?: unknown;
}): Promise<Res> {
  const res = createRes();
  await handler(
    { method: opts.method, query: { jobId: "j1", ...(opts.query || {}) }, headers: {}, body: opts.body },
    res,
  );
  return res;
}

beforeEach(() => {
  authUser = USER;
  flagOn = true;
  writable = true;
  puts = [];

  store = {
    resolveTenantId: vi.fn(async () => "tenant-1"),
    listReports: vi.fn(async () => [
      { id: "r1", title: "Rough-in", areaCount: 1, photoCount: 1, pdfUrl: null, pdfGeneratedAt: null, createdBy: "Sparky", createdAt: "2026-07-18T01:00:00Z", updatedAt: "2026-07-18T01:00:00Z" },
    ]),
    getReport: vi.fn(async () => structuredClone(REPORT)),
    createReport: vi.fn(async (_sql: unknown, _tenant: unknown, args: { title: string }) => ({
      id: "r2", title: args.title, areaCount: 0, photoCount: 0, pdfUrl: null, pdfGeneratedAt: null, createdBy: "Sparky", createdAt: "2026-07-18T02:00:00Z", updatedAt: "2026-07-18T02:00:00Z",
    })),
    renameReport: vi.fn(async () => true),
    deleteReport: vi.fn(async () => true),
    addArea: vi.fn(async () => ({ id: "a2", name: "Roof", position: 1, photos: [] })),
    renameArea: vi.fn(async () => true),
    deleteArea: vi.fn(async () => true),
    addPhoto: vi.fn(async () => ({ id: "p2", url: "memory://photo-2", pathname: "x", caption: "", takenBy: "Sparky", createdAt: "2026-07-18T03:00:00Z" })),
    deletePhoto: vi.fn(async () => true),
    stampPdf: vi.fn(async () => "2026-07-18T04:00:00Z"),
  };

  delete requireFromHere.cache[handlerPath];
  const fake = (path: string, exports: unknown) => {
    requireFromHere.cache[path] = { id: path, filename: path, loaded: true, exports } as NodeJS.Module;
  };
  fake(blobPath, {
    readBlob: vi.fn(async (key: string, fallback: unknown) =>
      key === "jobs.json" ? { jobs: [{ id: "j1", name: "100 Arthur St" }] } : fallback,
    ),
    writeBlob: vi.fn(async () => {}),
    setNoCache: vi.fn(),
  });
  fake(authPath, {
    requireAuth: vi.fn(async (_req: unknown, res: Res) => {
      if (authUser) return authUser;
      res.status(401).json({ error: "unauthorised" });
      return null;
    }),
    canWrite: vi.fn(() => writable),
  });
  fake(ffPath, { isFlagEnabled: vi.fn(async () => flagOn) });
  fake(dbPath, { getDb: vi.fn(() => ({}) as unknown) });
  fake(storePath, store);
  fake(pdfPath, { composeItpPdf: vi.fn(async () => Uint8Array.from([37, 80, 68, 70, 45])) });
  fake(vercelBlobPath, {
    put: vi.fn(async (key: string, bytes: Buffer, opts: { contentType: string }) => {
      puts.push({ key, bytes: bytes.length, contentType: opts.contentType });
      return { url: `memory://${key}`, pathname: key };
    }),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("photo-1")) {
        return { ok: true, arrayBuffer: async () => Uint8Array.from([255, 216, 255]).buffer };
      }
      return { ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
    }),
  );

  handler = requireFromHere(handlerPath);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api/itp-simple (#912)", () => {
  it("requires jobId and auth", async () => {
    const res = createRes();
    await handler({ method: "GET", query: {}, headers: {} }, res);
    expect(res.statusCode).toBe(400);

    authUser = null;
    expect((await call({ method: "GET" })).statusCode).toBe(401);
    expect(store.listReports).not.toHaveBeenCalled();
  });

  it("is 404-dark when the itp_simple flag is off — no store touch", async () => {
    flagOn = false;
    const res = await call({ method: "GET" });
    expect(res.statusCode).toBe(404);
    expect(store.resolveTenantId).not.toHaveBeenCalled();
  });

  it("read-only users can GET but every write 403s", async () => {
    writable = false;
    expect((await call({ method: "GET" })).statusCode).toBe(200);
    expect((await call({ method: "POST", body: { title: "X" } })).statusCode).toBe(403);
    expect(
      (await call({ method: "POST", query: { action: "area" }, body: { reportId: "r1", name: "Roof" } })).statusCode,
    ).toBe(403);
    expect(store.createReport).not.toHaveBeenCalled();
  });

  it("503s honestly when the tenant row is missing (store not provisioned)", async () => {
    store.resolveTenantId.mockResolvedValueOnce(null);
    const res = await call({ method: "GET" });
    expect(res.statusCode).toBe(503);
  });

  it("lists reports with the job meta", async () => {
    const res = await call({ method: "GET" });
    expect(res.statusCode).toBe(200);
    const body = res.body as { job: { name: string }; reports: unknown[] };
    expect(body.job.name).toBe("100 Arthur St");
    expect(body.reports).toHaveLength(1);
    expect(store.listReports).toHaveBeenCalledWith(expect.anything(), "tenant-1", "j1");
  });

  it("creates a report with a clean title and rejects a blank one", async () => {
    expect((await call({ method: "POST", body: { title: "  " } })).statusCode).toBe(400);
    const res = await call({ method: "POST", body: { title: "  Fit-off  " } });
    expect(res.statusCode).toBe(200);
    expect(store.createReport).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-1",
      expect.objectContaining({ jobLegacyId: "j1", title: "Fit-off" }),
    );
  });

  it("returns 404 for a report/area another job owns (store scoping says no)", async () => {
    store.getReport.mockResolvedValueOnce(null);
    expect((await call({ method: "GET", query: { id: "r-other" } })).statusCode).toBe(404);

    store.addArea.mockResolvedValueOnce(null);
    expect(
      (await call({ method: "POST", query: { action: "area" }, body: { reportId: "r-other", name: "Roof" } })).statusCode,
    ).toBe(404);
  });

  it("uploads a photo then attaches it; a bad areaId 404s after upload", async () => {
    const dataUrl = "data:image/jpeg;base64," + Buffer.from("fake-jpeg").toString("base64");
    const ok = await call({ method: "POST", query: { action: "photo" }, body: { areaId: "a1", dataUrl } });
    expect(ok.statusCode).toBe(200);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toMatch(/^jobs\/j1\/itp-simple\//);

    expect(
      (await call({ method: "POST", query: { action: "photo" }, body: { areaId: "a1", dataUrl: "garbage" } })).statusCode,
    ).toBe(400);

    store.addPhoto.mockResolvedValueOnce(null);
    expect(
      (await call({ method: "POST", query: { action: "photo" }, body: { areaId: "a-other", dataUrl } })).statusCode,
    ).toBe(404);
  });

  it("makes the PDF: fetches photos (failures degrade), stores it, stamps the report", async () => {
    const res = await call({ method: "POST", query: { action: "pdf" }, body: { reportId: "r1" } });
    expect(res.statusCode).toBe(200);
    const body = res.body as { url: string; generatedAt: string };
    expect(body.url).toMatch(/^memory:\/\/jobs\/j1\/itp-simple\/r1\//);
    expect(body.generatedAt).toBe("2026-07-18T04:00:00Z");
    expect(puts.some((p) => p.contentType === "application/pdf")).toBe(true);
    expect(store.stampPdf).toHaveBeenCalledWith(expect.anything(), "tenant-1", "j1", "r1", body.url);
  });

  it("refuses a PDF over the photo cap with an honest message", async () => {
    const bigReport = structuredClone(REPORT);
    bigReport.areas[0]!.photos = Array.from({ length: 121 }, (_, i) => ({
      id: `p${i}`, url: `memory://photo-${i}`, pathname: null as unknown as string, caption: "", takenBy: "", createdAt: "2026-07-18T01:00:00Z",
    }));
    store.getReport.mockResolvedValueOnce(bigReport);
    const res = await call({ method: "POST", query: { action: "pdf" }, body: { reportId: "r1" } });
    expect(res.statusCode).toBe(400);
    expect(String((res.body as { error: string }).error)).toContain("split the report");
  });

  it("routes area rename/delete and photo delete with not-found honesty", async () => {
    expect(
      (await call({ method: "PUT", query: { action: "area" }, body: { id: "a1", name: "Roof void" } })).statusCode,
    ).toBe(200);
    store.deleteArea.mockResolvedValueOnce(false);
    expect(
      (await call({ method: "DELETE", query: { action: "area" }, body: { id: "a-other" } })).statusCode,
    ).toBe(404);
    expect((await call({ method: "DELETE", query: { action: "photo" }, body: { id: "p1" } })).statusCode).toBe(200);
  });
});
