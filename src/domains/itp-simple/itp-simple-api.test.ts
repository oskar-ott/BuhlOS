import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * api/itp-simple.js (#912; redesign per the 2026-11-02 handoff) — real
 * handler vs mocked auth/flags/store/pdf/email (payroll-batches harness
 * pattern: the PG store is a service seam and is mocked as a unit; SQL
 * correctness lives behind it).
 *
 * Pinned: auth + flag-dark 404 (no store touch), read-only 403 on writes but
 * open GETs, job/report/area/photo routing incl. not-found paths, dataUrl
 * validation, the list badges (pdf count / stale count / last send), the
 * report GET extras (recent names, email chips, office address), making a
 * PDF (areas picked, default name, snapshot + fingerprint, photo fetch
 * failure degrades, artifact stored + stamped), the photo cap wording,
 * make-again / rename, the send pipeline (stale → remade first; office
 * needs the setting; bad address; "sent" only when the mail service says
 * so; failures logged) and the walkthrough flag.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const ffPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const fsPath = requireFromHere.resolve("../../../api/_lib/feature-settings.js");
const dbPath = requireFromHere.resolve("../../../api/_lib/supabase-db.js");
const storePath = requireFromHere.resolve("../../../api/_lib/itp-simple-store.js");
const pdfPath = requireFromHere.resolve("../../../api/_lib/itp-simple-pdf.js");
const emailPath = requireFromHere.resolve("../../../api/_lib/email.js");
const vercelBlobPath = requireFromHere.resolve("@vercel/blob");
const handlerPath = requireFromHere.resolve("../../../api/itp-simple.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const model = requireFromHere("../../../api/_lib/itp-simple-model.js");

type Res = ReturnType<typeof createRes>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let handler: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let store: Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let authUser: any;
let flagOn: boolean;
let writable: boolean;
let officeEmail: string;
let emailConfigured: boolean;
let emailResult: { ok: boolean; id?: string; reason?: string };
let emailsSent: Array<Record<string, unknown>>;
let puts: Array<{ key: string; bytes: number; contentType: string }>;
let composeCalls: Array<Record<string, unknown>>;

const USER = { id: "u_sparky", username: "sparky", name: "Sparky", role: "electrician" };
const REPORT = {
  id: "r1",
  title: "ITP · Fri 30 Oct",
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
    {
      id: "a2",
      name: "Switchboard",
      position: 1,
      createdAt: "2026-07-18T01:06:00Z",
      photos: [
        {
          id: "p2",
          url: "memory://photo-2",
          pathname: "jobs/j1/itp-simple/2.jpg",
          caption: "Board open",
          takenBy: "Sparky",
          createdAt: "2026-07-18T01:11:00Z",
        },
      ],
    },
  ],
};

function pdfRowFor(report: typeof REPORT, areaIds: string[], over: Record<string, unknown> = {}) {
  const snapshot = model.snapshotFor(report, areaIds);
  return {
    id: "pdf1",
    reportId: report.id,
    name: model.defaultPdfName(snapshot.areas, report.areas.length),
    nameIsAuto: true,
    areaIds,
    snapshot,
    contentKey: model.contentKey(snapshot.areas),
    areaCount: snapshot.areas.length,
    photoCount: model.countPhotos(snapshot.areas),
    url: "memory://pdf-1",
    pathname: "jobs/j1/itp-simple/r1/x.pdf",
    madeAt: "2026-07-18T04:00:00Z",
    madeBy: "Sparky",
    ...over,
  };
}

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
    {
      method: opts.method,
      query: { jobId: "j1", ...(opts.query || {}) },
      headers: {},
      body: opts.body,
    },
    res
  );
  return res;
}

