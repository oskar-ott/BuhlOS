import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #197 — Epic 5 page understanding against the REAL api/ai-drawings.js:
 *   * dark flag (404 when off), auth + role gates
 *   * understand-page: happy path (extraction + projection + spend recorded
 *     EXACTLY once into the shared #510 ledger + audit), cache hit (no second
 *     AI call, no second spend), cap → 402 before any call, unusable model
 *     output → 502 with spend still recorded and NOTHING persisted (P7)
 *   * override / clear-override: corrections win on read, survive re-runs,
 *     sheetType vocabulary enforced, audit trail
 *   * honest 503 when the extraction store isn't reachable
 * plus the pure effective-merge / needs-review derivation via __test.
 *
 * The Supabase store (api/_lib/ai-drawings-store.js) is replaced with an
 * in-memory fake implementing the same seam; blob is the faithful __rev-
 * stamping map from the #510 spend test so commitTakeoff's CAS is real.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const aiPath = requireFromHere.resolve("../../../api/_lib/ai.js");
const dbPath = requireFromHere.resolve("../../../api/_lib/supabase-db.js");
const storePath = requireFromHere.resolve("../../../api/_lib/ai-drawings-store.js");
const aiSpendPath = requireFromHere.resolve("../../../api/_lib/ai-spend.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const flagsPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const handlerPath = requireFromHere.resolve("../../../api/ai-drawings.js");

type Res = ReturnType<typeof createRes>;
type Row = Record<string, unknown>;

let blob: Map<string, unknown>;
let extractions: Row[];
let sheetRows: Row[];
let overrides: Row[];
let auditEntries: Row[];
let aiCalls: Array<Record<string, unknown>>;
let aiNextText: string;
let aiFail: { code: string } | null;
let dbAvailable: boolean;
let insertRaceWinner: Row | null; // simulates a concurrent run winning the unique index
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;
let testExports: {
  effectiveSheet: (row: Row, ovr: Row[]) => Record<string, any>;
  cleanValue: (v: unknown) => string | null;
  extractJson: (t: string) => unknown;
  REVIEW_THRESHOLD: number;
  PROMPT_VERSION: string;
};

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function createRes() {
  return {
    statusCode: 200,
    body: null as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
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

function staleError() {
  const e = new Error("stale write") as Error & { code: string };
  e.code = "stale_write";
  return e;
}

class FakeAiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AiError";
    this.code = code;
  }
}

const GOOD_OUTPUT = {
  sheetType: "floorPlan",
  sheetTypeConfidence: 0.95,
  titleBlock: {
    sheetNumber: { value: "E-101", confidence: 0.9 },
    sheetTitle: { value: "LEVEL 1 POWER", confidence: 0.92 },
    revision: { value: "C", confidence: 0.85 },
    scale: { value: "1:100", confidence: 0.9 },
  },
  notes: null,
};

function extractionColumns(row: Row): Row {
  // mirror the real store's camelCase→snake_case insert mapping
  return {
    job_id: row.jobId,
    plan_id: row.planId,
    page_index: row.pageIndex,
    page_sha256: row.pageSha256,
    kind: row.kind,
    model: row.model,
    prompt_version: row.promptVersion,
    raw: row.raw,
    sheet_type: row.sheetType,
    sheet_type_confidence: row.sheetTypeConfidence,
    sheet_number: row.sheetNumber,
    sheet_number_confidence: row.sheetNumberConfidence,
    sheet_title: row.sheetTitle,
    sheet_title_confidence: row.sheetTitleConfidence,
    revision: row.revision,
    revision_confidence: row.revisionConfidence,
    scale: row.scale,
    scale_confidence: row.scaleConfidence,
    region: row.region,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    created_by_label: row.createdByLabel,
  };
}

function sheetFromExtraction(e: Row): Row {
  return {
    job_id: e.job_id,
    plan_id: e.plan_id,
    page_index: e.page_index,
    extraction_id: e.id,
    page_sha256: e.page_sha256,
    sheet_type: e.sheet_type,
    sheet_type_confidence: e.sheet_type_confidence,
    sheet_number: e.sheet_number,
    sheet_number_confidence: e.sheet_number_confidence,
    sheet_title: e.sheet_title,
    sheet_title_confidence: e.sheet_title_confidence,
    revision: e.revision,
    revision_confidence: e.revision_confidence,
    scale: e.scale,
    scale_confidence: e.scale_confidence,
    model: e.model,
    prompt_version: e.prompt_version,
    updated_at: new Date().toISOString(),
  };
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map();
  extractions = [];
  sheetRows = [];
  overrides = [];
  auditEntries = [];
  aiCalls = [];
  aiNextText = JSON.stringify(GOOD_OUTPUT);
  aiFail = null;
  dbAvailable = true;
  insertRaceWinner = null;
  process.env.FLAG_AI_DRAWINGS = "1";

  delete requireFromHere.cache[handlerPath];
  delete requireFromHere.cache[aiSpendPath];
  delete requireFromHere.cache[flagsPath];

  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback,
      readBlobFresh: async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback,
      readBlobStrict: async (key: string) => {
        if (!blob.has(key)) throw new Error("missing " + key);
        return clone(blob.get(key));
      },
      writeBlob: async (
        key: string,
        data: Record<string, unknown>,
        opts: { expectedRev?: number } = {},
      ) => {
        const current = blob.get(key) as { __rev?: number } | undefined;
        const currentRev =
          current && Number.isFinite(current.__rev) ? (current.__rev as number) : 0;
        if (
          opts.expectedRev !== undefined &&
          opts.expectedRev !== null &&
          Number(opts.expectedRev) !== currentRev
        ) {
          throw staleError();
        }
        blob.set(key, clone({ ...data, __rev: currentRev + 1 }));
      },
      setNoCache: () => {},
    },
  } as NodeJS.Module;

  requireFromHere.cache[auditPath] = {
    id: auditPath,
    filename: auditPath,
    loaded: true,
    exports: {
      append: async (p: Row) => {
        auditEntries.push(p);
        return { id: "al_test" };
      },
    },
  } as NodeJS.Module;

  requireFromHere.cache[aiPath] = {
    id: aiPath,
    filename: aiPath,
    loaded: true,
    exports: {
      AiError: FakeAiError,
      isAiConfigured: () => true,
      aiComplete: async (opts: Record<string, unknown>) => {
        if (aiFail) throw new FakeAiError(aiFail.code, "ai failed (test)");
        aiCalls.push(opts);
        return {
          text: aiNextText,
          usage: { inputTokens: 5000, outputTokens: 800 },
          model: "claude-opus-4-8",
        };
      },
    },
  } as NodeJS.Module;

  requireFromHere.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      getDb: () => {
        if (!dbAvailable) {
          const e = new Error("SUPABASE_DB_URL missing") as Error & { code: string };
          e.code = "MISSING_ENV";
          throw e;
        }
        return {};
      },
    },
  } as NodeJS.Module;

  requireFromHere.cache[storePath] = {
    id: storePath,
    filename: storePath,
    loaded: true,
    exports: {
      OVERRIDE_FIELDS: ["sheetType", "sheetNumber", "sheetTitle", "revision", "scale"],
      SHEET_TYPES: [
        "floorPlan",
        "schematic",
        "schedule",
        "legend",
        "titleCover",
        "detail",
        "other",
      ],
      resolveTenantId: async () => "tenant-1",
      findCachedExtraction: async (_sql: unknown, _t: string, key: Row) =>
        extractions.find(
          (e) =>
            e.job_id === key.jobId &&
            e.plan_id === key.planId &&
            e.page_index === key.pageIndex &&
            e.page_sha256 === key.pageSha256 &&
            e.kind === key.kind &&
            e.prompt_version === key.promptVersion &&
            e.model === key.model,
        ) ?? null,
      insertExtraction: async (_sql: unknown, _t: string, row: Row) => {
        if (insertRaceWinner) {
          // the "other" concurrent request landed first — its row is already
          // in the table and this insert violates the unique cache index
          extractions.push(insertRaceWinner);
          insertRaceWinner = null;
          const err = new Error("duplicate key value violates unique constraint") as Error & {
            code: string;
          };
          err.code = "23505";
          throw err;
        }
        const e = { id: `ex_${extractions.length + 1}`, ...extractionColumns(row) };
        extractions.push(e);
        return e;
      },
      upsertPlanSheet: async (_sql: unknown, _t: string, e: Row) => {
        const next = sheetFromExtraction(e);
        const i = sheetRows.findIndex(
          (r) =>
            r.job_id === e.job_id &&
            r.plan_id === e.plan_id &&
            r.page_index === e.page_index,
        );
        if (i >= 0) sheetRows[i] = next;
        else sheetRows.push(next);
      },
      listPlanSheets: async (_sql: unknown, _t: string, jobId: string) =>
        sheetRows.filter((r) => r.job_id === jobId),
      listOverrides: async (_sql: unknown, _t: string, jobId: string) =>
        overrides.filter((o) => o.job_id === jobId),
      upsertOverride: async (_sql: unknown, _t: string, o: Row) => {
        const row = {
          job_id: o.jobId,
          plan_id: o.planId,
          page_index: o.pageIndex,
          field: o.field,
          value: o.value,
          corrected_by: o.correctedBy,
          corrected_by_user_id: o.correctedByUserId,
          corrected_at: new Date().toISOString(),
        };
        const i = overrides.findIndex(
          (r) =>
            r.job_id === row.job_id &&
            r.plan_id === row.plan_id &&
            r.page_index === row.page_index &&
            r.field === row.field,
        );
        if (i >= 0) overrides[i] = row;
        else overrides.push(row);
      },
      deleteOverride: async (
        _sql: unknown,
        _t: string,
        jobId: string,
        planId: string,
        pageIndex: number,
        field: string,
      ) => {
        const before = overrides.length;
        overrides = overrides.filter(
          (r) =>
            !(
              r.job_id === jobId &&
              r.plan_id === planId &&
              r.page_index === pageIndex &&
              r.field === field
            ),
        );
        return overrides.length < before;
      },
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath) as typeof auth;
  handler = requireFromHere(handlerPath) as typeof handler;
  testExports = (requireFromHere(handlerPath) as { __test: typeof testExports }).__test;

  // stored page PNGs fetch as bytes
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
  }));

  // requireAuth hydrates the session user from users.json
  blob.set("users.json", {
    users: [
      { id: "u_admin", username: "boss", role: "office", passwordHash: "$2a$10$x" },
      { id: "u_field", username: "mick", role: "tradie", assignedJobIds: [] },
      { id: "u_client", username: "client", role: "client", assignedJobIds: ["j1"] },
    ],
  });

  // one registered plan page on job j1
  blob.set("jobs/j1/plans-index.json", {
    plans: [
      {
        id: "pl1",
        jobId: "j1",
        fileName: "set.pdf",
        status: "current",
        pages: [{ pageIndex: 0, pngUrl: "https://blob.test/pl1-0.png", sha256: "sha0" }],
      },
    ],
    __rev: 1,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FLAG_AI_DRAWINGS;
});

