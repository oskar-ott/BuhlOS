import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for api/job-doc-import.js — the real serverless handler for
 * the read-only pricing/BOQ workbook import preview (#365). Mirrors the
 * material-requests-api.test.ts pattern: cache-inject a mocked blob, sign a real
 * HMAC session, call the handler. Asserts the auth gate, the dark flag gate, the
 * .xlsx-only guard, parse failures, and — critically — that the handler NEVER
 * writes (the read-only contract).
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const ffPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const handlerPath = requireFromHere.resolve("../../../api/job-doc-import.js");

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

let store: Map<string, unknown>;
let writeSpy: ReturnType<typeof vi.fn>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
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

function cookieFor(userId: string, role: string): string {
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
}

async function call(opts: {
  method: string;
  role?: string;
  userId?: string;
  body?: unknown;
  query?: Record<string, string>;
  anon?: boolean;
}) {
  const res = createRes();
  const req = {
    method: opts.method,
    query: opts.query || {},
    body: opts.body,
    headers: opts.anon ? {} : { cookie: cookieFor(opts.userId || "u_boss", opts.role || "boss") },
  };
  await handler(req, res);
  return res;
}

// A minimal valid (stored) .xlsx with a one-line lighting BOQ — same container
// shape as the boq-import.test.ts fixture, enough to exercise the full
// extract→parse path through the handler.
function makeXlsx(files: Record<string, string>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8");
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

function xlsxDataUrl(): string {
  const xlsx = makeXlsx({
    "xl/workbook.xml": `<?xml version="1.0"?><workbook><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/sharedStrings.xml":
      `<sst>` +
      `<si><t>Lighting Tender A supply and install</t></si>` +
      `<si><t>item</t></si><si><t>quantity</t></si>` +
      `<si><t>Supply and install L1.1 - Sasso 40</t></si>` +
      `<si><t>LIGHTING TOTAL</t></si>` +
      `</sst>`,
    "xl/worksheets/sheet1.xml":
      `<worksheet><sheetData>` +
      `<row r="1"><c r="A1" t="s"><v>0</v></c></row>` +
      `<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="s"><v>2</v></c></row>` +
      `<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>16</v></c><c r="C3"><v>275</v></c><c r="D3"><v>4400</v></c><c r="E3"><v>110</v></c><c r="F3"><v>1760</v></c></row>` +
      `<row r="4"><c r="A4" t="s"><v>4</v></c><c r="D4"><v>6160</v></c></row>` +
      `</sheetData></worksheet>`,
  });
  return `data:${XLSX_MIME};base64,${xlsx.toString("base64")}`;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  delete process.env.FLAG_JOB_DOC_IMPORT;
  store = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_boss", username: "boss", role: "boss", assignedJobIds: [] },
          { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: [] },
        ],
      },
    ],
  ]);
  writeSpy = vi.fn(async (key: string, data: unknown) => {
    store.set(key, clone(data));
  });

  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[ffPath];
  delete requireFromHere.cache[handlerPath];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        store.has(key) ? clone(store.get(key)) : fallback
      ),
      readBlobFresh: vi.fn(async (key: string, fallback: unknown) =>
        store.has(key) ? clone(store.get(key)) : fallback
      ),
      writeBlob: writeSpy,
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

afterEach(() => {
  delete process.env.FLAG_JOB_DOC_IMPORT;
});

describe("api/job-doc-import — auth + dark flag gate", () => {
  it("anonymous → 401", async () => {
    const res = await call({ method: "POST", anon: true, body: {} });
    expect(res.statusCode).toBe(401);
  });

  it("non-admin (field) → 403, before the flag is even consulted", async () => {
    process.env.FLAG_JOB_DOC_IMPORT = "1";
    const res = await call({
      method: "POST",
      role: "electrician",
      userId: "u_field",
      body: { dataUrl: xlsxDataUrl(), mimeType: XLSX_MIME },
    });
    expect(res.statusCode).toBe(403);
  });

  it("admin but flag OFF → 404 (surface stays invisible)", async () => {
    process.env.FLAG_JOB_DOC_IMPORT = "0";
    const res = await call({
      method: "POST",
      body: { dataUrl: xlsxDataUrl(), mimeType: XLSX_MIME },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("api/job-doc-import — read-only preview (admin, flag on)", () => {
  beforeEach(() => {
    process.env.FLAG_JOB_DOC_IMPORT = "1";
  });

  it("parses a valid .xlsx → 200 preview, and WRITES NOTHING", async () => {
    const res = await call({
      method: "POST",
      body: { fileName: "REV5.xlsx", mimeType: XLSX_MIME, dataUrl: xlsxDataUrl() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.body as { preview: { counts: { lines: number } }; readOnly: boolean };
    expect(body.readOnly).toBe(true);
    expect(body.preview.counts.lines).toBeGreaterThanOrEqual(1);
    // the read-only contract: not a single blob write on the success path
    expect(writeSpy).toHaveBeenCalledTimes(0);
  });

  it("missing dataUrl → 400", async () => {
    const res = await call({ method: "POST", body: {} });
    expect(res.statusCode).toBe(400);
  });

  it("a non-.xlsx file type → 400", async () => {
    const res = await call({
      method: "POST",
      body: { mimeType: "application/pdf", dataUrl: "data:application/pdf;base64,JVBERi0=" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("an .xlsx mime over unreadable bytes → 422, still writes nothing", async () => {
    const res = await call({
      method: "POST",
      body: {
        mimeType: XLSX_MIME,
        dataUrl: `data:${XLSX_MIME};base64,${Buffer.from("not a zip at all").toString("base64")}`,
      },
    });
    expect(res.statusCode).toBe(422);
    expect(writeSpy).toHaveBeenCalledTimes(0);
  });

  it("a genuinely unsupported method (PUT) → 405", async () => {
    // GET is now the cost-basis read + POST is preview/create; PUT is unsupported.
    const res = await call({ method: "PUT" });
    expect(res.statusCode).toBe(405);
  });
});

describe("api/job-doc-import?action=create-job — the #365 write-half", () => {
  beforeEach(() => {
    process.env.FLAG_JOB_DOC_IMPORT = "1";
    store.set("jobs.json", { jobs: [] });
  });

  it("creates a real DRAFT job through the sanctioned path + attaches the cost basis", async () => {
    const res = await call({
      method: "POST",
      query: { action: "create-job" },
      body: { name: "Sansara Gym Double Bay", fileName: "REV5.xlsx", mimeType: XLSX_MIME, dataUrl: xlsxDataUrl() },
    });
    expect(res.statusCode).toBe(201);
    const body = res.body as {
      jobId: string;
      job: { id: string; name: string; status: string };
      costBasis: { lines: number; total: number };
    };
    expect(body.job.status).toBe("draft");
    expect(body.job.name).toBe("Sansara Gym Double Bay");
    expect(body.costBasis.lines).toBeGreaterThanOrEqual(1);

    // The job landed in jobs.json via createJob (the sole sanctioned writer):
    // born structure-less (no fabricated areas/tasks — a BOQ carries neither).
    const jobs = (store.get("jobs.json") as { jobs: Array<{ id: string; status: string; areaGroups: unknown[] }> }).jobs;
    const created = jobs.find((j) => j.id === body.jobId);
    expect(created).toBeTruthy();
    expect(created?.status).toBe("draft");
    expect(created?.areaGroups).toEqual([]);

    // The parsed bill was attached as the job's cost basis (provenance + lines).
    const cost = store.get(`jobs/${body.jobId}/cost-import.json`) as {
      source: string;
      importedById: string;
      preview: { counts: { lines: number } };
    };
    expect(cost.source).toBe("boq-import");
    expect(cost.importedById).toBe("u_boss");
    expect(cost.preview.counts.lines).toBe(body.costBasis.lines);
  });

  it("a missing name → 400 (and no job is written)", async () => {
    const res = await call({
      method: "POST",
      query: { action: "create-job" },
      body: { fileName: "REV5.xlsx", mimeType: XLSX_MIME, dataUrl: xlsxDataUrl() },
    });
    expect(res.statusCode).toBe(400);
    expect((store.get("jobs.json") as { jobs: unknown[] }).jobs).toHaveLength(0);
  });

  it("a duplicate job id → 400 (createJob rejects the collision)", async () => {
    const first = await call({
      method: "POST",
      query: { action: "create-job" },
      body: { name: "Sansara Gym", mimeType: XLSX_MIME, dataUrl: xlsxDataUrl() },
    });
    expect(first.statusCode).toBe(201);
    const second = await call({
      method: "POST",
      query: { action: "create-job" },
      body: { name: "Sansara Gym", mimeType: XLSX_MIME, dataUrl: xlsxDataUrl() },
    });
    expect(second.statusCode).toBe(400);
  });

  it("an unparseable workbook → 422 (and no job is written)", async () => {
    const res = await call({
      method: "POST",
      query: { action: "create-job" },
      body: {
        name: "Sansara Gym",
        mimeType: XLSX_MIME,
        dataUrl: `data:${XLSX_MIME};base64,${Buffer.from("not a zip at all").toString("base64")}`,
      },
    });
    expect(res.statusCode).toBe(422);
    expect((store.get("jobs.json") as { jobs: unknown[] }).jobs).toHaveLength(0);
  });

  it("admin but flag OFF → 404 (the write path is invisible too)", async () => {
    process.env.FLAG_JOB_DOC_IMPORT = "0";
    const res = await call({
      method: "POST",
      query: { action: "create-job" },
      body: { name: "Sansara Gym", mimeType: XLSX_MIME, dataUrl: xlsxDataUrl() },
    });
    expect(res.statusCode).toBe(404);
  });

  it("non-admin (field) → 403", async () => {
    const res = await call({
      method: "POST",
      role: "electrician",
      userId: "u_field",
      query: { action: "create-job" },
      body: { name: "Sansara Gym", mimeType: XLSX_MIME, dataUrl: xlsxDataUrl() },
    });
    expect(res.statusCode).toBe(403);
  });

  it("round-trip: create-job then GET returns the attached cost basis", async () => {
    const created = await call({
      method: "POST",
      query: { action: "create-job" },
      body: { name: "Sansara Gym", fileName: "REV5.xlsx", mimeType: XLSX_MIME, dataUrl: xlsxDataUrl() },
    });
    expect(created.statusCode).toBe(201);
    const jobId = (created.body as { jobId: string }).jobId;

    const got = await call({ method: "GET", query: { jobId } });
    expect(got.statusCode).toBe(200);
    const cost = (got.body as {
      costImport: { source: string; total: number; lines: number; fileName: string };
    }).costImport;
    expect(cost.source).toBe("boq-import");
    expect(cost.fileName).toBe("REV5.xlsx");
    expect(cost.lines).toBeGreaterThanOrEqual(1);
    expect(cost.total).toBeGreaterThan(0);
  });
});

describe("api/job-doc-import GET — the hub cost-basis read", () => {
  beforeEach(() => {
    process.env.FLAG_JOB_DOC_IMPORT = "1";
  });

  it("projects a stored cost-import.json into the headline summary", async () => {
    store.set("jobs/sansara/cost-import.json", {
      source: "boq-import",
      importedAt: "2026-06-28T00:00:00Z",
      importedById: "u_boss",
      importedByName: "boss",
      fileName: "REV5.xlsx",
      preview: {
        totals: { computed: 7110, stated: 7160, delta: -50, reconciles: false },
        counts: { lines: 2, byFlag: {} },
        sections: [{ key: "lighting" }, { key: "electrical" }],
      },
    });
    const res = await call({ method: "GET", query: { jobId: "sansara" } });
    expect(res.statusCode).toBe(200);
    const cost = (res.body as {
      costImport: {
        total: number;
        stated: number;
        delta: number;
        reconciles: boolean;
        lines: number;
        sections: number;
        fileName: string;
      };
    }).costImport;
    expect(cost.total).toBe(7110);
    expect(cost.stated).toBe(7160);
    expect(cost.delta).toBe(-50);
    expect(cost.reconciles).toBe(false);
    expect(cost.lines).toBe(2);
    expect(cost.sections).toBe(2);
    expect(cost.fileName).toBe("REV5.xlsx");
  });

  it("a job with no import → costImport null (the card stays hidden)", async () => {
    const res = await call({ method: "GET", query: { jobId: "never-imported" } });
    expect(res.statusCode).toBe(200);
    expect((res.body as { costImport: unknown }).costImport).toBeNull();
  });

  it("missing jobId → 400", async () => {
    const res = await call({ method: "GET", query: {} });
    expect(res.statusCode).toBe(400);
  });

  it("admin but flag OFF → 404 (the read is invisible too)", async () => {
    process.env.FLAG_JOB_DOC_IMPORT = "0";
    const res = await call({ method: "GET", query: { jobId: "sansara" } });
    expect(res.statusCode).toBe(404);
  });

  it("non-admin (field) → 403", async () => {
    const res = await call({
      method: "GET",
      role: "electrician",
      userId: "u_field",
      query: { jobId: "sansara" },
    });
    expect(res.statusCode).toBe(403);
  });
});