beforeEach(() => {
  authUser = USER;
  flagOn = true;
  writable = true;
  officeEmail = "";
  emailConfigured = true;
  emailResult = { ok: true, id: "msg_1" };
  emailsSent = [];
  puts = [];
  composeCalls = [];

  store = {
    resolveTenantId: vi.fn(async () => "tenant-1"),
    listReports: vi.fn(async () => [
      {
        id: "r1",
        title: "ITP · Fri 30 Oct",
        areaCount: 2,
        photoCount: 2,
        pdfUrl: null,
        pdfGeneratedAt: null,
        createdBy: "Sparky",
        createdAt: "2026-07-18T01:00:00Z",
        updatedAt: "2026-07-18T01:00:00Z",
      },
    ]),
    getReport: vi.fn(async () => structuredClone(REPORT)),
    createReport: vi.fn(async (_sql: unknown, _tenant: unknown, args: { title: string }) => ({
      id: "r2",
      title: args.title,
      areaCount: 0,
      photoCount: 0,
      pdfUrl: null,
      pdfGeneratedAt: null,
      createdBy: "Sparky",
      createdAt: "2026-07-18T02:00:00Z",
      updatedAt: "2026-07-18T02:00:00Z",
    })),
    renameReport: vi.fn(async () => true),
    deleteReport: vi.fn(async () => true),
    addArea: vi.fn(async () => ({ id: "a3", name: "Roof", position: 2, photos: [] })),
    renameArea: vi.fn(async () => true),
    deleteArea: vi.fn(async () => true),
    addPhoto: vi.fn(async () => ({
      id: "p9",
      url: "memory://photo-9",
      pathname: "x",
      caption: "",
      takenBy: "Sparky",
      createdAt: "2026-07-18T03:00:00Z",
    })),
    updatePhotoCaption: vi.fn(async () => true),
    deletePhoto: vi.fn(async () => true),
    stampPdf: vi.fn(async () => "2026-07-18T04:00:00Z"),
    getPdf: vi.fn(async () => null),
    listPdfs: vi.fn(async () => []),
    createPdf: vi.fn(
      async (
        _sql: unknown,
        _tenant: unknown,
        reportId: string,
        input: Record<string, unknown>
      ) => ({
        id: "pdf-new",
        reportId,
        madeAt: "2026-07-18T05:00:00Z",
        madeBy: "Sparky",
        ...input,
      })
    ),
    replacePdfFile: vi.fn(async (_sql: unknown, pdfId: string, input: Record<string, unknown>) => ({
      ...pdfRowFor(REPORT, ["a1", "a2"]),
      id: pdfId,
      ...input,
      madeAt: input.touchMadeAt ? "2026-07-18T06:00:00Z" : "2026-07-18T04:00:00Z",
    })),
    logSend: vi.fn(
      async (
        _sql: unknown,
        _t: unknown,
        _j: unknown,
        reportId: string,
        input: Record<string, unknown>
      ) => ({
        id: "send-1",
        reportId,
        sentAt: "2026-07-18T07:00:00Z",
        ...input,
      })
    ),
    listSends: vi.fn(async () => []),
    recentEmailRecipients: vi.fn(async () => ["sam@builder.com.au"]),
    reportFacts: vi.fn(async () => ({
      pdfsByReport: new Map(),
      areasByReport: new Map(),
      lastSendByReport: new Map(),
    })),
    lastReportAreaNames: vi.fn(async () => ["Laundry", "Kitchen"]),
    walkthroughSeen: vi.fn(async () => false),
    markWalkthroughSeen: vi.fn(async () => true),
  };

  delete requireFromHere.cache[handlerPath];
  const fake = (path: string, exports: unknown) => {
    requireFromHere.cache[path] = {
      id: path,
      filename: path,
      loaded: true,
      exports,
    } as NodeJS.Module;
  };
  fake(blobPath, {
    readBlob: vi.fn(async (key: string, fallback: unknown) =>
      key === "jobs.json"
        ? {
            jobs: [
              {
                id: "j1",
                name: "100 Arthur St",
                areaGroups: [
                  {
                    name: "Ground",
                    areas: [
                      { id: "g1", name: "Garage" },
                      { id: "g2", name: "Kitchen" },
                    ],
                  },
                ],
              },
            ],
          }
        : fallback
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
  fake(fsPath, {
    getSetting: vi.fn(async (f: string, k: string) =>
      f === "itp_simple" && k === "officeEmail" ? officeEmail : null
    ),
  });
  fake(dbPath, { getDb: vi.fn(() => ({}) as unknown) });
  fake(storePath, store);
  fake(pdfPath, {
    composeItpPdf: vi.fn(async (input: Record<string, unknown>) => {
      composeCalls.push(input);
      return Uint8Array.from([37, 80, 68, 70, 45]);
    }),
  });
  fake(emailPath, {
    isEmailConfigured: vi.fn(() => emailConfigured),
    sendEmail: vi.fn(async (msg: Record<string, unknown>) => {
      emailsSent.push(msg);
      return emailResult;
    }),
  });
  fake(vercelBlobPath, {
    put: vi.fn(async (key: string, bytes: Buffer, opts: { contentType: string }) => {
      puts.push({ key, bytes: bytes.length, contentType: opts.contentType });
      return { url: `memory://${key}`, pathname: key };
    }),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("photo-1") || u.includes("pdf")) {
        return { ok: true, arrayBuffer: async () => Uint8Array.from([255, 216, 255]).buffer };
      }
      return { ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
    })
  );

  handler = requireFromHere(handlerPath);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api/itp-simple (#912 + 2026-11-02 redesign)", () => {
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

  it("read-only users can GET (and mark the walkthrough) but every other write 403s", async () => {
    writable = false;
    expect((await call({ method: "GET" })).statusCode).toBe(200);
    expect((await call({ method: "POST", body: { title: "X" } })).statusCode).toBe(403);
    expect(
      (
        await call({
          method: "POST",
          query: { action: "area" },
          body: { reportId: "r1", name: "Roof" },
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await call({
          method: "POST",
          query: { action: "send" },
          body: { pdfId: "pdf1", to: "office" },
        })
      ).statusCode
    ).toBe(403);
    expect((await call({ method: "PUT", query: { action: "walkthrough" } })).statusCode).toBe(200);
    expect(store.createReport).not.toHaveBeenCalled();
    expect(store.markWalkthroughSeen).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-1",
      "u_sparky"
    );
  });

  it("503s honestly when the tenant row is missing (store not provisioned)", async () => {
    store.resolveTenantId.mockResolvedValueOnce(null);
    const res = await call({ method: "GET" });
    expect(res.statusCode).toBe(503);
  });

  it("lists reports with the badge facts: pdf count, stale count, last send, walkthrough flag", async () => {
    const stalePdf = pdfRowFor(REPORT, ["a1"], { id: "pdf-stale", contentKey: "old" });
    const freshPdf = pdfRowFor(REPORT, ["a2"], { id: "pdf-fresh" });
    store.reportFacts.mockResolvedValueOnce({
      pdfsByReport: new Map([["r1", [freshPdf, stalePdf]]]),
      areasByReport: new Map([
        [
          "r1",
          REPORT.areas.map((a) => ({
            id: a.id,
            name: a.name,
            photos: a.photos.map((p) => ({ id: p.id, caption: p.caption })),
          })),
        ],
      ]),
      lastSendByReport: new Map([
        [
          "r1",
          {
            kind: "office",
            recipient: "office@x.com",
            sentAt: "2026-07-18T07:00:00Z",
            result: "sent",
          },
        ],
      ]),
    });
    officeEmail = "office@x.com";
    const res = await call({ method: "GET" });
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      job: { name: string };
      reports: Array<Record<string, unknown>>;
      walkthroughSeen: boolean;
      officeEmailSet: boolean;
    };
    expect(body.job.name).toBe("100 Arthur St");
    expect(body.reports).toHaveLength(1);
    expect(body.reports[0]).toMatchObject({
      pdfCount: 2,
      staleCount: 1,
      lastMadeAt: "2026-07-18T04:00:00Z",
    });
    expect(body.reports[0]!.lastSend).toMatchObject({
      kind: "office",
      sentAt: "2026-07-18T07:00:00Z",
    });
    expect(body.walkthroughSeen).toBe(false);
    expect(body.officeEmailSet).toBe(true);
    expect(store.listReports).toHaveBeenCalledWith(expect.anything(), "tenant-1", "j1");
  });

  it("creates a report with a clean title and rejects a blank one", async () => {
    expect((await call({ method: "POST", body: { title: "  " } })).statusCode).toBe(400);
    const res = await call({ method: "POST", body: { title: "  ITP · Fri 30 Oct  " } });
    expect(res.statusCode).toBe(200);
    expect(store.createReport).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-1",
      expect.objectContaining({ jobLegacyId: "j1", title: "ITP · Fri 30 Oct" })
    );
  });

  it("report GET carries pdfs (with stale), sends, recent names (job first, minus this ITP's), email chips, office", async () => {
    store.listPdfs.mockResolvedValueOnce([
      pdfRowFor(REPORT, ["a1"], { contentKey: "stale-key" }),
      pdfRowFor(REPORT, ["a2"], { id: "pdf2" }),
    ]);
    officeEmail = "office@x.com";
    const res = await call({ method: "GET", query: { id: "r1" } });
    expect(res.statusCode).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(
      (body.pdfs as Array<{ id: string; stale: boolean }>).map((p) => [p.id, p.stale])
    ).toEqual([
      ["pdf1", true],
      ["pdf2", false],
    ]);
    // Job area names first (Garage; Kitchen is already in this ITP), then the last ITP's (Laundry).
    expect(body.recentNames).toEqual(["Garage", "Laundry"]);
    expect(body.emailSuggestions).toEqual(["sam@builder.com.au"]);
    expect(body.officeEmail).toBe("office@x.com");
  });

  it("returns 404 for a report/area another job owns (store scoping says no)", async () => {
    store.getReport.mockResolvedValueOnce(null);
    expect((await call({ method: "GET", query: { id: "r-other" } })).statusCode).toBe(404);

    store.addArea.mockResolvedValueOnce(null);
    expect(
      (
        await call({
          method: "POST",
          query: { action: "area" },
          body: { reportId: "r-other", name: "Roof" },
        })
      ).statusCode
    ).toBe(404);
  });

  it("uploads a photo then attaches it; a bad areaId 404s after upload; captions save", async () => {
    const dataUrl = "data:image/jpeg;base64," + Buffer.from("fake-jpeg").toString("base64");
    const ok = await call({
      method: "POST",
      query: { action: "photo" },
      body: { areaId: "a1", dataUrl },
    });
    expect(ok.statusCode).toBe(200);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toMatch(/^jobs\/j1\/itp-simple\//);

    expect(
      (
        await call({
          method: "POST",
          query: { action: "photo" },
          body: { areaId: "a1", dataUrl: "garbage" },
        })
      ).statusCode
    ).toBe(400);

    store.addPhoto.mockResolvedValueOnce(null);
    expect(
      (
        await call({
          method: "POST",
          query: { action: "photo" },
          body: { areaId: "a-other", dataUrl },
        })
      ).statusCode
    ).toBe(404);

    expect(
      (
        await call({
          method: "PUT",
          query: { action: "photo" },
          body: { id: "p1", caption: "  GPO heights  " },
        })
      ).statusCode
    ).toBe(200);
    expect(store.updatePhotoCaption).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-1",
      "j1",
      "p1",
      "GPO heights"
    );
  });

  it("makes a PDF of the ticked areas: default name, snapshot + fingerprint, photo fetch failure degrades, stored + stamped", async () => {
    const res = await call({
      method: "POST",
      query: { action: "pdf" },
      body: { reportId: "r1", areaIds: ["a2"] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.body as { pdf: Record<string, unknown> };
    expect(body.pdf.name).toBe("Switchboard");
    expect(body.pdf.nameIsAuto).toBe(true);
    expect(body.pdf.areaIds).toEqual(["a2"]);
    expect(body.pdf.photoCount).toBe(1);
    expect(body.pdf.stale).toBe(false);
    expect(body.pdf.contentKey).toBe(model.liveContentKey(REPORT, ["a2"]));
    expect(puts.some((p) => p.contentType === "application/pdf")).toBe(true);
    expect(store.stampPdf).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-1",
      "j1",
      "r1",
      body.pdf.url
    );
    // The composer got the "2 of 4"-style summary and a null for the unfetchable photo.
    expect(composeCalls[0]).toMatchObject({
      name: "Switchboard",
      areaSummary: "Switchboard (1 of 2)",
    });
    const areas = composeCalls[0]!.areas as Array<{ photos: Array<{ bytes: unknown }> }>;
    expect(areas[0]!.photos[0]!.bytes).toBeNull();

    // All areas + a typed name.
    const all = await call({
      method: "POST",
      query: { action: "pdf" },
      body: { reportId: "r1", name: "Rough-in for builder" },
    });
    expect((all.body as { pdf: Record<string, unknown> }).pdf).toMatchObject({
      name: "Rough-in for builder",
      nameIsAuto: false,
      areaCount: 2,
    });
  });

  it("refuses an empty tick and the photo cap with the handoff wording", async () => {
    store.getReport.mockResolvedValueOnce({ ...structuredClone(REPORT), areas: [] });
    expect(
      String(
        (
          (await call({ method: "POST", query: { action: "pdf" }, body: { reportId: "r1" } }))
            .body as { error: string }
        ).error
      )
    ).toBe("Tick at least one area.");

    const bigReport = structuredClone(REPORT);
    bigReport.areas[0]!.photos = Array.from({ length: 130 }, (_, i) => ({
      id: `p${i}`,
      url: `memory://photo-${i}`,
      pathname: null as unknown as string,
      caption: "",
      takenBy: "",
      createdAt: "2026-07-18T01:00:00Z",
    }));
    store.getReport.mockResolvedValueOnce(bigReport);
    const res = await call({ method: "POST", query: { action: "pdf" }, body: { reportId: "r1" } });
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe(
      "Kitchen has 130 photos — one PDF holds 120. Remove some from Kitchen."
    );

    const spread = structuredClone(REPORT);
    spread.areas[0]!.photos = Array.from({ length: 70 }, (_, i) => ({
      id: `k${i}`,
      url: "memory://x",
      pathname: "",
      caption: "",
      takenBy: "",
      createdAt: "2026-07-18T01:00:00Z",
    }));
    spread.areas[1]!.photos = Array.from({ length: 60 }, (_, i) => ({
      id: `s${i}`,
      url: "memory://x",
      pathname: "",
      caption: "",
      takenBy: "",
      createdAt: "2026-07-18T01:00:00Z",
    }));
    store.getReport.mockResolvedValueOnce(spread);
    const res2 = await call({ method: "POST", query: { action: "pdf" }, body: { reportId: "r1" } });
    expect((res2.body as { error: string }).error).toBe(
      "130 photos — one PDF holds 120. Untick some areas. Make a second PDF for the rest."
    );
  });

  it("make again keeps the areas + name and replaces the file; rename re-renders from the snapshot without touching made-at", async () => {
    store.getPdf.mockResolvedValue(
      pdfRowFor(REPORT, ["a1"], { contentKey: "stale", nameIsAuto: false, name: "For the builder" })
    );
    const again = await call({ method: "POST", query: { action: "pdf" }, body: { pdfId: "pdf1" } });
    expect(again.statusCode).toBe(200);
    expect(store.replacePdfFile).toHaveBeenCalledWith(
      expect.anything(),
      "pdf1",
      expect.objectContaining({
        name: "For the builder",
        touchMadeAt: true,
        contentKey: model.liveContentKey(REPORT, ["a1"]),
      })
    );

    const renamed = await call({
      method: "PUT",
      query: { action: "pdf" },
      body: { id: "pdf1", name: "Kitchen only" },
    });
    expect(renamed.statusCode).toBe(200);
    const last = store.replacePdfFile.mock.calls.at(-1)![2];
    expect(last).toMatchObject({ name: "Kitchen only", nameIsAuto: false, touchMadeAt: false });
    expect(last.snapshot).toBeUndefined();
    expect(composeCalls.at(-1)).toMatchObject({ name: "Kitchen only" });

    // Empty name → back to the area names.
    await call({ method: "PUT", query: { action: "pdf" }, body: { id: "pdf1", name: "" } });
    expect(store.replacePdfFile.mock.calls.at(-1)![2]).toMatchObject({
      name: "Kitchen",
      nameIsAuto: true,
    });
  });

  it("send to office needs the office setting; email needs a real address; the mail service decides 'sent'", async () => {
    store.getPdf.mockResolvedValue(pdfRowFor(REPORT, ["a1", "a2"]));
    const noOffice = await call({
      method: "POST",
      query: { action: "send" },
      body: { pdfId: "pdf1", to: "office" },
    });
    expect(noOffice.statusCode).toBe(409);
    expect(emailsSent).toHaveLength(0);

    const badAddr = await call({
      method: "POST",
      query: { action: "send" },
      body: { pdfId: "pdf1", to: "email", email: "sam@builder" },
    });
    expect(badAddr.statusCode).toBe(400);
    expect((badAddr.body as { error: string }).error).toBe(
      "That doesn't look like an email address."
    );

    officeEmail = "office@buhl.com.au";
    const ok = await call({
      method: "POST",
      query: { action: "send" },
      body: { pdfId: "pdf1", to: "email", email: "sam@builder.com.au", note: "Rough-in done" },
    });
    expect(ok.statusCode).toBe(200);
    expect(emailsSent).toHaveLength(1);
    expect(emailsSent[0]).toMatchObject({
      to: "sam@builder.com.au",
      subject: "All areas — 100 Arthur St",
      from: "BuhlOS Reports <reports@buhlos.com>",
      replyTo: "office@buhl.com.au",
    });
    expect((emailsSent[0]!.attachments as Array<{ filename: string }>)[0]!.filename).toBe(
      "All-areas.pdf"
    );
    expect(String(emailsSent[0]!.text)).toContain("Rough-in done");
    expect(store.logSend).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-1",
      "j1",
      "r1",
      expect.objectContaining({
        pdfId: "pdf1",
        kind: "email",
        recipient: "sam@builder.com.au",
        result: "sent",
        attached: true,
      })
    );
    expect((ok.body as { send: { result: string } }).send.result).toBe("sent");
    // Not stale → not remade.
    expect(store.replacePdfFile).not.toHaveBeenCalled();

    // Office send.
    const office = await call({
      method: "POST",
      query: { action: "send" },
      body: { pdfId: "pdf1", to: "office" },
    });
    expect(office.statusCode).toBe(200);
    expect(emailsSent[1]).toMatchObject({ to: "office@buhl.com.au" });
  });

  it("a stale PDF is made again before it goes; a failed send is logged and reported, never shown as sent", async () => {
    officeEmail = "office@buhl.com.au";
    store.getPdf.mockResolvedValue(pdfRowFor(REPORT, ["a1"], { contentKey: "stale" }));
    emailResult = { ok: false, reason: "provider_error" };
    const res = await call({
      method: "POST",
      query: { action: "send" },
      body: { pdfId: "pdf1", to: "office" },
    });
    expect(store.replacePdfFile).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(502);
    expect((res.body as { error: string }).error).toContain("Didn't send");
    expect(store.logSend).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-1",
      "j1",
      "r1",
      expect.objectContaining({ kind: "office", result: "failed", failure: "provider_error" })
    );
  });

  it("says so when email isn't configured on the server", async () => {
    emailConfigured = false;
    store.getPdf.mockResolvedValue(pdfRowFor(REPORT, ["a1"]));
    const res = await call({
      method: "POST",
      query: { action: "send" },
      body: { pdfId: "pdf1", to: "email", email: "sam@builder.com.au" },
    });
    expect(res.statusCode).toBe(503);
    expect(store.logSend).not.toHaveBeenCalled();
  });

  it("routes area rename/delete and photo delete with not-found honesty", async () => {
    expect(
      (
        await call({
          method: "PUT",
          query: { action: "area" },
          body: { id: "a1", name: "Roof void" },
        })
      ).statusCode
    ).toBe(200);
    store.deleteArea.mockResolvedValueOnce(false);
    expect(
      (await call({ method: "DELETE", query: { action: "area" }, body: { id: "a-other" } }))
        .statusCode
    ).toBe(404);
    expect(
      (await call({ method: "DELETE", query: { action: "photo" }, body: { id: "p1" } })).statusCode
    ).toBe(200);
    store.getPdf.mockResolvedValueOnce(null);
    expect(
      (await call({ method: "PUT", query: { action: "pdf" }, body: { id: "nope", name: "x" } }))
        .statusCode
    ).toBe(404);
  });
});