async function call(
  method: string,
  query: Record<string, string>,
  body?: unknown,
  session: Record<string, unknown> = { userId: "u_admin", role: "office" },
): Promise<Res> {
  const res = createRes();
  await handler(
    {
      method,
      query,
      body,
      headers: {
        cookie: `buhl_session=${auth.signSession({ ...session, exp: Date.now() + 60_000 })}`,
      },
    },
    res,
  );
  return res;
}

const spendLedger = () =>
  (blob.get("jobs/j1/ai-takeoff.json") as { spend: { totalUsd: number; calls: Row[] } })
    ?.spend;

describe("gates", () => {
  it("404s every route when the ai_drawings flag is off (dark)", async () => {
    process.env.FLAG_AI_DRAWINGS = "0";
    const res = await call("GET", { jobId: "j1", action: "sheets" });
    expect(res.statusCode).toBe(404);
  });

  it("401s without a session", async () => {
    const res = createRes();
    await handler({ method: "GET", query: { jobId: "j1", action: "sheets" }, headers: {} }, res);
    expect(res.statusCode).toBe(401);
  });

  it("403s a client role", async () => {
    const res = await call("GET", { jobId: "j1", action: "sheets" }, undefined, {
      userId: "u_client",
      role: "client",
    });
    expect(res.statusCode).toBe(403);
  });

  it("stays invisible (404) to field roles — the flag is admin-tier", async () => {
    const res = await call("GET", { jobId: "j1", action: "sheets" }, undefined, {
      userId: "u_field",
      role: "tradie",
    });
    expect(res.statusCode).toBe(404);
  });

  it("503s honestly when the extraction store is unreachable", async () => {
    dbAvailable = false;
    const res = await call("GET", { jobId: "j1", action: "sheets" });
    expect(res.statusCode).toBe(503);
    expect(String(res.body.error)).toMatch(/unavailable/);
  });
});

describe("understand-page", () => {
  it("runs the vision call, persists extraction + projection, records spend once, audits", async () => {
    const res = await call("POST", { jobId: "j1", action: "understand-page" }, {
      planId: "pl1",
      pageIndex: 0,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.cached).toBe(false);
    expect(res.body.sheet.fields.sheetNumber.effective).toBe("E-101");
    expect(res.body.sheet.fields.sheetType.effective).toBe("floorPlan");
    expect(res.body.sheet.needsReview).toBe(false);
    expect(aiCalls).toHaveLength(1);
    expect(extractions).toHaveLength(1);
    expect(extractions[0]?.prompt_version).toBe(testExports.PROMPT_VERSION);
    expect(sheetRows).toHaveLength(1);
    const spend = spendLedger();
    expect(spend.calls).toHaveLength(1);
    expect(spend.calls[0]?.kind).toBe("understand-page");
    expect(spend.totalUsd).toBeGreaterThan(0);
    expect(auditEntries.map((a) => a.action)).toContain("document.ai_extracted");
  });

  it("serves an unchanged page from cache — no second AI call, no second spend", async () => {
    await call("POST", { jobId: "j1", action: "understand-page" }, { planId: "pl1", pageIndex: 0 });
    const res = await call("POST", { jobId: "j1", action: "understand-page" }, {
      planId: "pl1",
      pageIndex: 0,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(aiCalls).toHaveLength(1);
    expect(extractions).toHaveLength(1);
    expect(spendLedger().calls).toHaveLength(1);
  });

  it("402s before spending once the per-job cap is reached", async () => {
    blob.set("jobs/j1/ai-takeoff.json", {
      legendVersion: 0,
      legendItems: [],
      legendSource: null,
      dwellings: {},
      sheetClassifications: {},
      sheetCache: {},
      spend: { totalUsd: 9999, calls: [] },
      createdAt: null,
      updatedAt: null,
      __rev: 1,
    });
    const res = await call("POST", { jobId: "j1", action: "understand-page" }, {
      planId: "pl1",
      pageIndex: 0,
    });
    expect(res.statusCode).toBe(402);
    expect(aiCalls).toHaveLength(0);
    expect(extractions).toHaveLength(0);
  });

  it("502s on unusable model output — spend recorded, NOTHING persisted (P7)", async () => {
    aiNextText = "sorry, I can't read this page";
    const res = await call("POST", { jobId: "j1", action: "understand-page" }, {
      planId: "pl1",
      pageIndex: 0,
    });
    expect(res.statusCode).toBe(502);
    expect(extractions).toHaveLength(0);
    expect(sheetRows).toHaveLength(0);
    expect(spendLedger().calls).toHaveLength(1); // the money was spent — recorded
  });

  it("400s a malformed body and 404s an unregistered page", async () => {
    const bad = await call("POST", { jobId: "j1", action: "understand-page" }, {
      planId: "pl1",
      pageIndex: -2,
    });
    expect(bad.statusCode).toBe(400);
    const missing = await call("POST", { jobId: "j1", action: "understand-page" }, {
      planId: "pl1",
      pageIndex: 7,
    });
    expect(missing.statusCode).toBe(404);
    expect(aiCalls).toHaveLength(0);
  });

  it("503s when AI is unconfigured in the environment", async () => {
    aiFail = { code: "UNCONFIGURED" };
    const res = await call("POST", { jobId: "j1", action: "understand-page" }, {
      planId: "pl1",
      pageIndex: 0,
    });
    expect(res.statusCode).toBe(503);
  });

  it("forwards the title-block crop as a second image and stores the region", async () => {
    const res = await call("POST", { jobId: "j1", action: "understand-page" }, {
      planId: "pl1",
      pageIndex: 0,
      titleBlockCrop: {
        dataUrl: "data:image/png;base64,aGVsbG8=",
        region: { x: 0.55, y: 0.55, w: 0.45, h: 0.45 },
      },
    });
    expect(res.statusCode).toBe(200);
    const content = (aiCalls[0] as { messages: Array<{ content: Array<{ type: string }> }> })
      .messages[0]!.content;
    expect(content.filter((b) => b.type === "image")).toHaveLength(2);
    expect(content.filter((b) => b.type === "text")).toHaveLength(1);
    expect(extractions[0]?.region).toEqual({ x: 0.55, y: 0.55, w: 0.45, h: 0.45 });
  });

  it("a concurrent duplicate insert (unique cache index) serves the winner's row", async () => {
    insertRaceWinner = {
      id: "ex_winner",
      job_id: "j1",
      plan_id: "pl1",
      page_index: 0,
      page_sha256: "sha0",
      kind: "page-understanding",
      model: process.env.AI_DRAWINGS_MODEL || "claude-opus-4-8",
      prompt_version: testExports.PROMPT_VERSION,
      raw: GOOD_OUTPUT,
      sheet_type: "schedule",
      sheet_type_confidence: 0.9,
      sheet_number: "E-777",
      sheet_number_confidence: 0.9,
      sheet_title: "WINNER",
      sheet_title_confidence: 0.9,
      revision: "A",
      revision_confidence: 0.9,
      scale: "1:50",
      scale_confidence: 0.9,
      region: null,
      input_tokens: 1,
      output_tokens: 1,
      created_by_label: "other",
    };
    const res = await call("POST", { jobId: "j1", action: "understand-page" }, {
      planId: "pl1",
      pageIndex: 0,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.sheet.fields.sheetNumber.effective).toBe("E-777"); // winner's row served
    expect(extractions).toHaveLength(1); // no duplicate row
  });
});

describe("review-and-correct loop", () => {
  beforeEach(async () => {
    await call("POST", { jobId: "j1", action: "understand-page" }, { planId: "pl1", pageIndex: 0 });
  });

  it("a correction persists separately, wins on read, and audits", async () => {
    const res = await call("POST", { jobId: "j1", action: "override" }, {
      planId: "pl1",
      pageIndex: 0,
      field: "sheetNumber",
      value: "E-102",
    });
    expect(res.statusCode).toBe(200);
    const f = res.body.sheet.fields.sheetNumber;
    expect(f.effective).toBe("E-102");
    expect(f.override.value).toBe("E-102");
    expect(f.ai.value).toBe("E-101"); // AI value untouched — stored separately
    expect(auditEntries.map((a) => a.action)).toContain("document.ai_corrected");
  });

  it("corrections survive a re-extraction (new page raster)", async () => {
    await call("POST", { jobId: "j1", action: "override" }, {
      planId: "pl1",
      pageIndex: 0,
      field: "revision",
      value: "D",
    });
    // page re-rendered → new sha → fresh extraction run
    blob.set("jobs/j1/plans-index.json", {
      plans: [
        {
          id: "pl1",
          jobId: "j1",
          fileName: "set.pdf",
          status: "current",
          pages: [{ pageIndex: 0, pngUrl: "https://blob.test/pl1-0.png", sha256: "sha1" }],
        },
      ],
      __rev: 2,
    });
    const res = await call("POST", { jobId: "j1", action: "understand-page" }, {
      planId: "pl1",
      pageIndex: 0,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.cached).toBe(false);
    expect(res.body.sheet.fields.revision.effective).toBe("D"); // human still wins
  });

  it("a null correction means 'field is absent' and settles needs-review", async () => {
    const res = await call("POST", { jobId: "j1", action: "override" }, {
      planId: "pl1",
      pageIndex: 0,
      field: "scale",
      value: null,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.sheet.fields.scale.effective).toBe(null);
    expect(res.body.sheet.fields.scale.override).not.toBe(null);
  });

  it("rejects an off-vocabulary sheetType", async () => {
    const res = await call("POST", { jobId: "j1", action: "override" }, {
      planId: "pl1",
      pageIndex: 0,
      field: "sheetType",
      value: "blueprint",
    });
    expect(res.statusCode).toBe(400);
  });

  it("clear-override returns the field to the AI value; clearing nothing is a 404", async () => {
    await call("POST", { jobId: "j1", action: "override" }, {
      planId: "pl1",
      pageIndex: 0,
      field: "sheetTitle",
      value: "FIXED TITLE",
    });
    const cleared = await call("POST", { jobId: "j1", action: "clear-override" }, {
      planId: "pl1",
      pageIndex: 0,
      field: "sheetTitle",
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.body.sheet.fields.sheetTitle.effective).toBe("LEVEL 1 POWER");
    const again = await call("POST", { jobId: "j1", action: "clear-override" }, {
      planId: "pl1",
      pageIndex: 0,
      field: "sheetTitle",
    });
    expect(again.statusCode).toBe(404);
  });

  it("GET sheets returns effective rows + threshold + spend", async () => {
    const res = await call("GET", { jobId: "j1", action: "sheets" });
    expect(res.statusCode).toBe(200);
    expect(res.body.sheets).toHaveLength(1);
    expect(res.body.reviewThreshold).toBe(testExports.REVIEW_THRESHOLD);
    expect(res.body.spend.totalUsd).toBeGreaterThan(0);
    expect(res.body.spend.capUsd).toBeGreaterThan(0);
  });
});

describe("needs-review derivation (pure)", () => {
  const baseRow = {
    plan_id: "pl1",
    page_index: 0,
    page_sha256: "sha0",
    extraction_id: "ex_1",
    model: "m",
    prompt_version: "pu-v1",
    updated_at: "2026-07-02T00:00:00.000Z",
    sheet_type: "floorPlan",
    sheet_type_confidence: 0.95,
    sheet_number: "E-101",
    sheet_number_confidence: 0.9,
    sheet_title: "LEVEL 1 POWER",
    sheet_title_confidence: 0.92,
    revision: "C",
    revision_confidence: 0.85,
    scale: "1:100",
    scale_confidence: 0.9,
  };

  it("confident everywhere → no review needed", () => {
    const s = testExports.effectiveSheet(baseRow, []);
    expect(s.needsReview).toBe(false);
  });

  it("one low-confidence field flags the page", () => {
    const s = testExports.effectiveSheet({ ...baseRow, scale_confidence: 0.4 }, []);
    expect(s.needsReview).toBe(true);
  });

  it("a human override on the weak field settles it", () => {
    const s = testExports.effectiveSheet({ ...baseRow, scale_confidence: 0.4 }, [
      {
        plan_id: "pl1",
        page_index: 0,
        field: "scale",
        value: "1:50",
        corrected_by: "boss",
        corrected_at: "2026-07-02T00:00:00.000Z",
      },
    ]);
    expect(s.needsReview).toBe(false);
    expect(s.fields.scale.effective).toBe("1:50");
  });

  it("a null AI confidence counts as unreviewed", () => {
    const s = testExports.effectiveSheet(
      { ...baseRow, revision: null, revision_confidence: null },
      [],
    );
    expect(s.needsReview).toBe(true);
  });

  it("cleanValue trims and maps empty to null", () => {
    expect(testExports.cleanValue("  E-101 ")).toBe("E-101");
    expect(testExports.cleanValue("")).toBe(null);
    expect(testExports.cleanValue("   ")).toBe(null);
    expect(testExports.cleanValue(null)).toBe(null);
  });

  it("extractJson strips fences and finds the outer object", () => {
    expect(testExports.extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(testExports.extractJson('noise {"a":1} trailing')).toEqual({ a: 1 });
    expect(testExports.extractJson("no json at all")).toBe(null);
  });
});
