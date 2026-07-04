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
const vercelBlobPath = requireFromHere.resolve("@vercel/blob");
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
let legendRows: Row[];
let scheduleTables: Row[];
let scheduleRowsArr: Row[];
let pageDiffsArr: Row[];
let diffRegionsArr: Row[];
let detectionRuns: Row[];
let deviceDetections: Row[];
let detectionReviews: Row[];
let acceptedCounts: Row[];
let roomRows: Row[];
let roomAssignments: Row[];
let boardPins: Row[];
let calibrations: Row[];
let cableRuns: Row[];
let sheetRefsArr: Row[];
let entityLinksArr: Row[];
let takeoffsArr: Row[];
let takeoffLinesArr: Row[];
let blobPuts: Array<{ path: string; bytes: number }>;
let auditEntries: Row[];
let aiCalls: Array<Record<string, unknown>>;
let aiNextText: string;
let aiFail: { code: string } | null;
let dbAvailable: boolean;
let insertRaceWinner: Row | null; // simulates a concurrent run winning the unique index
let detectionRaceWinner: Row | null; // same, for the detection_runs unique index
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;
type EffectiveFieldShape = {
  ai: { value: string | null; confidence: number | null } | null;
  override: { value: string | null } | null;
  effective: string | null;
};
let testExports: {
  effectiveSheet: (
    row: Row,
    ovr: Row[],
  ) => { needsReview: boolean; fields: Record<string, EffectiveFieldShape> };
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- response body asserted per test
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

const normalizeLabel = (label: string) =>
  String(label || "").toLowerCase().trim().replace(/\s+/g, " ");

const LIVE_LEGEND = new Set(["suggested", "accepted", "edited"]);

type Box = { x: number; y: number; w: number; h: number };
// mirrors the real store's clamped IoU
function fakeBoxIoU(a: Box, b: Box): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? Math.min(1, Math.max(0, inter / union)) : 0;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map();
  extractions = [];
  sheetRows = [];
  overrides = [];
  legendRows = [];
  scheduleTables = [];
  scheduleRowsArr = [];
  pageDiffsArr = [];
  diffRegionsArr = [];
  detectionRuns = [];
  deviceDetections = [];
  detectionReviews = [];
  acceptedCounts = [];
  roomRows = [];
  roomAssignments = [];
  boardPins = [];
  calibrations = [];
  cableRuns = [];
  sheetRefsArr = [];
  entityLinksArr = [];
  takeoffsArr = [];
  takeoffLinesArr = [];
  blobPuts = [];
  auditEntries = [];
  detectionRaceWinner = null;

  requireFromHere.cache[vercelBlobPath] = {
    id: vercelBlobPath,
    filename: vercelBlobPath,
    loaded: true,
    exports: {
      put: async (path: string, buf: Buffer) => {
        blobPuts.push({ path, bytes: buf.length });
        return { url: `https://blob.test/${path}` };
      },
    },
  } as NodeJS.Module;
  aiCalls = [];
  aiNextText = JSON.stringify(GOOD_OUTPUT);
  aiFail = null;
  dbAvailable = true;
  insertRaceWinner = null;
  process.env.FLAG_AI_DRAWINGS = "1";
  delete process.env.AI_DRAWINGS_MODEL; // tests pin the default model id

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
      // ── #201 legend vocabulary (mirrors the real store's SQL semantics) ──
      LEGEND_CATEGORIES: ["Power", "Lighting", "Switch", "Data", "Comms", "Safety", "Mechanical", "EV", "Appliance", "Other"],
      LEGEND_TRANSITIONS: {
        suggested: ["accepted", "edited", "rejected"],
        accepted: ["rejected"],
        edited: ["rejected"],
        rejected: [],
        superseded: [],
      },
      normalizeLabel,
      listLegendEntries: async (_sql: unknown, _t: string, jobId: string) =>
        legendRows.filter((r) => r.job_id === jobId && r.status !== "superseded"),
      acceptedLegendEntries: async (_sql: unknown, _t: string, jobId: string) =>
        legendRows.filter(
          (r) => r.job_id === jobId && (r.status === "accepted" || r.status === "edited"),
        ),
      rejectedLegendLabels: async (_sql: unknown, _t: string, jobId: string) => [
        ...new Set(
          legendRows
            .filter((r) => r.job_id === jobId && r.status === "rejected")
            .map((r) => r.normalized_label),
        ),
      ],
      insertLegendSuggestions: async (_sql: unknown, _t: string, rows: Row[]) => {
        const inserted: Row[] = [];
        let duplicates = 0;
        for (const row of rows) {
          const norm = normalizeLabel(row.label as string);
          const live = legendRows.some(
            (r) =>
              r.job_id === row.jobId &&
              r.normalized_label === norm &&
              LIVE_LEGEND.has(r.status as string),
          );
          if (live) {
            duplicates += 1;
            continue;
          }
          const e: Row = {
            id: `le_${legendRows.length + 1}`,
            job_id: row.jobId,
            origin: "ai",
            status: "suggested",
            label: row.label,
            normalized_label: norm,
            description: row.description,
            category: row.category,
            symbol_text: row.symbolText,
            symbol_crop_url: null,
            crop_region: row.cropRegion,
            source_plan_id: row.sourcePlanId,
            source_page_index: row.sourcePageIndex,
            source_page_sha256: row.sourcePageSha256,
            extraction_id: row.extractionId,
            confidence: row.confidence,
            model: row.model,
            prompt_version: row.promptVersion,
            created_at: new Date().toISOString(),
            created_by_label: row.createdByLabel,
            reviewed_at: null,
            reviewed_by_label: null,
            review_note: null,
            human_label: null,
            superseded_by: null,
          };
          legendRows.push(e);
          inserted.push(e);
        }
        return { inserted, duplicates };
      },
      getLegendEntry: async (_sql: unknown, _t: string, jobId: string, entryId: string) =>
        legendRows.find((r) => r.job_id === jobId && r.id === entryId) ?? null,
      reviewLegendEntry: async (
        _sql: unknown,
        _t: string,
        jobId: string,
        entry: Row,
        next: Row,
      ) => {
        const i = legendRows.findIndex(
          (r) => r.job_id === jobId && r.id === entry.id && r.status === entry.status,
        );
        if (i < 0) return null;
        legendRows[i] = {
          ...legendRows[i],
          status: next.status,
          human_label:
            next.humanLabel === undefined ? legendRows[i]!.human_label : next.humanLabel,
          review_note: next.note === undefined ? legendRows[i]!.review_note : next.note,
          reviewed_at: new Date().toISOString(),
          reviewed_by_label: next.reviewedByLabel,
        };
        return legendRows[i];
      },
      addHumanLegendEntry: async (_sql: unknown, _t: string, row: Row) => {
        const norm = normalizeLabel(row.label as string);
        const live = legendRows.some(
          (r) =>
            r.job_id === row.jobId &&
            r.normalized_label === norm &&
            LIVE_LEGEND.has(r.status as string),
        );
        if (live) return null;
        const e: Row = {
          id: `le_${legendRows.length + 1}`,
          job_id: row.jobId,
          origin: "human",
          status: "accepted",
          label: row.label,
          normalized_label: norm,
          description: row.description,
          category: row.category,
          symbol_text: null,
          symbol_crop_url: null,
          crop_region: null,
          source_plan_id: null,
          source_page_index: null,
          source_page_sha256: null,
          extraction_id: null,
          confidence: null,
          model: null,
          prompt_version: null,
          created_at: new Date().toISOString(),
          created_by_label: row.createdByLabel,
          reviewed_at: new Date().toISOString(),
          reviewed_by_label: row.createdByLabel,
          review_note: null,
          human_label: null,
          superseded_by: null,
        };
        legendRows.push(e);
        return e;
      },
      setLegendCrop: async (
        _sql: unknown,
        _t: string,
        jobId: string,
        entryId: string,
        url: string,
      ) => {
        const i = legendRows.findIndex((r) => r.job_id === jobId && r.id === entryId);
        if (i < 0) return null;
        legendRows[i] = { ...legendRows[i], symbol_crop_url: url };
        return legendRows[i];
      },
      // ── #202/#207 schedule tables (mirrors the real store's SQL semantics) ──
      SCHEDULE_COLUMNS: {
        lighting: ["typeCode", "description", "manufacturer", "model", "lamp", "wattage", "qty"],
        switchboard: ["circuitRef", "description", "protection", "cableSize", "phase", "load"],
      },
      SCHEDULE_ROW_TRANSITIONS: {
        suggested: ["accepted", "edited", "rejected"],
        accepted: ["rejected", "edited"],
        edited: ["rejected", "edited"],
        rejected: [],
      },
      listScheduleTables: async (_sql: unknown, _t: string, jobId: string) =>
        scheduleTables.filter((t) => t.job_id === jobId && t.status === "live"),
      listScheduleRowsForTables: async (_sql: unknown, _t: string, ids: string[]) =>
        scheduleRowsArr.filter((r) => ids.includes(r.table_id as string)),
      liveTablesForExtraction: async (_sql: unknown, _t: string, extractionId: string) =>
        scheduleTables.filter((t) => t.extraction_id === extractionId && t.status === "live"),
      insertScheduleTables: async (_sql: unknown, _t: string, ctx: Row, tables: Row[]) => {
        const inserted: Row[] = [];
        for (const t of tables) {
          const rows = t.rows as Row[];
          const table: Row = {
            id: `st_${scheduleTables.length + 1}`,
            job_id: ctx.jobId,
            plan_id: ctx.planId,
            page_index: ctx.pageIndex,
            page_sha256: ctx.pageSha256,
            table_kind: ctx.tableKind,
            board_identifier: t.boardIdentifier,
            region: t.region,
            headers: t.headers,
            column_map: t.columnMap,
            extraction_id: ctx.extractionId,
            status: "live",
            superseded_by: null,
            row_count: rows.length,
            model: ctx.model,
            prompt_version: ctx.promptVersion,
            created_at: new Date().toISOString(),
            created_by_label: ctx.createdByLabel,
          };
          scheduleTables.push(table);
          rows.forEach((r, i) => {
            scheduleRowsArr.push({
              id: `sr_${scheduleRowsArr.length + 1}`,
              table_id: table.id,
              job_id: ctx.jobId,
              row_index: i,
              cells: r.cells,
              human_cells: null,
              row_region: r.rowRegion,
              status: "suggested",
              reviewed_at: null,
              reviewed_by_label: null,
              review_note: null,
              created_at: new Date().toISOString(),
            });
          });
          inserted.push(table);
        }
        const newIds = inserted.map((t) => t.id);
        for (const t of scheduleTables) {
          if (
            t.job_id === ctx.jobId &&
            t.plan_id === ctx.planId &&
            t.page_index === ctx.pageIndex &&
            t.table_kind === ctx.tableKind &&
            t.status === "live" &&
            !newIds.includes(t.id)
          ) {
            t.status = "superseded";
            t.superseded_by = newIds[0];
          }
        }
        return inserted;
      },
      getScheduleRow: async (_sql: unknown, _t: string, jobId: string, rowId: string) =>
        scheduleRowsArr.find((r) => r.job_id === jobId && r.id === rowId) ?? null,
      reviewScheduleRow: async (_sql: unknown, _t: string, jobId: string, row: Row, next: Row) => {
        const i = scheduleRowsArr.findIndex(
          (r) => r.job_id === jobId && r.id === row.id && r.status === row.status,
        );
        if (i < 0) return null;
        scheduleRowsArr[i] = {
          ...scheduleRowsArr[i],
          status: next.status,
          human_cells:
            next.humanCells === undefined ? scheduleRowsArr[i]!.human_cells : next.humanCells,
          review_note: next.note === undefined ? scheduleRowsArr[i]!.review_note : next.note,
          reviewed_at: new Date().toISOString(),
          reviewed_by_label: next.reviewedByLabel,
        };
        return scheduleRowsArr[i];
      },
      // ── #203 revision diffs (mirrors the real store's SQL semantics) ──
      DIFF_REGION_TRANSITIONS: {
        pending: ["reviewed", "dismissed"],
        reviewed: ["dismissed"],
        dismissed: ["reviewed"],
      },
      findLiveDiff: async (
        _sql: unknown,
        _t: string,
        jobId: string,
        baseSha: string,
        headSha: string,
        algo: string,
      ) =>
        pageDiffsArr.find(
          (d) =>
            d.job_id === jobId &&
            d.base_page_sha256 === baseSha &&
            d.head_page_sha256 === headSha &&
            d.algo_version === algo &&
            d.status === "live",
        ) ?? null,
      insertPageDiff: async (_sql: unknown, _t: string, d: Row, regions: Row[]) => {
        const diff: Row = {
          id: `pd_${pageDiffsArr.length + 1}`,
          job_id: d.jobId,
          base_plan_id: d.basePlanId,
          base_page_index: d.basePageIndex,
          base_page_sha256: d.basePageSha256,
          head_plan_id: d.headPlanId,
          head_page_index: d.headPageIndex,
          head_page_sha256: d.headPageSha256,
          algo_version: d.algoVersion,
          identical: d.identical,
          alignment: d.alignment,
          basis: d.basis,
          region_count: regions.length,
          status: "live",
          superseded_by: null,
          created_at: new Date().toISOString(),
          created_by_label: d.createdByLabel,
        };
        pageDiffsArr.push(diff);
        regions.forEach((r, i) => {
          diffRegionsArr.push({
            id: `dr_${diffRegionsArr.length + 1}`,
            diff_id: diff.id,
            job_id: d.jobId,
            region_index: i,
            bbox: r.bbox,
            area_cells: r.areaCells,
            status: "pending",
            reviewed_at: null,
            reviewed_by_label: null,
            review_note: null,
          });
        });
        for (const other of pageDiffsArr) {
          if (
            other.id !== diff.id &&
            other.job_id === d.jobId &&
            other.base_page_sha256 === d.basePageSha256 &&
            other.head_page_sha256 === d.headPageSha256 &&
            other.status === "live"
          ) {
            other.status = "superseded";
            other.superseded_by = diff.id;
          }
        }
        return diff;
      },
      listPageDiffs: async (_sql: unknown, _t: string, jobId: string) =>
        pageDiffsArr.filter((d) => d.job_id === jobId && d.status === "live"),
      listDiffRegionsForDiffs: async (_sql: unknown, _t: string, ids: string[]) =>
        diffRegionsArr.filter((r) => ids.includes(r.diff_id as string)),
      getDiffRegion: async (_sql: unknown, _t: string, jobId: string, regionId: string) =>
        diffRegionsArr.find((r) => r.job_id === jobId && r.id === regionId) ?? null,
      reviewDiffRegion: async (_sql: unknown, _t: string, jobId: string, region: Row, next: Row) => {
        const i = diffRegionsArr.findIndex(
          (r) => r.job_id === jobId && r.id === region.id && r.status === region.status,
        );
        if (i < 0) return null;
        diffRegionsArr[i] = {
          ...diffRegionsArr[i],
          status: next.status,
          review_note: next.note === undefined ? diffRegionsArr[i]!.review_note : next.note,
          reviewed_at: new Date().toISOString(),
          reviewed_by_label: next.reviewedByLabel,
        };
        return diffRegionsArr[i];
      },
      // ── #204 device detection (mirrors the real store's SQL semantics) ──
      boxIoU: fakeBoxIoU,
      tileKeyOf: (region: Box) =>
        `${region.x.toFixed(4)},${region.y.toFixed(4)},${region.w.toFixed(4)},${region.h.toFixed(4)}`,
      findCachedDetectionRun: async (_sql: unknown, _t: string, key: Row) =>
        detectionRuns.find(
          (r) =>
            r.job_id === key.jobId &&
            r.plan_id === key.planId &&
            r.page_index === key.pageIndex &&
            r.page_sha256 === key.pageSha256 &&
            r.tile_key === key.tileKey &&
            r.prompt_version === key.promptVersion &&
            r.model === key.model,
        ) ?? null,
      insertDetectionRun: async (_sql: unknown, _t: string, run: Row) => {
        if (detectionRaceWinner) {
          detectionRuns.push(detectionRaceWinner);
          detectionRaceWinner = null;
          const err = new Error(
            "duplicate key value violates unique constraint",
          ) as Error & { code: string };
          err.code = "23505";
          throw err;
        }
        const r: Row = {
          id: `run_${detectionRuns.length + 1}`,
          job_id: run.jobId,
          plan_id: run.planId,
          page_index: run.pageIndex,
          page_sha256: run.pageSha256,
          tile_key: run.tileKey,
          tile_region: run.tileRegion,
          prompt_version: run.promptVersion,
          model: run.model,
          raw: run.raw,
          input_tokens: run.inputTokens,
          output_tokens: run.outputTokens,
          created_by_label: run.createdByLabel,
        };
        detectionRuns.push(r);
        return r;
      },
      listDeviceDetectionsForPage: async (
        _sql: unknown,
        _t: string,
        jobId: string,
        planId: string,
        pageIndex: number,
        pageSha256: string,
      ) =>
        deviceDetections.filter(
          (d) =>
            d.job_id === jobId &&
            d.plan_id === planId &&
            d.page_index === pageIndex &&
            d.page_sha256 === pageSha256,
        ),
      listDeviceDetections: async (_sql: unknown, _t: string, jobId: string) =>
        deviceDetections.filter((d) => d.job_id === jobId),
      insertDeviceDetections: async (
        _sql: unknown,
        _t: string,
        ctx: Row,
        candidates: Row[],
        iouThreshold: number,
      ) => {
        const existing = deviceDetections.filter(
          (d) =>
            d.job_id === ctx.jobId &&
            d.plan_id === ctx.planId &&
            d.page_index === ctx.pageIndex &&
            d.page_sha256 === ctx.pageSha256,
        );
        const inserted: Row[] = [];
        let seamDuplicates = 0;
        const kept = existing.map((e) => ({
          bbox: e.bbox as Box,
          legendEntryId: e.legend_entry_id,
          kind: e.kind,
        }));
        for (const c of candidates) {
          const dup = kept.some(
            (k) =>
              k.kind === c.kind &&
              (c.kind !== "device" || k.legendEntryId === c.legendEntryId) &&
              fakeBoxIoU(k.bbox, c.bbox as Box) > iouThreshold,
          );
          if (dup) {
            seamDuplicates += 1;
            continue;
          }
          const row: Row = {
            id: `dd_${deviceDetections.length + 1}`,
            job_id: ctx.jobId,
            plan_id: ctx.planId,
            page_index: ctx.pageIndex,
            page_sha256: ctx.pageSha256,
            run_id: ctx.runId,
            kind: c.kind,
            legend_entry_id: c.legendEntryId,
            label: c.label,
            bbox: c.bbox,
            confidence: c.confidence,
            note: c.note,
            created_at: new Date().toISOString(),
          };
          deviceDetections.push(row);
          inserted.push(row);
          kept.push({ bbox: c.bbox as Box, legendEntryId: c.legendEntryId, kind: c.kind });
        }
        return { inserted, seamDuplicates };
      },
      // ── #205 count review (mirrors the real store's SQL semantics) ──
      REVIEW_ACTIONS: ["delete", "restore", "reclassify", "add"],
      listDetectionReviews: async (_sql: unknown, _t: string, jobId: string) =>
        detectionReviews
          .filter((r) => r.job_id === jobId)
          .sort((a, b) =>
            a.created_at === b.created_at
              ? String(a.id).localeCompare(String(b.id))
              : String(a.created_at) < String(b.created_at)
                ? -1
                : 1,
          ),
      getDetectionReview: async (_sql: unknown, _t: string, jobId: string, id: string) =>
        detectionReviews.find((r) => r.job_id === jobId && r.id === id) ?? null,
      getDeviceDetection: async (_sql: unknown, _t: string, jobId: string, id: string) =>
        deviceDetections.find((d) => d.job_id === jobId && d.id === id) ?? null,
      insertDetectionReview: async (_sql: unknown, _t: string, row: Row) => {
        const r: Row = {
          id: `rv_${detectionReviews.length + 1}`,
          job_id: row.jobId,
          plan_id: row.planId,
          page_index: row.pageIndex,
          page_sha256: row.pageSha256,
          action: row.action,
          target_detection_id: row.targetDetectionId,
          target_review_id: row.targetReviewId,
          legend_entry_id: row.legendEntryId,
          label: row.label,
          bbox: row.bbox,
          note: row.note,
          created_at: new Date(1750000000000 + detectionReviews.length * 1000).toISOString(),
          created_by_label: row.createdByLabel,
        };
        detectionReviews.push(r);
        return r;
      },
      listAcceptedCounts: async (_sql: unknown, _t: string, jobId: string) =>
        acceptedCounts.filter((a) => a.job_id === jobId),
      liveAcceptedCounts: async (_sql: unknown, _t: string, jobId: string) =>
        acceptedCounts.filter((a) => a.job_id === jobId && a.status === "live"),
      insertAcceptedCount: async (_sql: unknown, _t: string, row: Row) => {
        const prior = acceptedCounts.filter(
          (a) =>
            a.job_id === row.jobId &&
            a.plan_id === row.planId &&
            a.page_index === row.pageIndex &&
            a.page_sha256 === row.pageSha256 &&
            a.legend_entry_id === row.legendEntryId &&
            a.status === "live",
        );
        for (const p of prior) p.status = "superseded";
        const a: Row = {
          id: `ac_${acceptedCounts.length + 1}`,
          job_id: row.jobId,
          plan_id: row.planId,
          page_index: row.pageIndex,
          page_sha256: row.pageSha256,
          legend_entry_id: row.legendEntryId,
          label: row.label,
          count: row.count,
          basis: row.basis,
          status: "live",
          superseded_by: null,
          accepted_at: new Date(1750000000000 + acceptedCounts.length * 1000).toISOString(),
          accepted_by_label: row.acceptedByLabel,
        };
        acceptedCounts.push(a);
        for (const p of prior) p.superseded_by = a.id;
        return a;
      },
      // ── #206 rooms (mirrors the real store's SQL semantics) ──
      ROOM_TRANSITIONS: {
        suggested: ["accepted", "edited", "rejected"],
        accepted: ["edited", "rejected"],
        edited: ["edited", "rejected"],
        rejected: [],
        superseded: [],
      },
      listRooms: async (_sql: unknown, _t: string, jobId: string) =>
        roomRows.filter((r) => r.job_id === jobId && r.status !== "superseded"),
      getRoom: async (_sql: unknown, _t: string, jobId: string, id: string) =>
        roomRows.find((r) => r.job_id === jobId && r.id === id) ?? null,
      roomsForExtraction: async (_sql: unknown, _t: string, extractionId: string) =>
        roomRows.filter((r) => r.extraction_id === extractionId).slice(0, 1),
      insertRoomSuggestions: async (_sql: unknown, _t: string, ctx: Row, rooms: Row[]) => {
        const inserted: Row[] = [];
        for (const r of rooms) {
          const row: Row = {
            id: `rm_${roomRows.length + 1}`,
            job_id: ctx.jobId,
            plan_id: ctx.planId,
            page_index: ctx.pageIndex,
            page_sha256: ctx.pageSha256,
            origin: "ai",
            status: "suggested",
            name: r.name,
            human_name: null,
            bbox: r.bbox,
            human_bbox: null,
            confidence: r.confidence,
            extraction_id: ctx.extractionId,
            model: ctx.model,
            prompt_version: ctx.promptVersion,
            superseded_by: null,
            created_at: new Date(1750000000000 + roomRows.length * 1000).toISOString(),
            created_by_label: ctx.createdByLabel,
            reviewed_at: null,
            reviewed_by_label: null,
            review_note: null,
          };
          roomRows.push(row);
          inserted.push(row);
        }
        const newIds = new Set(inserted.map((r) => r.id));
        for (const r of roomRows) {
          if (
            r.job_id === ctx.jobId &&
            r.plan_id === ctx.planId &&
            r.page_index === ctx.pageIndex &&
            r.page_sha256 === ctx.pageSha256 &&
            r.origin === "ai" &&
            r.status === "suggested" &&
            !newIds.has(r.id)
          ) {
            r.status = "superseded";
            r.superseded_by = inserted[0]?.id ?? null;
          }
        }
        return inserted;
      },
      reviewRoom: async (_sql: unknown, _t: string, jobId: string, room: Row, next: Row) => {
        const i = roomRows.findIndex(
          (r) => r.job_id === jobId && r.id === room.id && r.status === room.status,
        );
        if (i < 0) return null;
        roomRows[i] = {
          ...roomRows[i],
          status: next.status,
          human_name: next.humanName === undefined ? roomRows[i]!.human_name : next.humanName,
          human_bbox: next.humanBbox === undefined ? roomRows[i]!.human_bbox : next.humanBbox,
          review_note: next.note === undefined ? roomRows[i]!.review_note : next.note,
          reviewed_at: new Date().toISOString(),
          reviewed_by_label: next.reviewedByLabel,
        };
        return roomRows[i];
      },
      addHumanRoom: async (_sql: unknown, _t: string, row: Row) => {
        const r: Row = {
          id: `rm_${roomRows.length + 1}`,
          job_id: row.jobId,
          plan_id: row.planId,
          page_index: row.pageIndex,
          page_sha256: row.pageSha256,
          origin: "human",
          status: "accepted",
          name: row.name,
          human_name: null,
          bbox: row.bbox,
          human_bbox: null,
          confidence: null,
          extraction_id: null,
          model: null,
          prompt_version: null,
          superseded_by: null,
          created_at: new Date(1750000000000 + roomRows.length * 1000).toISOString(),
          created_by_label: row.createdByLabel,
          reviewed_at: new Date().toISOString(),
          reviewed_by_label: row.createdByLabel,
          review_note: null,
        };
        roomRows.push(r);
        return r;
      },
      listRoomAssignments: async (_sql: unknown, _t: string, jobId: string) =>
        roomAssignments.filter((a) => a.job_id === jobId),
      upsertRoomAssignment: async (_sql: unknown, _t: string, o: Row) => {
        const i = roomAssignments.findIndex(
          (a) =>
            a.job_id === o.jobId &&
            a.plan_id === o.planId &&
            a.page_index === o.pageIndex &&
            a.page_sha256 === o.pageSha256 &&
            a.marker_key === o.markerKey,
        );
        const row: Row = {
          id: i >= 0 ? roomAssignments[i]!.id : `ra_${roomAssignments.length + 1}`,
          job_id: o.jobId,
          plan_id: o.planId,
          page_index: o.pageIndex,
          page_sha256: o.pageSha256,
          marker_key: o.markerKey,
          room_id: o.roomId,
          corrected_at: new Date().toISOString(),
          corrected_by_label: o.correctedByLabel,
        };
        if (i >= 0) roomAssignments[i] = row;
        else roomAssignments.push(row);
        return row;
      },
      deleteRoomAssignment: async (
        _sql: unknown,
        _t: string,
        jobId: string,
        planId: string,
        pageIndex: number,
        pageSha256: string,
        markerKey: string,
      ) => {
        const before = roomAssignments.length;
        roomAssignments = roomAssignments.filter(
          (a) =>
            !(
              a.job_id === jobId &&
              a.plan_id === planId &&
              a.page_index === pageIndex &&
              a.page_sha256 === pageSha256 &&
              a.marker_key === markerKey
            ),
        );
        return roomAssignments.length < before;
      },
      // ── #211 cable estimates (mirrors the real store's SQL semantics) ──
      listBoardPins: async (_sql: unknown, _t: string, jobId: string) =>
        boardPins.filter((p) => p.job_id === jobId),
      upsertBoardPin: async (_sql: unknown, _t: string, o: Row) => {
        const i = boardPins.findIndex(
          (p) =>
            p.job_id === o.jobId &&
            p.plan_id === o.planId &&
            p.page_index === o.pageIndex &&
            p.page_sha256 === o.pageSha256 &&
            p.board_identifier === o.boardIdentifier,
        );
        const row: Row = {
          id: i >= 0 ? boardPins[i]!.id : `bp_${boardPins.length + 1}`,
          job_id: o.jobId,
          plan_id: o.planId,
          page_index: o.pageIndex,
          page_sha256: o.pageSha256,
          board_identifier: o.boardIdentifier,
          point: o.point,
          created_at: new Date().toISOString(),
          created_by_label: o.createdByLabel,
        };
        if (i >= 0) boardPins[i] = row;
        else boardPins.push(row);
        return row;
      },
      deleteBoardPin: async (
        _sql: unknown,
        _t: string,
        jobId: string,
        planId: string,
        pageIndex: number,
        pageSha256: string,
        boardIdentifier: string,
      ) => {
        const before = boardPins.length;
        boardPins = boardPins.filter(
          (p) =>
            !(
              p.job_id === jobId &&
              p.plan_id === planId &&
              p.page_index === pageIndex &&
              p.page_sha256 === pageSha256 &&
              p.board_identifier === boardIdentifier
            ),
        );
        return boardPins.length < before;
      },
      listCalibrations: async (_sql: unknown, _t: string, jobId: string) =>
        calibrations.filter((c) => c.job_id === jobId),
      upsertCalibration: async (_sql: unknown, _t: string, o: Row) => {
        const i = calibrations.findIndex(
          (c) =>
            c.job_id === o.jobId &&
            c.plan_id === o.planId &&
            c.page_index === o.pageIndex &&
            c.page_sha256 === o.pageSha256,
        );
        const row: Row = {
          id: i >= 0 ? calibrations[i]!.id : `cal_${calibrations.length + 1}`,
          job_id: o.jobId,
          plan_id: o.planId,
          page_index: o.pageIndex,
          page_sha256: o.pageSha256,
          point_a: o.pointA,
          point_b: o.pointB,
          real_mm: o.realMm,
          raster_aspect: o.rasterAspect,
          mm_per_norm_x: o.mmPerNormX,
          mm_per_norm_y: o.mmPerNormY,
          title_scale_text: o.titleScaleText,
          created_at: new Date().toISOString(),
          created_by_label: o.createdByLabel,
        };
        if (i >= 0) calibrations[i] = row;
        else calibrations.push(row);
        return row;
      },
      listCableRuns: async (_sql: unknown, _t: string, jobId: string) =>
        cableRuns.filter((r) => r.job_id === jobId && r.status !== "superseded"),
      getCableRun: async (_sql: unknown, _t: string, jobId: string, id: string) =>
        cableRuns.find((r) => r.job_id === jobId && r.id === id) ?? null,
      insertCableRun: async (_sql: unknown, _t: string, row: Row) => {
        const prior = cableRuns.filter(
          (r) =>
            r.job_id === row.jobId &&
            r.plan_id === row.planId &&
            r.page_index === row.pageIndex &&
            r.page_sha256 === row.pageSha256 &&
            r.status !== "superseded",
        );
        for (const p of prior) p.status = "superseded";
        const run: Row = {
          id: `cr_${cableRuns.length + 1}`,
          job_id: row.jobId,
          plan_id: row.planId,
          page_index: row.pageIndex,
          page_sha256: row.pageSha256,
          status: "draft",
          factors: row.factors,
          inputs: row.inputs,
          results: row.results,
          superseded_by: null,
          created_at: new Date().toISOString(),
          created_by_label: row.createdByLabel,
          accepted_at: null,
          accepted_by_label: null,
        };
        cableRuns.push(run);
        for (const p of prior) p.superseded_by = run.id;
        return run;
      },
      acceptCableRun: async (
        _sql: unknown,
        _t: string,
        jobId: string,
        runId: string,
        acceptedByLabel: string,
      ) => {
        const i = cableRuns.findIndex(
          (r) => r.job_id === jobId && r.id === runId && r.status === "draft",
        );
        if (i < 0) return null;
        cableRuns[i] = {
          ...cableRuns[i],
          status: "accepted",
          accepted_at: new Date().toISOString(),
          accepted_by_label: acceptedByLabel,
        };
        return cableRuns[i];
      },
      acceptedCableRuns: async (_sql: unknown, _t: string, jobId: string) =>
        cableRuns.filter((r) => r.job_id === jobId && r.status === "accepted"),
      // ── #212 cross-sheet links (mirrors the real store's SQL semantics) ──
      listSheetRefs: async (_sql: unknown, _t: string, jobId: string) =>
        sheetRefsArr.filter((r) => r.job_id === jobId && r.status === "live"),
      refsForExtraction: async (_sql: unknown, _t: string, extractionId: string) =>
        sheetRefsArr.filter((r) => r.extraction_id === extractionId).slice(0, 1),
      insertSheetRefs: async (_sql: unknown, _t: string, ctx: Row, refs: Row[]) => {
        const inserted: Row[] = [];
        for (const r of refs) {
          const row: Row = {
            id: `ref_${sheetRefsArr.length + 1}`,
            job_id: ctx.jobId,
            plan_id: ctx.planId,
            page_index: ctx.pageIndex,
            page_sha256: ctx.pageSha256,
            text: r.text,
            target_sheet_number: r.targetSheetNumber,
            bbox: r.bbox,
            confidence: r.confidence,
            extraction_id: ctx.extractionId,
            status: "live",
            superseded_by: null,
            created_at: new Date(1750000000000 + sheetRefsArr.length * 1000).toISOString(),
            created_by_label: ctx.createdByLabel,
          };
          sheetRefsArr.push(row);
          inserted.push(row);
        }
        const newIds = new Set(inserted.map((r) => r.id));
        for (const r of sheetRefsArr) {
          if (
            r.job_id === ctx.jobId &&
            r.plan_id === ctx.planId &&
            r.page_index === ctx.pageIndex &&
            r.page_sha256 === ctx.pageSha256 &&
            r.status === "live" &&
            !newIds.has(r.id)
          ) {
            r.status = "superseded";
            r.superseded_by = inserted[0]?.id ?? null;
          }
        }
        return inserted;
      },
      listEntityLinks: async (_sql: unknown, _t: string, jobId: string) =>
        entityLinksArr.filter((l) => l.job_id === jobId),
      getEntityLink: async (_sql: unknown, _t: string, jobId: string, id: string) =>
        entityLinksArr.find((l) => l.job_id === jobId && l.id === id) ?? null,
      insertEntityLinks: async (
        _sql: unknown,
        _t: string,
        jobId: string,
        proposals: Row[],
        origin: string,
        createdByLabel: string | null,
      ) => {
        const inserted: Row[] = [];
        let skipped = 0;
        for (const p of proposals) {
          const dup = entityLinksArr.some(
            (l) =>
              l.job_id === jobId &&
              l.kind === p.kind &&
              l.identifier === p.identifier &&
              l.a_plan_id === p.aPlanId &&
              l.a_page_index === p.aPageIndex &&
              l.b_plan_id === p.bPlanId &&
              l.b_page_index === p.bPageIndex,
          );
          if (dup) {
            skipped += 1;
            continue;
          }
          const row: Row = {
            id: `el_${entityLinksArr.length + 1}`,
            job_id: jobId,
            kind: p.kind,
            identifier: p.identifier,
            a_plan_id: p.aPlanId,
            a_page_index: p.aPageIndex,
            b_plan_id: p.bPlanId,
            b_page_index: p.bPageIndex,
            confidence: p.confidence,
            evidence: p.evidence,
            origin,
            status: origin === "human" ? "confirmed" : "proposed",
            created_at: new Date(1750000000000 + entityLinksArr.length * 1000).toISOString(),
            created_by_label: createdByLabel,
            reviewed_at: null,
            reviewed_by_label: null,
          };
          entityLinksArr.push(row);
          inserted.push(row);
        }
        return { inserted, skipped };
      },
      reviewEntityLink: async (_sql: unknown, _t: string, jobId: string, link: Row, next: Row) => {
        const i = entityLinksArr.findIndex(
          (l) => l.job_id === jobId && l.id === link.id && l.status === link.status,
        );
        if (i < 0) return null;
        entityLinksArr[i] = {
          ...entityLinksArr[i],
          status: next.status,
          reviewed_at: new Date().toISOString(),
          reviewed_by_label: next.reviewedByLabel,
        };
        return entityLinksArr[i];
      },
      // ── #213 takeoffs (mirrors the real store's SQL semantics) ──
      listTakeoffs: async (_sql: unknown, _t: string, jobId: string) =>
        takeoffsArr.filter((t) => t.job_id === jobId && t.status !== "superseded"),
      getTakeoff: async (_sql: unknown, _t: string, jobId: string, id: string) =>
        takeoffsArr.find((t) => t.job_id === jobId && t.id === id) ?? null,
      takeoffLinesFor: async (_sql: unknown, _t: string, ids: string[]) =>
        takeoffLinesArr
          .filter((l) => ids.includes(l.takeoff_id as string))
          .sort((a, b) => (a.line_index as number) - (b.line_index as number)),
      getTakeoffLine: async (_sql: unknown, _t: string, id: string) =>
        takeoffLinesArr.find((l) => l.id === id) ?? null,
      insertTakeoff: async (
        _sql: unknown,
        _t: string,
        jobId: string,
        header: Row,
        lines: Row[],
      ) => {
        const prior = takeoffsArr.filter((t) => t.job_id === jobId && t.status === "draft");
        for (const p of prior) p.status = "superseded";
        const version =
          Math.max(0, ...takeoffsArr.filter((t) => t.job_id === jobId).map((t) => t.version as number)) + 1;
        const takeoff: Row = {
          id: `to_${takeoffsArr.length + 1}`,
          job_id: jobId,
          version,
          status: "draft",
          warnings: header.warnings,
          sources: header.sources,
          superseded_by: null,
          created_at: new Date().toISOString(),
          created_by_label: header.createdByLabel,
          signed_off_at: null,
          signed_off_by_label: null,
        };
        takeoffsArr.push(takeoff);
        for (const p of prior) p.superseded_by = takeoff.id;
        const inserted: Row[] = [];
        lines.forEach((l, i) => {
          const row: Row = {
            id: `tl_${takeoffLinesArr.length + 1}`,
            takeoff_id: takeoff.id,
            line_index: i,
            source_type: l.sourceType,
            description: l.description,
            qty: l.qty,
            human_qty: null,
            unit: l.unit,
            estimate: l.estimate,
            flagged: l.flagged,
            flag_reason: l.flagReason,
            note: null,
            adjusted_at: null,
            adjusted_by_label: null,
            provenance: l.provenance,
          };
          takeoffLinesArr.push(row);
          inserted.push(row);
        });
        return { takeoff, lines: inserted };
      },
      adjustTakeoffLine: async (_sql: unknown, _t: string, lineId: string, next: Row) => {
        const i = takeoffLinesArr.findIndex((l) => l.id === lineId);
        if (i < 0) return null;
        takeoffLinesArr[i] = {
          ...takeoffLinesArr[i],
          human_qty: next.humanQty,
          note: next.note,
          adjusted_at: new Date().toISOString(),
          adjusted_by_label: next.adjustedByLabel,
        };
        return takeoffLinesArr[i];
      },
      addManualTakeoffLine: async (_sql: unknown, _t: string, takeoffId: string, line: Row) => {
        const maxIndex = Math.max(
          -1,
          ...takeoffLinesArr
            .filter((l) => l.takeoff_id === takeoffId)
            .map((l) => l.line_index as number),
        );
        const row: Row = {
          id: `tl_${takeoffLinesArr.length + 1}`,
          takeoff_id: takeoffId,
          line_index: maxIndex + 1,
          source_type: "manual",
          description: line.description,
          qty: line.qty,
          human_qty: null,
          unit: line.unit,
          estimate: false,
          flagged: false,
          flag_reason: null,
          note: null,
          adjusted_at: new Date().toISOString(),
          adjusted_by_label: line.addedByLabel,
          provenance: { addedBy: line.addedByLabel },
        };
        takeoffLinesArr.push(row);
        return row;
      },
      signOffTakeoff: async (
        _sql: unknown,
        _t: string,
        jobId: string,
        takeoffId: string,
        signedOffByLabel: string,
      ) => {
        const prior = takeoffsArr.filter(
          (t) => t.job_id === jobId && t.status === "signed_off",
        );
        const i = takeoffsArr.findIndex(
          (t) => t.job_id === jobId && t.id === takeoffId && t.status === "draft",
        );
        if (i < 0) return null;
        for (const p of prior) {
          p.status = "superseded";
          p.superseded_by = takeoffId;
        }
        takeoffsArr[i] = {
          ...takeoffsArr[i],
          status: "signed_off",
          signed_off_at: new Date().toISOString(),
          signed_off_by_label: signedOffByLabel,
        };
        return takeoffsArr[i];
      },
      signedOffTakeoff: async (_sql: unknown, _t: string, jobId: string) => {
        const t = takeoffsArr.find(
          (x) => x.job_id === jobId && x.status === "signed_off",
        );
        if (!t) return null;
        return {
          takeoff: t,
          lines: takeoffLinesArr.filter((l) => l.takeoff_id === t.id),
        };
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

  // registered plan pages on job j1 (page 1 exists for multi-sheet merges;
  // pl2 page 0 shares pl1 page 0's sha for the byte-identical diff case)
  blob.set("jobs/j1/plans-index.json", {
    plans: [
      {
        id: "pl1",
        jobId: "j1",
        fileName: "set.pdf",
        status: "current",
        pages: [
          { pageIndex: 0, pngUrl: "https://blob.test/pl1-0.png", sha256: "sha0" },
          { pageIndex: 1, pngUrl: "https://blob.test/pl1-1.png", sha256: "sha1" },
        ],
      },
      {
        id: "pl2",
        jobId: "j1",
        fileName: "set-revB.pdf",
        status: "superseded",
        pages: [{ pageIndex: 0, pngUrl: "https://blob.test/pl2-0.png", sha256: "sha0" }],
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

// #206 rooms→areas accept bridge — reviewed rooms become real job areas.
type TestArea = { id?: string; name: string; aiSourceId?: string; provenance?: { rev?: string } };
type TestGroup = { name: string; areas: TestArea[] };
type TestJob = { id: string; name: string; areaGroups: TestGroup[] };
describe("accept-rooms → job areas", () => {
  function seedRoom(over: Record<string, unknown> = {}) {
    const row = {
      id: `rm_${roomRows.length + 1}`,
      job_id: "j1",
      plan_id: "pl1",
      page_index: 0,
      page_sha256: "sha0",
      origin: "ai",
      status: "accepted",
      name: "KITCHEN",
      human_name: null,
      bbox: { x: 0.3, y: 0.4, w: 0.2, h: 0.15 },
      human_bbox: null,
      confidence: 0.9,
      created_at: "2026-07-03T00:00:00.000Z",
      reviewed_at: "2026-07-03T00:00:00.000Z",
      reviewed_by_label: "boss",
      review_note: null,
      ...over,
    };
    roomRows.push(row);
    return row;
  }

  it("creates areas from reviewed rooms, grouped by plan level, and writes jobs.json", async () => {
    blob.set("jobs.json", { jobs: [{ id: "j1", name: "Test job", areaGroups: [] }] });
    blob.set("jobs/j1/plans-index.json", {
      plans: [{ id: "pl1", jobId: "j1", fileName: "set.pdf", drawingNumber: "E-101", level: "Level 1", revision: "B", status: "current", pages: [] }],
    });
    seedRoom({ id: "rm_1", name: "KITCHEN", status: "accepted" });
    seedRoom({ id: "rm_2", name: "BED 2", status: "edited", human_name: "BED 2" });

    const res = await call("POST", { jobId: "j1", action: "accept-rooms" }, {});
    expect(res.statusCode).toBe(200);
    expect(res.body.created).toBe(2);

    const job = (blob.get("jobs.json") as { jobs: TestJob[] }).jobs[0]!;
    expect(job.areaGroups).toHaveLength(1);
    expect(job.areaGroups[0]!.name).toBe("Level 1");
    expect(job.areaGroups[0]!.areas.map((a) => a.name)).toEqual(["KITCHEN", "BED 2"]);
    // provenance persisted + real ar_ ids minted by validateAreaGroups
    expect(job.areaGroups[0]!.areas[0]!.aiSourceId).toBe("aidr:room:rm_1");
    expect(String(job.areaGroups[0]!.areas[0]!.id)).toMatch(/^ar_/);
    expect(job.areaGroups[0]!.areas[0]!.provenance!.rev).toBe("B");
  });

  it("is idempotent — a second accept creates nothing and doesn't grow the areas", async () => {
    blob.set("jobs.json", { jobs: [{ id: "j1", name: "Test job", areaGroups: [] }] });
    seedRoom({ id: "rm_1", name: "KITCHEN", status: "accepted" });

    const first = await call("POST", { jobId: "j1", action: "accept-rooms" }, {});
    expect(first.body.created).toBe(1);
    const second = await call("POST", { jobId: "j1", action: "accept-rooms" }, {});
    expect(second.statusCode).toBe(200);
    expect(second.body.created).toBe(0);
    expect(second.body.skipped[0].reason).toBe("already-created");

    const job = (blob.get("jobs.json") as { jobs: TestJob[] }).jobs[0]!;
    const areaCount = job.areaGroups.reduce((n, g) => n + g.areas.length, 0);
    expect(areaCount).toBe(1);
  });

  it("reports a selected but still-suggested room as skipped 'not-reviewed' (gate holds)", async () => {
    blob.set("jobs.json", { jobs: [{ id: "j1", name: "Test job", areaGroups: [] }] });
    seedRoom({ id: "rm_1", name: "KITCHEN", status: "suggested" });

    // Selection mode: the admin explicitly picked a room that isn't reviewed.
    const res = await call("POST", { jobId: "j1", action: "accept-rooms" }, { roomIds: ["rm_1"] });
    expect(res.statusCode).toBe(200);
    expect(res.body.created).toBe(0);
    expect(res.body.skipped[0].reason).toBe("not-reviewed");
  });

  it("accept-all mode ignores still-suggested rooms without spamming skipped", async () => {
    blob.set("jobs.json", { jobs: [{ id: "j1", name: "Test job", areaGroups: [] }] });
    seedRoom({ id: "rm_1", name: "KITCHEN", status: "suggested" });

    const res = await call("POST", { jobId: "j1", action: "accept-rooms" }, {});
    expect(res.statusCode).toBe(200);
    expect(res.body.created).toBe(0);
    expect(res.body.skipped).toHaveLength(0);
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
    expect(s.fields.scale?.effective).toBe("1:50");
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

// ─── #201 legend vocabulary ─────────────────────────────────────────────────

const GOOD_LEGEND = {
  isLegendPresent: true,
  entries: [
    {
      label: "DOUBLE GPO",
      description: "10A twin outlet",
      category: "Power",
      symbol: "circle with two lines",
      confidence: 0.92,
      bbox: { x: 0.1, y: 0.1, w: 0.05, h: 0.03 },
    },
    { label: "DOWNLIGHT", category: "Lighting", confidence: 0.9, bbox: null },
  ],
  notes: null,
};

async function extractLegendOn(pageIndex: number): Promise<Res> {
  return call("POST", { jobId: "j1", action: "extract-legend" }, { planId: "pl1", pageIndex });
}

describe("legend vocabulary (#201)", () => {
  beforeEach(() => {
    aiNextText = JSON.stringify(GOOD_LEGEND);
  });

  it("extracts entries as suggestions, records spend + audit, lists them", async () => {
    const res = await extractLegendOn(0);
    expect(res.statusCode).toBe(200);
    expect(res.body.isLegendPresent).toBe(true);
    expect(res.body.inserted).toBe(2);
    expect(res.body.duplicates).toBe(0);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries[0].status).toBe("suggested");
    expect(legendRows).toHaveLength(2);
    expect(spendLedger().calls[0]?.kind).toBe("extract-legend");
    const audit = auditEntries.find((a) => a.action === "document.ai_extracted");
    expect((audit?.metadata as Row)?.kind).toBe("legend-entries");

    const list = await call("GET", { jobId: "j1", action: "legend" });
    expect(list.statusCode).toBe(200);
    expect(list.body.entries).toHaveLength(2);
  });

  it("merges multiple legend blocks into ONE vocabulary — duplicates are no-ops", async () => {
    await extractLegendOn(0);
    const res = await extractLegendOn(1); // second sheet, same labels
    expect(res.statusCode).toBe(200);
    expect(res.body.inserted).toBe(0);
    expect(res.body.duplicates).toBe(2);
    expect(legendRows).toHaveLength(2); // still one vocabulary
    expect(aiCalls).toHaveLength(2); // different page → real run
  });

  it("serves an unchanged page from cache and stays idempotent", async () => {
    await extractLegendOn(0);
    const res = await extractLegendOn(0);
    expect(res.statusCode).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(res.body.duplicates).toBe(2); // merge re-ran, changed nothing
    expect(aiCalls).toHaveLength(1);
    expect(spendLedger().calls).toHaveLength(1); // never bills twice
  });

  it("a rejected label never resurrects on re-extraction", async () => {
    await extractLegendOn(0);
    const entry = legendRows.find((r) => r.label === "DOUBLE GPO");
    const rej = await call("POST", { jobId: "j1", action: "review-legend-entry" }, {
      entryId: entry?.id,
      status: "rejected",
      note: "not on this job",
    });
    expect(rej.statusCode).toBe(200);
    const res = await extractLegendOn(1);
    expect(res.statusCode).toBe(200);
    expect(res.body.rejectedSkipped).toBe(1);
    expect(
      legendRows.filter((r) => r.label === "DOUBLE GPO" && r.status !== "rejected"),
    ).toHaveLength(0);
  });

  it("review machine: accept works; edited requires humanLabel; terminal re-review 409s; live entries can still be rejected", async () => {
    await extractLegendOn(0);
    const [a, b] = legendRows;

    const accepted = await call("POST", { jobId: "j1", action: "review-legend-entry" }, {
      entryId: a?.id,
      status: "accepted",
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.body.entry.status).toBe("accepted");

    const editNoLabel = await call("POST", { jobId: "j1", action: "review-legend-entry" }, {
      entryId: b?.id,
      status: "edited",
    });
    expect(editNoLabel.statusCode).toBe(400);

    const edited = await call("POST", { jobId: "j1", action: "review-legend-entry" }, {
      entryId: b?.id,
      status: "edited",
      humanLabel: "LED DOWNLIGHT 90mm",
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.body.entry.effectiveLabel).toBe("LED DOWNLIGHT 90mm");
    expect(edited.body.entry.label).toBe("DOWNLIGHT"); // AI original preserved

    const reAccept = await call("POST", { jobId: "j1", action: "review-legend-entry" }, {
      entryId: a?.id,
      status: "accepted",
    });
    expect(reAccept.statusCode).toBe(409);

    // the documented vocabulary extension: bogus entries removable post-accept
    const lateReject = await call("POST", { jobId: "j1", action: "review-legend-entry" }, {
      entryId: a?.id,
      status: "rejected",
    });
    expect(lateReject.statusCode).toBe(200);

    const missing = await call("POST", { jobId: "j1", action: "review-legend-entry" }, {
      entryId: "nope",
      status: "accepted",
    });
    expect(missing.statusCode).toBe(404);
  });

  it("a human can add a missed entry (pre-accepted); a live duplicate 409s", async () => {
    const added = await call("POST", { jobId: "j1", action: "add-legend-entry" }, {
      label: "EXHAUST FAN",
      category: "Mechanical",
    });
    expect(added.statusCode).toBe(201);
    expect(added.body.entry.origin).toBe("human");
    expect(added.body.entry.status).toBe("accepted");

    const dup = await call("POST", { jobId: "j1", action: "add-legend-entry" }, {
      label: "  exhaust   FAN ", // normalises to the same label
    });
    expect(dup.statusCode).toBe(409);
  });

  it("attaches a browser-cropped symbol image via Blob; unknown entry 404s", async () => {
    await extractLegendOn(0);
    const entry = legendRows[0];
    const res = await call("POST", { jobId: "j1", action: "attach-legend-crop" }, {
      entryId: entry?.id,
      dataUrl: "data:image/png;base64,aGVsbG8=",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.entry.symbolCropUrl).toContain("legend-crops");
    expect(blobPuts[0]?.path).toBe(`jobs/j1/legend-crops/${entry?.id}.png`);

    const missing = await call("POST", { jobId: "j1", action: "attach-legend-crop" }, {
      entryId: "nope",
      dataUrl: "data:image/png;base64,aGVsbG8=",
    });
    expect(missing.statusCode).toBe(404);
  });

  it("a page with no legend stores the run but inserts nothing", async () => {
    aiNextText = JSON.stringify({ isLegendPresent: false, entries: [], notes: "floor plan page" });
    const res = await extractLegendOn(0);
    expect(res.statusCode).toBe(200);
    expect(res.body.isLegendPresent).toBe(false);
    expect(res.body.inserted).toBe(0);
    expect(legendRows).toHaveLength(0);
    expect(extractions).toHaveLength(1); // cached so a re-click never bills
  });

  it("unusable legend output → 502, spend recorded, nothing stored (P7)", async () => {
    aiNextText = "not json";
    const res = await extractLegendOn(0);
    expect(res.statusCode).toBe(502);
    expect(legendRows).toHaveLength(0);
    expect(extractions).toHaveLength(0);
    expect(spendLedger().calls).toHaveLength(1);
  });
});

// ─── #202 schedule tables ───────────────────────────────────────────────────

const GOOD_SCHEDULE = {
  isSchedulePresent: true,
  tables: [
    {
      boardIdentifier: null,
      region: { x: 0.1, y: 0.1, w: 0.6, h: 0.5 },
      headers: ["TYPE", "DESCRIPTION", "QTY", "IP RATING"],
      columnMap: { TYPE: "typeCode", DESCRIPTION: "description", QTY: "qty" },
      rows: [
        {
          rowRegion: { x: 0.1, y: 0.2, w: 0.6, h: 0.03 },
          cells: {
            typeCode: { value: "L1", confidence: 0.95 },
            description: { value: "LED PANEL 600x600", confidence: 0.9 },
            qty: { value: "24", confidence: 0.92 },
            "IP RATING": { value: "IP44", confidence: 0.85 },
          },
        },
        {
          rowRegion: null,
          cells: {
            typeCode: { value: "L2", confidence: 0.9 },
            description: { value: null, confidence: 0.3 }, // unreadable — flagged, not invented
            qty: { value: "6", confidence: 0.88 },
          },
        },
      ],
    },
  ],
  notes: null,
};

async function extractScheduleOn(pageIndex: number): Promise<Res> {
  return call("POST", { jobId: "j1", action: "extract-schedule" }, {
    planId: "pl1",
    pageIndex,
    tableKind: "lighting",
  });
}

describe("schedule tables (#202)", () => {
  beforeEach(() => {
    aiNextText = JSON.stringify(GOOD_SCHEDULE);
  });

  it("extracts a table into rows with verbatim cells + effective merge, spend + audit", async () => {
    const res = await extractScheduleOn(0);
    expect(res.statusCode).toBe(200);
    expect(res.body.isSchedulePresent).toBe(true);
    expect(res.body.tables).toHaveLength(1);
    expect(res.body.rows).toHaveLength(2);
    const row1 = res.body.rows[0];
    expect(row1.effective.typeCode.value).toBe("L1");
    expect(row1.effective["IP RATING"].value).toBe("IP44"); // unmapped column preserved
    const row2 = res.body.rows[1];
    expect(row2.effective.description.value).toBe(null); // null flagged, never invented
    expect(row2.effective.description.confidence).toBe(0.3);
    expect(spendLedger().calls[0]?.kind).toBe("extract-schedule");
    const audit = auditEntries.find((a) => a.action === "document.ai_extracted");
    expect((audit?.metadata as Row)?.kind).toBe("schedule-lighting");

    const list = await call("GET", { jobId: "j1", action: "schedules" });
    expect(list.statusCode).toBe(200);
    expect(list.body.tables).toHaveLength(1);
    expect(list.body.columns.lighting).toContain("typeCode");
  });

  it("a cached re-click is idempotent — no second bill, no duplicate tables", async () => {
    await extractScheduleOn(0);
    const res = await extractScheduleOn(0);
    expect(res.statusCode).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(res.body.tables).toHaveLength(1);
    expect(aiCalls).toHaveLength(1);
    expect(spendLedger().calls).toHaveLength(1);
  });

  it("re-extracting a re-rendered page supersedes the old table — reviewed history kept", async () => {
    await extractScheduleOn(0);
    blob.set("jobs/j1/plans-index.json", {
      plans: [
        {
          id: "pl1",
          jobId: "j1",
          fileName: "set.pdf",
          status: "current",
          pages: [{ pageIndex: 0, pngUrl: "https://blob.test/pl1-0.png", sha256: "sha0b" }],
        },
      ],
      __rev: 2,
    });
    const res = await extractScheduleOn(0);
    expect(res.statusCode).toBe(200);
    expect(res.body.cached).toBe(false);
    expect(res.body.tables).toHaveLength(1); // one LIVE table
    expect(scheduleTables).toHaveLength(2); // the superseded one remains for the trail
    expect(scheduleTables.filter((t) => t.status === "superseded")).toHaveLength(1);
  });

  it("row review: accept, edited requires cells, corrections win, accepted rows still fixable, rejected is terminal", async () => {
    await extractScheduleOn(0);
    const [r1, r2] = scheduleRowsArr;

    const accepted = await call("POST", { jobId: "j1", action: "review-schedule-row" }, {
      rowId: r1?.id,
      status: "accepted",
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.body.row.status).toBe("accepted");

    const editNoCells = await call("POST", { jobId: "j1", action: "review-schedule-row" }, {
      rowId: r2?.id,
      status: "edited",
    });
    expect(editNoCells.statusCode).toBe(400);

    const edited = await call("POST", { jobId: "j1", action: "review-schedule-row" }, {
      rowId: r2?.id,
      status: "edited",
      cells: { description: "EXIT LIGHT LED", qty: null },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.body.row.effective.description).toEqual({
      value: "EXIT LIGHT LED",
      confidence: 0.3,
      corrected: true,
    });
    expect(edited.body.row.effective.qty.value).toBe(null); // human says the cell is empty
    expect(edited.body.row.cells.description.value).toBe(null); // AI read preserved

    // accepted rows remain fixable (a later-spotted error must be correctable)
    const fixAccepted = await call("POST", { jobId: "j1", action: "review-schedule-row" }, {
      rowId: r1?.id,
      status: "edited",
      cells: { qty: "25" },
    });
    expect(fixAccepted.statusCode).toBe(200);

    const rejected = await call("POST", { jobId: "j1", action: "review-schedule-row" }, {
      rowId: r2?.id,
      status: "rejected",
    });
    expect(rejected.statusCode).toBe(200);
    const afterTerminal = await call("POST", { jobId: "j1", action: "review-schedule-row" }, {
      rowId: r2?.id,
      status: "accepted",
    });
    expect(afterTerminal.statusCode).toBe(409);

    const missing = await call("POST", { jobId: "j1", action: "review-schedule-row" }, {
      rowId: "nope",
      status: "accepted",
    });
    expect(missing.statusCode).toBe(404);
  });

  it("a page with no schedule stores the cached run and inserts nothing", async () => {
    aiNextText = JSON.stringify({ isSchedulePresent: false, tables: [], notes: "floor plan" });
    const res = await extractScheduleOn(0);
    expect(res.statusCode).toBe(200);
    expect(res.body.isSchedulePresent).toBe(false);
    expect(res.body.tables).toHaveLength(0);
    expect(scheduleTables).toHaveLength(0);
    expect(extractions).toHaveLength(1);
  });

  it("unusable schedule output → 502, spend recorded, nothing stored (P7)", async () => {
    aiNextText = "no table here";
    const res = await extractScheduleOn(0);
    expect(res.statusCode).toBe(502);
    expect(scheduleTables).toHaveLength(0);
    expect(extractions).toHaveLength(0);
    expect(spendLedger().calls).toHaveLength(1);
  });

  // ── #207 switchboard schedules on the same machinery ──
  it("extracts a board schedule keyed by board, verbatim abbreviations intact (#207)", async () => {
    aiNextText = JSON.stringify({
      isSchedulePresent: true,
      tables: [
        {
          boardIdentifier: "DB-1",
          region: { x: 0.05, y: 0.1, w: 0.45, h: 0.7 },
          headers: ["CCT", "DESCRIPTION", "CB", "CABLE", "PH"],
          columnMap: {
            CCT: "circuitRef",
            DESCRIPTION: "description",
            CB: "protection",
            CABLE: "cableSize",
            PH: "phase",
          },
          rows: [
            {
              rowRegion: { x: 0.05, y: 0.2, w: 0.45, h: 0.02 },
              cells: {
                circuitRef: { value: "L1", confidence: 0.95 },
                description: { value: "LTS GF EAST", confidence: 0.9 }, // abbreviation VERBATIM
                protection: { value: "10A MCB C", confidence: 0.9 },
                cableSize: { value: "2.5mm²", confidence: 0.88 },
                phase: { value: "R", confidence: 0.9 },
              },
            },
          ],
        },
      ],
      notes: null,
    });
    const res = await call("POST", { jobId: "j1", action: "extract-schedule" }, {
      planId: "pl1",
      pageIndex: 0,
      tableKind: "switchboard",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.tables).toHaveLength(1);
    expect(res.body.tables[0].tableKind).toBe("switchboard");
    expect(res.body.tables[0].boardIdentifier).toBe("DB-1"); // stored keyed by board
    expect(res.body.rows[0].effective.description.value).toBe("LTS GF EAST"); // never expanded
    expect(res.body.rows[0].effective.cableSize.value).toBe("2.5mm²");
    const audit = auditEntries.find((a) => a.action === "document.ai_extracted");
    expect((audit?.metadata as Row)?.kind).toBe("schedule-switchboard");
  });

  it("lighting and switchboard runs on the same page cache independently (#207)", async () => {
    await extractScheduleOn(0); // lighting
    aiNextText = JSON.stringify({
      isSchedulePresent: true,
      tables: [
        {
          boardIdentifier: "MSB",
          region: null,
          headers: ["CCT"],
          columnMap: { CCT: "circuitRef" },
          rows: [{ rowRegion: null, cells: { circuitRef: { value: "P1", confidence: 0.9 } } }],
        },
      ],
      notes: null,
    });
    const res = await call("POST", { jobId: "j1", action: "extract-schedule" }, {
      planId: "pl1",
      pageIndex: 0,
      tableKind: "switchboard",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.cached).toBe(false); // separate run-log kind → separate cache
    expect(aiCalls).toHaveLength(2);
    // both kinds live side by side — a board run never supersedes lighting tables
    expect(scheduleTables.filter((t) => t.status === "live")).toHaveLength(2);
  });
});

// ─── #203 revision diffs ────────────────────────────────────────────────────

// Real PNG fixtures — the actual engine runs (no diff mocking).
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CJS PNG codec, used structurally
const { PNG: TestPNG } = requireFromHere("pngjs") as any;

function makeTestPng(draw?: (set: (x: number, y: number) => void) => void): Buffer {
  const w = 640;
  const h = 480;
  const png = new TestPNG({ width: w, height: h });
  for (let i = 0; i < w * h; i += 1) {
    png.data[i * 4] = 255;
    png.data[i * 4 + 1] = 255;
    png.data[i * 4 + 2] = 255;
    png.data[i * 4 + 3] = 255;
  }
  const set = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    png.data[i] = 0;
    png.data[i + 1] = 0;
    png.data[i + 2] = 0;
  };
  draw?.(set);
  return TestPNG.sync.write(png);
}

function testRect(set: (x: number, y: number) => void, x0: number, y0: number, x1: number, y1: number) {
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) set(x, y);
}

function baseSheet(set: (x: number, y: number) => void) {
  testRect(set, 40, 40, 600, 44);
  testRect(set, 40, 436, 600, 440);
  testRect(set, 40, 40, 44, 440);
  testRect(set, 80, 120, 400, 124);
}

let fetchUrls: string[] = [];

function stubDiffFetch(map: Record<string, Buffer>) {
  fetchUrls = [];
  vi.stubGlobal("fetch", async (url: string) => {
    fetchUrls.push(String(url));
    const key = Object.keys(map).find((k) => String(url).includes(k));
    if (!key) throw new Error("unexpected fetch " + url);
    const buf = map[key]!;
    return {
      ok: true,
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  });
}

async function runDiff(base: { planId: string; pageIndex: number }, head: { planId: string; pageIndex: number }): Promise<Res> {
  return call("POST", { jobId: "j1", action: "diff-pages" }, { base, head });
}

describe("revision diffs (#203)", () => {
  it("byte-identical rasters short-circuit — no image fetch, honest basis", async () => {
    const res = await runDiff({ planId: "pl2", pageIndex: 0 }, { planId: "pl1", pageIndex: 0 });
    expect(res.statusCode).toBe(200);
    expect(res.body.diff.identical).toBe(true);
    expect(res.body.diff.regionCount).toBe(0);
    expect(res.body.diff.basis.byteIdentical).toBe(true); // "no changes" carries its basis
    expect(auditEntries.map((a) => a.action)).toContain("document.revision_diffed");
  });

  it("a changed page yields walkable regions with the diff basis; reruns hit the cache", async () => {
    stubDiffFetch({
      "pl1-0.png": makeTestPng((s) => baseSheet(s)),
      "pl1-1.png": makeTestPng((s) => {
        baseSheet(s);
        testRect(s, 200, 200, 280, 280); // the revision's change
      }),
    });
    const res = await runDiff({ planId: "pl1", pageIndex: 0 }, { planId: "pl1", pageIndex: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.body.diff.identical).toBe(false);
    expect(res.body.diff.regionCount).toBeGreaterThanOrEqual(1);
    expect(res.body.diff.basis.threshold).toBeGreaterThan(0);
    expect(res.body.diff.alignment.quality).toBeGreaterThan(0.9);
    expect(res.body.regions[0].status).toBe("pending");
    const fetchesAfterFirst = fetchUrls.length;
    expect(fetchesAfterFirst).toBe(2);

    const again = await runDiff({ planId: "pl1", pageIndex: 0 }, { planId: "pl1", pageIndex: 1 });
    expect(again.statusCode).toBe(200);
    expect(again.body.cached).toBe(true);
    expect(fetchUrls.length).toBe(fetchesAfterFirst); // cache — no refetch
  });

  it("an un-alignable pair is refused honestly and NOTHING is stored", async () => {
    let seed = 0x9e3779b9;
    stubDiffFetch({
      "pl1-0.png": makeTestPng((s) => baseSheet(s)),
      "pl1-1.png": makeTestPng((s) => {
        for (let y = 0; y < 480; y += 2) {
          for (let x = 0; x < 640; x += 2) {
            seed ^= seed << 13;
            seed ^= seed >>> 17;
            seed ^= seed << 5;
            if ((seed & 3) === 0) testRect(s, x, y, x + 2, y + 2);
          }
        }
      }),
    });
    const res = await runDiff({ planId: "pl1", pageIndex: 0 }, { planId: "pl1", pageIndex: 1 });
    expect(res.statusCode).toBe(422);
    expect(String(res.body.error)).toMatch(/could not compare/);
    expect(pageDiffsArr).toHaveLength(0);
  });

  it("region walk-through: reviewed/dismissed flip, double-mark 409s, unknown 404s; same page 400s", async () => {
    stubDiffFetch({
      "pl1-0.png": makeTestPng((s) => baseSheet(s)),
      "pl1-1.png": makeTestPng((s) => {
        baseSheet(s);
        testRect(s, 200, 200, 280, 280);
      }),
    });
    await runDiff({ planId: "pl1", pageIndex: 0 }, { planId: "pl1", pageIndex: 1 });
    const region = diffRegionsArr[0];

    const reviewed = await call("POST", { jobId: "j1", action: "review-diff-region" }, {
      regionId: region?.id,
      status: "reviewed",
    });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.body.region.status).toBe("reviewed");
    expect(auditEntries.map((a) => a.action)).toContain("document.diff_region_reviewed");

    const doubled = await call("POST", { jobId: "j1", action: "review-diff-region" }, {
      regionId: region?.id,
      status: "reviewed",
    });
    expect(doubled.statusCode).toBe(409);

    const dismissed = await call("POST", { jobId: "j1", action: "review-diff-region" }, {
      regionId: region?.id,
      status: "dismissed",
    });
    expect(dismissed.statusCode).toBe(200); // flip allowed — reviewer bookkeeping

    const missing = await call("POST", { jobId: "j1", action: "review-diff-region" }, {
      regionId: "nope",
      status: "reviewed",
    });
    expect(missing.statusCode).toBe(404);

    const samePage = await runDiff({ planId: "pl1", pageIndex: 0 }, { planId: "pl1", pageIndex: 0 });
    expect(samePage.statusCode).toBe(400);

    const list = await call("GET", { jobId: "j1", action: "diffs" });
    expect(list.statusCode).toBe(200);
    expect(list.body.diffs).toHaveLength(1);
    expect(list.body.regions.length).toBeGreaterThanOrEqual(1);
  });
});

describe("device detection (#204)", () => {
  const TILE = {
    region: { x: 0, y: 0, w: 0.5, h: 0.5 },
    dataUrl: "data:image/png;base64,dGlsZQ==",
  };

  // Two reviewed vocabulary entries: one with a symbol crop (few-shot ref
  // image), one edited whose human label must win over the AI label.
  function seedVocabulary() {
    legendRows.push(
      {
        id: "le_gpo",
        job_id: "j1",
        origin: "ai",
        status: "accepted",
        label: "Double GPO",
        normalized_label: "double gpo",
        human_label: null,
        symbol_text: "=GPO=",
        symbol_crop_url: "https://blob.test/crops/gpo.png",
      },
      {
        id: "le_dl",
        job_id: "j1",
        origin: "ai",
        status: "edited",
        label: "Downlight",
        normalized_label: "downlight",
        human_label: "LED downlight",
        symbol_text: null,
        symbol_crop_url: null,
      },
    );
  }

  const MODEL_OUTPUT = {
    detections: [
      { entryIndex: 0, bbox: { x: 0.8, y: 0.8, w: 0.08, h: 0.08 }, confidence: 0.9 },
      { entryIndex: 1, bbox: { x: 0.2, y: 0.2, w: 0.06, h: 0.06 }, confidence: 0.75 },
      { entryIndex: 7, bbox: { x: 0.1, y: 0.6, w: 0.05, h: 0.05 }, confidence: 0.7 },
    ],
    uncertainRegions: [
      { bbox: { x: 0.5, y: 0.1, w: 0.3, h: 0.2 }, note: "dense ceiling grid" },
    ],
    notes: null,
  };

  const detect = (tile: typeof TILE = TILE) =>
    call("POST", { jobId: "j1", action: "detect-devices" }, {
      planId: "pl1",
      pageIndex: 0,
      tile,
    });

  it("409s without a reviewed legend vocabulary — nothing honest to match against", async () => {
    const res = await detect();
    expect(res.statusCode).toBe(409);
    expect(String(res.body.error)).toContain("legend");
    expect(aiCalls).toHaveLength(0);
    expect(spendLedger()).toBeUndefined();
  });

  it("suggested-only entries do NOT count as vocabulary", async () => {
    legendRows.push({
      id: "le_sugg",
      job_id: "j1",
      origin: "ai",
      status: "suggested",
      label: "GPO",
      normalized_label: "gpo",
      human_label: null,
      symbol_text: null,
      symbol_crop_url: null,
    });
    const res = await detect();
    expect(res.statusCode).toBe(409);
  });

  it("locates vocabulary symbols: few-shot crops ride along, tile boxes map to page coords, vocab frozen, spend + audit recorded", async () => {
    seedVocabulary();
    aiNextText = JSON.stringify(MODEL_OUTPUT);
    const res = await detect();
    expect(res.statusCode).toBe(200);
    expect(res.body.cached).toBe(false);
    expect(res.body.inserted).toBe(3); // 2 devices + 1 uncertain region
    expect(res.body.offVocabulary).toBe(1); // entryIndex 7 points outside the list — dropped, counted
    expect(res.body.seamDuplicates).toBe(0);

    // one vision call: tile image first, then ONE reference crop (only
    // le_gpo has one), then the vocabulary prompt with human labels
    expect(aiCalls).toHaveLength(1);
    const msg = (
      aiCalls[0] as { messages: Array<{ content: Array<Record<string, unknown>> }> }
    ).messages[0]!;
    expect(msg.content[0]?.type).toBe("image");
    expect(msg.content.filter((c) => c.type === "image")).toHaveLength(2);
    const prompt = String(msg.content.find((c) => c.type === "text")?.text);
    expect(prompt).toContain("0: Double GPO");
    expect(prompt).toContain("(drawn as: =GPO=)");
    expect(prompt).toContain("reference image #1");
    expect(prompt).toContain("1: LED downlight"); // human label wins

    // tile-normalised boxes land in page coordinates (tile is the top-left half-page)
    const gpo = (res.body.detections as Row[]).find((d) => d.label === "Double GPO")!;
    expect(gpo.kind).toBe("device");
    expect(gpo.legendEntryId).toBe("le_gpo");
    expect(gpo.bbox).toEqual({ x: 0.4, y: 0.4, w: 0.04, h: 0.04 });
    const unc = (res.body.detections as Row[]).find((d) => d.kind === "uncertain-region")!;
    expect(unc.note).toBe("dense ceiling grid");
    expect(unc.bbox).toEqual({ x: 0.25, y: 0.05, w: 0.15, h: 0.1 });

    // the vocabulary mapping is frozen inside the run — later legend
    // changes can never re-label detection history
    expect(detectionRuns).toHaveLength(1);
    expect((detectionRuns[0]?.raw as Row).vocab).toEqual([
      { entryId: "le_gpo", label: "Double GPO" },
      { entryId: "le_dl", label: "LED downlight" },
    ]);

    expect(spendLedger().calls).toHaveLength(1);
    expect(spendLedger().calls[0]?.kind).toBe("detect-devices");
    const audit = auditEntries.find(
      (a) =>
        a.action === "document.ai_extracted" &&
        (a.metadata as Row)?.kind === "device-detections",
    );
    expect(audit).toBeTruthy();
    expect(String(audit?.summary)).toContain("2 devices");
    expect(String(audit?.summary)).toContain("unverified");
  });

  it("re-clicking the same tile serves the cached run — no second bill, no duplicate rows", async () => {
    seedVocabulary();
    aiNextText = JSON.stringify(MODEL_OUTPUT);
    await detect();
    const res = await detect();
    expect(res.statusCode).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(aiCalls).toHaveLength(1);
    expect(spendLedger().calls).toHaveLength(1);
    // IoU dedupe absorbs the re-materialise — devices AND the uncertain region
    expect(res.body.inserted).toBe(0);
    expect(res.body.seamDuplicates).toBe(3);
    expect(deviceDetections).toHaveLength(3);
  });

  it("dedupes the same physical device seen from two overlapping tiles (seam)", async () => {
    seedVocabulary();
    // tile 1 (top-left): device lands at page {0.4, 0.4}
    aiNextText = JSON.stringify({
      detections: [{ entryIndex: 0, bbox: { x: 0.8, y: 0.8, w: 0.08, h: 0.08 }, confidence: 0.9 }],
      uncertainRegions: [],
      notes: null,
    });
    await detect();
    // tile 2 overlaps tile 1: the SAME device maps to the same page box,
    // plus one genuinely new device further along
    aiNextText = JSON.stringify({
      detections: [
        { entryIndex: 0, bbox: { x: 0.3, y: 0.3, w: 0.08, h: 0.08 }, confidence: 0.85 },
        { entryIndex: 0, bbox: { x: 0.6, y: 0.6, w: 0.08, h: 0.08 }, confidence: 0.8 },
      ],
      uncertainRegions: [],
      notes: null,
    });
    const res = await detect({
      region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
      dataUrl: TILE.dataUrl,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.cached).toBe(false);
    expect(res.body.seamDuplicates).toBe(1);
    expect(res.body.inserted).toBe(1);
    expect(deviceDetections.filter((d) => d.kind === "device")).toHaveLength(2);
    expect(aiCalls).toHaveLength(2); // different tile → different cache key → billed
    expect(spendLedger().calls).toHaveLength(2);
  });

  it("402s before spending once the per-job cap is reached", async () => {
    seedVocabulary();
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
    const res = await detect();
    expect(res.statusCode).toBe(402);
    expect(aiCalls).toHaveLength(0);
    expect(detectionRuns).toHaveLength(0);
  });

  it("502s on unusable model output — spend recorded, NOTHING stored (P7)", async () => {
    seedVocabulary();
    aiNextText = "I think I can see some GPOs all over the place";
    const res = await detect();
    expect(res.statusCode).toBe(502);
    expect(spendLedger().calls).toHaveLength(1); // the money is honestly gone
    expect(detectionRuns).toHaveLength(0);
    expect(deviceDetections).toHaveLength(0);
  });

  it("loses the run-insert race gracefully — serves the winner, single bill from this request", async () => {
    seedVocabulary();
    aiNextText = JSON.stringify(MODEL_OUTPUT);
    detectionRaceWinner = {
      id: "run_won",
      job_id: "j1",
      plan_id: "pl1",
      page_index: 0,
      page_sha256: "sha0",
      tile_key: "0.0000,0.0000,0.5000,0.5000",
      tile_region: TILE.region,
      prompt_version: "dd-v1",
      model: "claude-opus-4-8",
      raw: {
        ...MODEL_OUTPUT,
        vocab: [
          { entryId: "le_gpo", label: "Double GPO" },
          { entryId: "le_dl", label: "LED downlight" },
        ],
      },
      input_tokens: 1,
      output_tokens: 1,
      created_by_label: "other-session",
    };
    const res = await detect();
    expect(res.statusCode).toBe(200);
    expect(res.body.inserted).toBe(3); // materialised from the winner's raw
    expect(detectionRuns).toHaveLength(1); // only the winner's row exists
    expect(spendLedger().calls).toHaveLength(1);
  });

  it("400s a tile payload that is not an image data URL", async () => {
    seedVocabulary();
    const res = await detect({ region: TILE.region, dataUrl: "data:text/html;base64,x" });
    expect(res.statusCode).toBe(400);
    expect(aiCalls).toHaveLength(0);
  });

  it("GET detections lists every stored detection for the job", async () => {
    seedVocabulary();
    aiNextText = JSON.stringify(MODEL_OUTPUT);
    await detect();
    const res = await call("GET", { jobId: "j1", action: "detections" });
    expect(res.statusCode).toBe(200);
    expect(res.body.detections).toHaveLength(3);
    expect(res.body.promptVersion).toBe("dd-v1");
  });
});

describe("count review (#205)", () => {
  // Reviewed vocabulary + raw detections on pl1 p0 (current raster sha0):
  // two GPOs and one downlight from the AI, plus one uncertain region.
  function seedReviewScene() {
    legendRows.push(
      {
        id: "le_gpo",
        job_id: "j1",
        origin: "ai",
        status: "accepted",
        label: "Double GPO",
        normalized_label: "double gpo",
        human_label: null,
        symbol_text: null,
        symbol_crop_url: null,
      },
      {
        id: "le_dl",
        job_id: "j1",
        origin: "ai",
        status: "edited",
        label: "Downlight",
        normalized_label: "downlight",
        human_label: "LED downlight",
        symbol_text: null,
        symbol_crop_url: null,
      },
    );
    deviceDetections.push(
      {
        id: "d1",
        job_id: "j1",
        plan_id: "pl1",
        page_index: 0,
        page_sha256: "sha0",
        run_id: "run_x",
        kind: "device",
        legend_entry_id: "le_gpo",
        label: "Double GPO",
        bbox: { x: 0.4, y: 0.4, w: 0.04, h: 0.04 },
        confidence: 0.9,
        note: null,
        created_at: "2026-07-03T00:00:00.000Z",
      },
      {
        id: "d2",
        job_id: "j1",
        plan_id: "pl1",
        page_index: 0,
        page_sha256: "sha0",
        run_id: "run_x",
        kind: "device",
        legend_entry_id: "le_gpo",
        label: "Double GPO",
        bbox: { x: 0.6, y: 0.6, w: 0.04, h: 0.04 },
        confidence: 0.8,
        note: null,
        created_at: "2026-07-03T00:00:01.000Z",
      },
      {
        id: "d3",
        job_id: "j1",
        plan_id: "pl1",
        page_index: 0,
        page_sha256: "sha0",
        run_id: "run_x",
        kind: "device",
        legend_entry_id: "le_dl",
        label: "LED downlight",
        bbox: { x: 0.2, y: 0.2, w: 0.03, h: 0.03 },
        confidence: 0.7,
        note: null,
        created_at: "2026-07-03T00:00:02.000Z",
      },
      {
        id: "u1",
        job_id: "j1",
        plan_id: "pl1",
        page_index: 0,
        page_sha256: "sha0",
        run_id: "run_x",
        kind: "uncertain-region",
        legend_entry_id: null,
        label: null,
        bbox: { x: 0.8, y: 0.1, w: 0.15, h: 0.15 },
        confidence: null,
        note: "dense grid",
        created_at: "2026-07-03T00:00:03.000Z",
      },
    );
  }

  const gpoRow = (page: { counts: Row[] }) =>
    page.counts.find((c) => c.legendEntryId === "le_gpo") as Row;

  it("GET count-review assembles pages: markers, counts, uncertain regions", async () => {
    seedReviewScene();
    const res = await call("GET", { jobId: "j1", action: "count-review" });
    expect(res.statusCode).toBe(200);
    expect(res.body.pages).toHaveLength(1);
    const page = res.body.pages[0];
    expect(page.planId).toBe("pl1");
    expect(page.pageSha256).toBe("sha0");
    expect(page.markers).toHaveLength(3);
    expect(page.uncertain).toHaveLength(1);
    expect(gpoRow(page)).toMatchObject({ liveCount: 2, removedCount: 0, addedCount: 0 });
    expect(gpoRow(page).accepted).toBeNull(); // nothing verified yet
  });

  it("delete a false positive: count drops live, the action is recorded, audit lands", async () => {
    seedReviewScene();
    const res = await call("POST", { jobId: "j1", action: "review-marker" }, {
      action: "delete",
      detectionId: "d2",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.review.action).toBe("delete");
    expect(gpoRow(res.body.page)).toMatchObject({ liveCount: 1, removedCount: 1 });
    // detections stayed immutable — the correction is a layered action
    expect(deviceDetections).toHaveLength(4);
    expect(detectionReviews).toHaveLength(1);
    const audit = auditEntries.find(
      (a) =>
        a.action === "document.ai_corrected" && (a.metadata as Row)?.kind === "device-marker",
    );
    expect(audit).toBeTruthy();
  });

  it("restore brings a deleted marker back", async () => {
    seedReviewScene();
    await call("POST", { jobId: "j1", action: "review-marker" }, {
      action: "delete",
      detectionId: "d2",
    });
    const res = await call("POST", { jobId: "j1", action: "review-marker" }, {
      action: "restore",
      detectionId: "d2",
    });
    expect(res.statusCode).toBe(200);
    expect(gpoRow(res.body.page)).toMatchObject({ liveCount: 2, removedCount: 0 });
  });

  it("reclassify moves a marker between entries — reviewed vocabulary only", async () => {
    seedReviewScene();
    const bad = await call("POST", { jobId: "j1", action: "review-marker" }, {
      action: "reclassify",
      detectionId: "d2",
      toLegendEntryId: "le_nope",
    });
    expect(bad.statusCode).toBe(404);

    legendRows.push({
      id: "le_sugg",
      job_id: "j1",
      origin: "ai",
      status: "suggested",
      label: "Switch",
      normalized_label: "switch",
      human_label: null,
      symbol_text: null,
      symbol_crop_url: null,
    });
    const unreviewed = await call("POST", { jobId: "j1", action: "review-marker" }, {
      action: "reclassify",
      detectionId: "d2",
      toLegendEntryId: "le_sugg",
    });
    expect(unreviewed.statusCode).toBe(409);

    const res = await call("POST", { jobId: "j1", action: "review-marker" }, {
      action: "reclassify",
      detectionId: "d2",
      toLegendEntryId: "le_dl",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.review.label).toBe("LED downlight"); // human label wins
    expect(gpoRow(res.body.page)).toMatchObject({ liveCount: 1 });
    const dl = res.body.page.counts.find((c: Row) => c.legendEntryId === "le_dl");
    expect(dl).toMatchObject({ liveCount: 2 });
  });

  it("add a missed device: human marker joins the count; vocabulary is enforced", async () => {
    seedReviewScene();
    const unreviewedEntry = await call("POST", { jobId: "j1", action: "add-marker" }, {
      planId: "pl1",
      pageIndex: 0,
      bbox: { x: 0.5, y: 0.5, w: 0.016, h: 0.016 },
      legendEntryId: "le_missing",
    });
    expect(unreviewedEntry.statusCode).toBe(404);

    const res = await call("POST", { jobId: "j1", action: "add-marker" }, {
      planId: "pl1",
      pageIndex: 0,
      bbox: { x: 0.5, y: 0.5, w: 0.016, h: 0.016 },
      legendEntryId: "le_gpo",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.review.action).toBe("add");
    expect(gpoRow(res.body.page)).toMatchObject({ liveCount: 3, addedCount: 1 });
    const human = (res.body.page.markers as Row[]).find((m) => m.source === "human");
    expect(human).toMatchObject({ status: "live", label: "Double GPO" });
  });

  it("exactly one target: body naming both detectionId and reviewId is rejected", async () => {
    seedReviewScene();
    const res = await call("POST", { jobId: "j1", action: "review-marker" }, {
      action: "delete",
      detectionId: "d1",
      reviewId: "rv_1",
    });
    expect(res.statusCode).toBe(400);
  });

  it("uncertain regions are not deletable markers", async () => {
    seedReviewScene();
    const res = await call("POST", { jobId: "j1", action: "review-marker" }, {
      action: "delete",
      detectionId: "u1",
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.body.error)).toContain("uncertain");
  });

  it("409s actions on markers from a superseded raster", async () => {
    seedReviewScene();
    deviceDetections.push({
      id: "d_old",
      job_id: "j1",
      plan_id: "pl1",
      page_index: 0,
      page_sha256: "sha-OLD",
      run_id: "run_y",
      kind: "device",
      legend_entry_id: "le_gpo",
      label: "Double GPO",
      bbox: { x: 0.3, y: 0.3, w: 0.04, h: 0.04 },
      confidence: 0.9,
      note: null,
      created_at: "2026-07-02T00:00:00.000Z",
    });
    const res = await call("POST", { jobId: "j1", action: "review-marker" }, {
      action: "delete",
      detectionId: "d_old",
    });
    expect(res.statusCode).toBe(409);
    expect(String(res.body.error)).toContain("raster changed");
  });

  it("accept snapshots the count with basis + acceptor; corrections after make it stale; re-accept clears", async () => {
    seedReviewScene();
    // correct first: delete d2, then accept GPO = 1
    await call("POST", { jobId: "j1", action: "review-marker" }, {
      action: "delete",
      detectionId: "d2",
    });
    const res = await call("POST", { jobId: "j1", action: "accept-count" }, {
      planId: "pl1",
      pageIndex: 0,
      legendEntryId: "le_gpo",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.accepted).toMatchObject({
      count: 1,
      label: "Double GPO",
      acceptedBy: "boss",
      stale: false,
    });
    expect(res.body.accepted.basis.markerKeys).toEqual(["d:d1"]);
    expect(res.body.accepted.basis.reviewIds).toContain("rv_1"); // the delete shaped this count
    expect(gpoRow(res.body.page).accepted).toMatchObject({ count: 1, stale: false });
    const audit = auditEntries.find((a) => a.action === "document.count_accepted");
    expect(audit).toBeTruthy();
    expect(String(audit?.summary)).toContain("human-verified");

    // a correction AFTER the sign-off makes it visibly stale
    const afterAdd = await call("POST", { jobId: "j1", action: "add-marker" }, {
      planId: "pl1",
      pageIndex: 0,
      bbox: { x: 0.7, y: 0.7, w: 0.016, h: 0.016 },
      legendEntryId: "le_gpo",
    });
    expect(gpoRow(afterAdd.body.page).accepted).toMatchObject({ count: 1, stale: true });

    // re-accept supersedes, keeps history, clears staleness
    const again = await call("POST", { jobId: "j1", action: "accept-count" }, {
      planId: "pl1",
      pageIndex: 0,
      legendEntryId: "le_gpo",
    });
    expect(again.statusCode).toBe(200);
    expect(again.body.accepted).toMatchObject({ count: 2, stale: false });
    expect(acceptedCounts).toHaveLength(2);
    expect(acceptedCounts[0]).toMatchObject({ status: "superseded", superseded_by: "ac_2" });
    expect(acceptedCounts[1]).toMatchObject({ status: "live" });
  });

  it("cannot accept an entry with no markers on the sheet", async () => {
    seedReviewScene();
    legendRows.push({
      id: "le_empty",
      job_id: "j1",
      origin: "human",
      status: "accepted",
      label: "EV charger",
      normalized_label: "ev charger",
      human_label: null,
      symbol_text: null,
      symbol_crop_url: null,
    });
    const res = await call("POST", { jobId: "j1", action: "accept-count" }, {
      planId: "pl1",
      pageIndex: 0,
      legendEntryId: "le_empty",
    });
    expect(res.statusCode).toBe(409);
    expect(String(res.body.error)).toContain("nothing to accept");
  });

  it("accepting zero after removing every marker of a type IS a valid sign-off", async () => {
    seedReviewScene();
    await call("POST", { jobId: "j1", action: "review-marker" }, {
      action: "delete",
      detectionId: "d3",
    });
    const res = await call("POST", { jobId: "j1", action: "accept-count" }, {
      planId: "pl1",
      pageIndex: 0,
      legendEntryId: "le_dl",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.accepted).toMatchObject({ count: 0, stale: false });
    expect(res.body.accepted.basis.markerKeys).toEqual([]);
  });
});

describe("rooms and zones (#206)", () => {
  // Same detection scene as #205: d1 (0.42,0.42), d2 (0.62,0.62),
  // d3 downlight (0.215,0.215) — the room boxes below catch d1 and d2,
  // d3 stays unzoned.
  function seedRoomsScene() {
    legendRows.push(
      {
        id: "le_gpo",
        job_id: "j1",
        origin: "ai",
        status: "accepted",
        label: "Double GPO",
        normalized_label: "double gpo",
        human_label: null,
        symbol_text: null,
        symbol_crop_url: null,
      },
      {
        id: "le_dl",
        job_id: "j1",
        origin: "ai",
        status: "edited",
        label: "Downlight",
        normalized_label: "downlight",
        human_label: "LED downlight",
        symbol_text: null,
        symbol_crop_url: null,
      },
    );
    deviceDetections.push(
      {
        id: "d1",
        job_id: "j1",
        plan_id: "pl1",
        page_index: 0,
        page_sha256: "sha0",
        run_id: "run_x",
        kind: "device",
        legend_entry_id: "le_gpo",
        label: "Double GPO",
        bbox: { x: 0.4, y: 0.4, w: 0.04, h: 0.04 },
        confidence: 0.9,
        note: null,
        created_at: "2026-07-03T00:00:00.000Z",
      },
      {
        id: "d2",
        job_id: "j1",
        plan_id: "pl1",
        page_index: 0,
        page_sha256: "sha0",
        run_id: "run_x",
        kind: "device",
        legend_entry_id: "le_gpo",
        label: "Double GPO",
        bbox: { x: 0.6, y: 0.6, w: 0.04, h: 0.04 },
        confidence: 0.8,
        note: null,
        created_at: "2026-07-03T00:00:01.000Z",
      },
      {
        id: "d3",
        job_id: "j1",
        plan_id: "pl1",
        page_index: 0,
        page_sha256: "sha0",
        run_id: "run_x",
        kind: "device",
        legend_entry_id: "le_dl",
        label: "LED downlight",
        bbox: { x: 0.2, y: 0.2, w: 0.03, h: 0.03 },
        confidence: 0.7,
        note: null,
        created_at: "2026-07-03T00:00:02.000Z",
      },
    );
  }

  const ROOMS_OUTPUT = {
    rooms: [
      { name: "KITCHEN", bbox: { x: 0.35, y: 0.35, w: 0.2, h: 0.2 }, confidence: 0.85 },
      { name: "BED 2", bbox: { x: 0.55, y: 0.55, w: 0.2, h: 0.2 }, confidence: 0.6 },
    ],
    notes: null,
  };

  const extract = () =>
    call("POST", { jobId: "j1", action: "extract-rooms" }, { planId: "pl1", pageIndex: 0 });

  it("maps labelled rooms with approximate extents: cache row, spend, audit, grouping", async () => {
    seedRoomsScene();
    aiNextText = JSON.stringify(ROOMS_OUTPUT);
    const res = await extract();
    expect(res.statusCode).toBe(200);
    expect(res.body.cached).toBe(false);
    expect(res.body.inserted).toBe(2);
    expect(res.body.page.rooms).toHaveLength(2);
    expect(res.body.page.rooms[0]).toMatchObject({
      name: "KITCHEN",
      effectiveName: "KITCHEN",
      status: "suggested",
      origin: "ai",
    });
    // grouping: KITCHEN holds d1, BED 2 holds d2, d3 lands UNZONED (last)
    const byRoom = res.body.page.byRoom as Row[];
    expect(byRoom.map((r) => r.roomName)).toEqual(["BED 2", "KITCHEN", null]);
    expect(byRoom[2]).toMatchObject({ roomId: null, total: 1 });
    // markers carry their derived room
    const d3 = (res.body.page.markers as Row[]).find((m) => m.key === "d:d3");
    expect(d3).toMatchObject({ roomId: null, roomPinned: false });

    expect(extractions).toHaveLength(1);
    expect(extractions[0]?.kind).toBe("rooms");
    expect(spendLedger().calls[0]?.kind).toBe("extract-rooms");
    const audit = auditEntries.find(
      (a) => a.action === "document.ai_extracted" && (a.metadata as Row)?.kind === "rooms",
    );
    expect(audit).toBeTruthy();
    expect(String(audit?.summary)).toContain("unverified");
  });

  it("cached re-click: no second bill, no duplicate room rows", async () => {
    seedRoomsScene();
    aiNextText = JSON.stringify(ROOMS_OUTPUT);
    await extract();
    const res = await extract();
    expect(res.statusCode).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(res.body.inserted).toBe(0); // roomsForExtraction guard
    expect(aiCalls).toHaveLength(1);
    expect(spendLedger().calls).toHaveLength(1);
    expect(roomRows.filter((r) => r.status === "suggested")).toHaveLength(2);
  });

  it("re-extraction supersedes ONLY prior AI suggestions — human-touched rooms persist", async () => {
    seedRoomsScene();
    roomRows.push(
      {
        id: "rm_old",
        job_id: "j1",
        plan_id: "pl1",
        page_index: 0,
        page_sha256: "sha0",
        origin: "ai",
        status: "suggested",
        name: "OLD GUESS",
        human_name: null,
        bbox: { x: 0.1, y: 0.7, w: 0.1, h: 0.1 },
        human_bbox: null,
        confidence: 0.4,
        extraction_id: "ex_prev",
        model: "claude-opus-4-8",
        prompt_version: "rv-v0",
        superseded_by: null,
        created_at: "2026-07-02T00:00:00.000Z",
        created_by_label: "boss",
        reviewed_at: null,
        reviewed_by_label: null,
        review_note: null,
      },
      {
        id: "rm_kept",
        job_id: "j1",
        plan_id: "pl1",
        page_index: 0,
        page_sha256: "sha0",
        origin: "ai",
        status: "accepted",
        name: "GARAGE",
        human_name: null,
        bbox: { x: 0.7, y: 0.1, w: 0.2, h: 0.2 },
        human_bbox: null,
        confidence: 0.9,
        extraction_id: "ex_prev",
        model: "claude-opus-4-8",
        prompt_version: "rv-v0",
        superseded_by: null,
        created_at: "2026-07-02T00:00:00.000Z",
        created_by_label: "boss",
        reviewed_at: "2026-07-02T01:00:00.000Z",
        reviewed_by_label: "boss",
        review_note: null,
      },
    );
    aiNextText = JSON.stringify(ROOMS_OUTPUT);
    const res = await extract();
    expect(res.statusCode).toBe(200);
    expect(roomRows.find((r) => r.id === "rm_old")?.status).toBe("superseded");
    expect(roomRows.find((r) => r.id === "rm_kept")?.status).toBe("accepted");
    expect((res.body.page.rooms as Row[]).map((r) => r.name).sort()).toEqual([
      "BED 2",
      "GARAGE",
      "KITCHEN",
    ]);
  });

  it("rename and redraw are edited-status overrides that win on read and re-group instantly", async () => {
    seedRoomsScene();
    aiNextText = JSON.stringify(ROOMS_OUTPUT);
    const first = await extract();
    const kitchen = (first.body.page.rooms as Row[]).find((r) => r.name === "KITCHEN") as Row;

    const renamed = await call("POST", { jobId: "j1", action: "review-room" }, {
      roomId: kitchen.id,
      status: "edited",
      name: "KITCHEN/MEALS",
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.body.room).toMatchObject({
      name: "KITCHEN",
      effectiveName: "KITCHEN/MEALS",
      status: "edited",
    });

    // redraw the box away from d1 — d1 must fall back to unzoned
    const redrawn = await call("POST", { jobId: "j1", action: "review-room" }, {
      roomId: kitchen.id,
      status: "edited",
      bbox: { x: 0.05, y: 0.05, w: 0.08, h: 0.08 },
    });
    expect(redrawn.statusCode).toBe(200);
    expect(redrawn.body.room.effectiveName).toBe("KITCHEN/MEALS"); // rename survives redraw
    const byRoom = redrawn.body.page.byRoom as Row[];
    const unzoned = byRoom.find((r) => r.roomId === null) as Row;
    expect(unzoned.total).toBe(2); // d1 + d3
    // bare edited without a rename or redraw is meaningless
    const bare = await call("POST", { jobId: "j1", action: "review-room" }, {
      roomId: kitchen.id,
      status: "edited",
    });
    expect(bare.statusCode).toBe(400);
  });

  it("rejecting a room drops it from grouping; its devices go unzoned, never dropped", async () => {
    seedRoomsScene();
    aiNextText = JSON.stringify(ROOMS_OUTPUT);
    const first = await extract();
    const bed = (first.body.page.rooms as Row[]).find((r) => r.name === "BED 2") as Row;
    const res = await call("POST", { jobId: "j1", action: "review-room" }, {
      roomId: bed.id,
      status: "rejected",
    });
    expect(res.statusCode).toBe(200);
    const byRoom = res.body.page.byRoom as Row[];
    expect(byRoom.map((r) => r.roomName)).toEqual(["KITCHEN", null]);
    expect((byRoom.find((r) => r.roomId === null) as Row).total).toBe(2); // d2 + d3
    // total markers across groups never shrinks
    const total = byRoom.reduce((n, r) => n + (r.total as number), 0);
    expect(total).toBe(3);
  });

  it("a human adds a room; it is born accepted and groups immediately", async () => {
    seedRoomsScene();
    const res = await call("POST", { jobId: "j1", action: "add-room" }, {
      planId: "pl1",
      pageIndex: 0,
      name: "RUMPUS",
      bbox: { x: 0.15, y: 0.15, w: 0.15, h: 0.15 }, // catches d3 (0.215, 0.215)
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.room).toMatchObject({ origin: "human", status: "accepted", name: "RUMPUS" });
    const byRoom = res.body.page.byRoom as Row[];
    const rumpus = byRoom.find((r) => r.roomName === "RUMPUS") as Row;
    expect(rumpus.total).toBe(1);
  });

  it("pin a device to a room, pin it unzoned, clear back to geometry", async () => {
    seedRoomsScene();
    aiNextText = JSON.stringify(ROOMS_OUTPUT);
    const first = await extract();
    const kitchen = (first.body.page.rooms as Row[]).find((r) => r.name === "KITCHEN") as Row;

    // pin the unzoned d3 INTO the kitchen
    const pinned = await call("POST", { jobId: "j1", action: "assign-device-room" }, {
      planId: "pl1",
      pageIndex: 0,
      markerKey: "d:d3",
      roomId: kitchen.id,
    });
    expect(pinned.statusCode).toBe(200);
    const d3 = (pinned.body.page.markers as Row[]).find((m) => m.key === "d:d3") as Row;
    expect(d3).toMatchObject({ roomId: kitchen.id, roomPinned: true });
    expect((pinned.body.page.byRoom as Row[]).some((r) => r.roomId === null)).toBe(false);

    // park d1 explicitly unzoned despite sitting inside the kitchen box
    const parked = await call("POST", { jobId: "j1", action: "assign-device-room" }, {
      planId: "pl1",
      pageIndex: 0,
      markerKey: "d:d1",
      roomId: null,
    });
    expect(parked.statusCode).toBe(200);
    const d1 = (parked.body.page.markers as Row[]).find((m) => m.key === "d:d1") as Row;
    expect(d1).toMatchObject({ roomId: null, roomPinned: true });

    // clear the pin — d1 returns to geometric grouping (kitchen)
    const cleared = await call("POST", { jobId: "j1", action: "clear-device-room" }, {
      planId: "pl1",
      pageIndex: 0,
      markerKey: "d:d1",
    });
    expect(cleared.statusCode).toBe(200);
    const d1After = (cleared.body.page.markers as Row[]).find((m) => m.key === "d:d1") as Row;
    expect(d1After).toMatchObject({ roomId: kitchen.id, roomPinned: false });

    const audits = auditEntries.filter(
      (a) => (a.metadata as Row)?.kind === "room-assignment",
    );
    expect(audits.length).toBe(3); // pin + park + clear all recorded
  });

  it("guards: unknown marker 404, rejected-room pin 409, clearing a non-pin 404", async () => {
    seedRoomsScene();
    aiNextText = JSON.stringify(ROOMS_OUTPUT);
    const first = await extract();
    const bed = (first.body.page.rooms as Row[]).find((r) => r.name === "BED 2") as Row;

    const ghost = await call("POST", { jobId: "j1", action: "assign-device-room" }, {
      planId: "pl1",
      pageIndex: 0,
      markerKey: "d:nope",
      roomId: bed.id,
    });
    expect(ghost.statusCode).toBe(404);

    await call("POST", { jobId: "j1", action: "review-room" }, {
      roomId: bed.id,
      status: "rejected",
    });
    const toRejected = await call("POST", { jobId: "j1", action: "assign-device-room" }, {
      planId: "pl1",
      pageIndex: 0,
      markerKey: "d:d2",
      roomId: bed.id,
    });
    expect(toRejected.statusCode).toBe(409);

    const clearNothing = await call("POST", { jobId: "j1", action: "clear-device-room" }, {
      planId: "pl1",
      pageIndex: 0,
      markerKey: "d:d2",
    });
    expect(clearNothing.statusCode).toBe(404);
  });

  it("502s on unusable model output — spend recorded, no rooms stored (P7)", async () => {
    seedRoomsScene();
    aiNextText = "the kitchen is probably in the middle";
    const res = await extract();
    expect(res.statusCode).toBe(502);
    expect(spendLedger().calls).toHaveLength(1);
    expect(roomRows).toHaveLength(0);
  });
});

describe("cable estimates (#211)", () => {
  // Two GPOs at (0.42,0.42) and (0.62,0.62), one downlight at (0.215,0.215).
  function seedCableScene() {
    legendRows.push({
      id: "le_gpo",
      job_id: "j1",
      origin: "ai",
      status: "accepted",
      label: "Double GPO",
      normalized_label: "double gpo",
      human_label: null,
      symbol_text: null,
      symbol_crop_url: null,
    });
    deviceDetections.push(
      {
        id: "d1",
        job_id: "j1",
        plan_id: "pl1",
        page_index: 0,
        page_sha256: "sha0",
        run_id: "run_x",
        kind: "device",
        legend_entry_id: "le_gpo",
        label: "Double GPO",
        bbox: { x: 0.4, y: 0.4, w: 0.04, h: 0.04 },
        confidence: 0.9,
        note: null,
        created_at: "2026-07-03T00:00:00.000Z",
      },
      {
        id: "d2",
        job_id: "j1",
        plan_id: "pl1",
        page_index: 0,
        page_sha256: "sha0",
        run_id: "run_x",
        kind: "device",
        legend_entry_id: "le_gpo",
        label: "Double GPO",
        bbox: { x: 0.6, y: 0.6, w: 0.04, h: 0.04 },
        confidence: 0.8,
        note: null,
        created_at: "2026-07-03T00:00:01.000Z",
      },
    );
  }

  const pin = (boardIdentifier = "DB-1", point = { x: 0.1, y: 0.1 }) =>
    call("POST", { jobId: "j1", action: "pin-board" }, {
      planId: "pl1",
      pageIndex: 0,
      boardIdentifier,
      point,
    });
  // square raster, reference: half the page width = 5,000mm → 10,000mm/unit
  const calibrate = () =>
    call("POST", { jobId: "j1", action: "calibrate-sheet" }, {
      planId: "pl1",
      pageIndex: 0,
      pointA: { x: 0.25, y: 0.5 },
      pointB: { x: 0.75, y: 0.5 },
      realMm: 5000,
      rasterAspect: 1,
    });
  const estimate = (factors?: Record<string, number>) =>
    call("POST", { jobId: "j1", action: "estimate-cable" }, {
      planId: "pl1",
      pageIndex: 0,
      factors,
    });

  it("refuses to estimate without a calibration — flagged, never unit-guessed", async () => {
    seedCableScene();
    await pin();
    const res = await estimate();
    expect(res.statusCode).toBe(409);
    expect(String(res.body.error)).toContain("calibrate");
  });

  it("refuses to estimate without a board pin", async () => {
    seedCableScene();
    await calibrate();
    const res = await estimate();
    expect(res.statusCode).toBe(409);
    expect(String(res.body.error)).toContain("board");
  });

  it("calibration stores derived scales and the title-block cross-check; pins land on the page block", async () => {
    seedCableScene();
    // the sheet has an AI-understood scale for the cross-check
    await call("POST", { jobId: "j1", action: "understand-page" }, {
      planId: "pl1",
      pageIndex: 0,
    });
    const cal = await calibrate();
    expect(cal.statusCode).toBe(200);
    expect(cal.body.calibration).toMatchObject({
      mmPerNormX: 10000,
      mmPerNormY: 10000,
      titleScaleText: "1:100", // from GOOD_OUTPUT's title block — cross-check only
    });
    const pinned = await pin();
    expect(pinned.statusCode).toBe(200);
    expect(pinned.body.page.cable.pins).toHaveLength(1);
    expect(pinned.body.page.cable.calibration).not.toBeNull();
    const audit = auditEntries.find(
      (a) => a.action === "document.cable_estimated" && (a.metadata as Row)?.kind === "calibration",
    );
    expect(audit).toBeTruthy();
  });

  it("estimates Manhattan runs with the applied assumption set stored on the result", async () => {
    seedCableScene();
    await calibrate();
    await pin("DB-1", { x: 0.1, y: 0.1 });
    const res = await estimate({ routingFactor: 1, riseDropMm: 0, slackFactor: 1 });
    expect(res.statusCode).toBe(200);
    const run = res.body.run;
    expect(run.status).toBe("draft");
    expect(run.stale).toBe(false);
    expect(run.factors).toEqual({ routingFactor: 1, riseDropMm: 0, slackFactor: 1 });
    // d1 centre (0.42,0.42) → manhattan (0.32+0.32)×10,000 = 6,400mm
    const d1 = run.results.perDevice.find((d: Row) => d.markerKey === "d:d1");
    expect(d1).toMatchObject({ boardIdentifier: "DB-1", manhattanMm: 6400, estimateMm: 6400 });
    // d2 centre (0.62,0.62) → 10,400mm
    expect(run.results.totalMm).toBe(6400 + 10400);
    // full input snapshot rides the run — reproducible
    expect(run.inputs.markerKeys).toEqual(["d:d1", "d:d2"]);
    expect(run.inputs.calibration).toMatchObject({ mmPerNormX: 10000, realMm: 5000 });
    expect(run.inputs.pins).toEqual([{ boardIdentifier: "DB-1", point: { x: 0.1, y: 0.1 } }]);
    const audit = auditEntries.find(
      (a) =>
        a.action === "document.cable_estimated" && (a.metadata as Row)?.kind === "cable-estimate",
    );
    expect(String(audit?.summary)).toContain("heuristic draft");
  });

  it("changing factors recomputes transparently — new draft supersedes, acceptance never carries", async () => {
    seedCableScene();
    await calibrate();
    await pin();
    const first = await estimate({ routingFactor: 1, riseDropMm: 0, slackFactor: 1 });
    const accepted = await call("POST", { jobId: "j1", action: "accept-cable-estimate" }, {
      runId: first.body.run.id,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.body.run.status).toBe("accepted");
    const auditAccept = auditEntries.find(
      (a) => a.action === "document.cable_estimate_accepted",
    );
    expect(String(auditAccept?.summary)).toContain("ESTIMATE");

    const second = await estimate({ routingFactor: 2, riseDropMm: 0, slackFactor: 1 });
    expect(second.statusCode).toBe(200);
    expect(second.body.run.status).toBe("draft"); // re-acceptance required
    expect(second.body.run.results.totalMm).toBe((6400 + 10400) * 2);
    expect(cableRuns.filter((r) => r.status === "superseded")).toHaveLength(1);

    // accepting the superseded run is refused
    const stale = await call("POST", { jobId: "j1", action: "accept-cable-estimate" }, {
      runId: first.body.run.id,
    });
    expect(stale.statusCode).toBe(409);
  });

  it("marker corrections after a run make it visibly stale", async () => {
    seedCableScene();
    await calibrate();
    await pin();
    await estimate();
    const del = await call("POST", { jobId: "j1", action: "review-marker" }, {
      action: "delete",
      detectionId: "d2",
    });
    expect(del.body.page.cable.run.stale).toBe(true);
  });

  it("re-pinning a board after a run makes it stale too", async () => {
    seedCableScene();
    await calibrate();
    await pin();
    await estimate();
    const moved = await pin("DB-1", { x: 0.9, y: 0.9 });
    expect(moved.body.page.cable.run.stale).toBe(true);
  });

  it("clears a board pin; unknown pin 404s", async () => {
    seedCableScene();
    await pin();
    const cleared = await call("POST", { jobId: "j1", action: "clear-board-pin" }, {
      planId: "pl1",
      pageIndex: 0,
      boardIdentifier: "DB-1",
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.body.page.cable.pins).toHaveLength(0);
    const missing = await call("POST", { jobId: "j1", action: "clear-board-pin" }, {
      planId: "pl1",
      pageIndex: 0,
      boardIdentifier: "DB-9",
    });
    expect(missing.statusCode).toBe(404);
  });

  it("rejects a degenerate calibration reference", async () => {
    seedCableScene();
    const res = await call("POST", { jobId: "j1", action: "calibrate-sheet" }, {
      planId: "pl1",
      pageIndex: 0,
      pointA: { x: 0.5, y: 0.5 },
      pointB: { x: 0.505, y: 0.5 },
      realMm: 5000,
      rasterAspect: 1,
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.body.error)).toContain("too close");
  });
});

describe("cross-sheet links (#212)", () => {
  const REFS_OUTPUT = {
    refs: [
      {
        text: "REFER E-501 FOR SWITCHBOARD DETAILS",
        targetSheetNumber: "E-501",
        bbox: { x: 0.7, y: 0.3, w: 0.12, h: 0.02 },
        confidence: 0.9,
      },
      { text: "SEE DWG E-999", targetSheetNumber: "E-999", bbox: null, confidence: 0.6 },
    ],
    notes: null,
  };

  // give pl1 p1 the sheet number E-501 via the review loop so refs resolve
  async function seedRegistrySheet() {
    aiNextText = JSON.stringify({
      ...GOOD_OUTPUT,
      titleBlock: {
        ...GOOD_OUTPUT.titleBlock,
        sheetNumber: { value: "E-501", confidence: 0.95 },
      },
    });
    await call("POST", { jobId: "j1", action: "understand-page" }, {
      planId: "pl1",
      pageIndex: 1,
    });
  }

  const extractRefs = () =>
    call("POST", { jobId: "j1", action: "extract-refs" }, { planId: "pl1", pageIndex: 0 });

  it("detects callouts, resolves against the registry LIVE, lists unresolved honestly", async () => {
    await seedRegistrySheet();
    aiNextText = JSON.stringify(REFS_OUTPUT);
    const res = await extractRefs();
    expect(res.statusCode).toBe(200);
    expect(res.body.cached).toBe(false);
    expect(res.body.inserted).toBe(2);
    const resolved = (res.body.refs as Row[]).find(
      (r) => r.targetSheetNumber === "E-501",
    ) as Row;
    expect(resolved.resolved).toEqual({ planId: "pl1", pageIndex: 1 });
    const unresolved = (res.body.refs as Row[]).find(
      (r) => r.targetSheetNumber === "E-999",
    ) as Row;
    expect(unresolved.resolved).toBeNull(); // honestly unresolved
    expect(spendLedger().calls.some((c) => c.kind === "extract-refs")).toBe(true);

    // correcting a sheet number re-resolves WITHOUT re-extraction
    const cleared = await call("POST", { jobId: "j1", action: "override" }, {
      planId: "pl1",
      pageIndex: 1,
      field: "sheetNumber",
      value: "E-000",
    });
    expect(cleared.statusCode).toBe(200);
    const list = await call("GET", { jobId: "j1", action: "links" });
    const after = (list.body.refs as Row[]).find((r) => r.targetSheetNumber === "E-501") as Row;
    expect(after.resolved).toBeNull(); // registry moved; resolution followed
  });

  it("cached refs re-click: no second bill, no duplicate rows", async () => {
    aiNextText = JSON.stringify(REFS_OUTPUT);
    await extractRefs();
    const res = await extractRefs();
    expect(res.body.cached).toBe(true);
    expect(res.body.inserted).toBe(0);
    expect(aiCalls).toHaveLength(1);
    expect(sheetRefsArr.filter((r) => r.status === "live")).toHaveLength(2);
  });

  it("proposes same-board links from exact identifier matches — pure, no AI call", async () => {
    // a board on a schedule page and the same board pinned on a floor plan
    scheduleTables.push({
      id: "st_1",
      job_id: "j1",
      plan_id: "pl1",
      page_index: 1,
      page_sha256: "sha1",
      table_kind: "switchboard",
      board_identifier: "DB-1",
      status: "live",
    });
    boardPins.push({
      id: "bp_1",
      job_id: "j1",
      plan_id: "pl1",
      page_index: 0,
      page_sha256: "sha0",
      board_identifier: "db 1", // normalises to DB 1... deliberately different
      point: { x: 0.1, y: 0.1 },
    });
    boardPins.push({
      id: "bp_2",
      job_id: "j1",
      plan_id: "pl2",
      page_index: 0,
      page_sha256: "sha0",
      board_identifier: "db-1",
      point: { x: 0.2, y: 0.2 },
    });
    const res = await call("POST", { jobId: "j1", action: "propose-links" }, {});
    expect(res.statusCode).toBe(200);
    expect(aiCalls).toHaveLength(0); // pure scan
    // DB-1 sighted on pl1:1 (schedule) and pl2:0 (pin) → exactly one proposal;
    // "db 1" normalises to "DB 1" ≠ "DB-1" so it stays unlinked
    expect(res.body.proposed).toBe(1);
    const link = (res.body.links as Row[]).find((l) => l.status === "proposed") as Row;
    expect(link).toMatchObject({ kind: "same-board", identifier: "DB-1", origin: "ai" });

    // re-scan is idempotent
    const again = await call("POST", { jobId: "j1", action: "propose-links" }, {});
    expect(again.body.proposed).toBe(0);
    expect(again.body.alreadyKnown).toBeGreaterThanOrEqual(1);
  });

  it("links only take effect after confirmation; rejection is sticky across re-scans", async () => {
    scheduleTables.push({
      id: "st_1",
      job_id: "j1",
      plan_id: "pl1",
      page_index: 1,
      page_sha256: "sha1",
      table_kind: "switchboard",
      board_identifier: "MSB",
      status: "live",
    });
    boardPins.push({
      id: "bp_1",
      job_id: "j1",
      plan_id: "pl2",
      page_index: 0,
      page_sha256: "sha0",
      board_identifier: "MSB",
      point: { x: 0.5, y: 0.5 },
    });
    const first = await call("POST", { jobId: "j1", action: "propose-links" }, {});
    const linkId = (first.body.links as Row[])[0]?.id as string;

    const rejected = await call("POST", { jobId: "j1", action: "review-link" }, {
      linkId,
      status: "rejected",
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.body.link.status).toBe("rejected");

    const rescan = await call("POST", { jobId: "j1", action: "propose-links" }, {});
    expect(rescan.body.proposed).toBe(0); // stays rejected

    // change of mind: rejected → confirmed is allowed
    const confirmed = await call("POST", { jobId: "j1", action: "review-link" }, {
      linkId,
      status: "confirmed",
    });
    expect(confirmed.body.link.status).toBe("confirmed");
    const audit = auditEntries.filter(
      (a) => a.action === "document.ai_corrected" && (a.metadata as Row)?.kind === "entity-link",
    );
    expect(audit.length).toBe(2);
  });

  it("human-added links are born confirmed with canonical ordering; duplicates 409", async () => {
    const res = await call("POST", { jobId: "j1", action: "add-link" }, {
      kind: "same-board",
      identifier: "db-2",
      a: { planId: "pl2", pageIndex: 0 }, // deliberately out of order
      b: { planId: "pl1", pageIndex: 0 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.link).toMatchObject({
      identifier: "DB-2",
      origin: "human",
      status: "confirmed",
      a: { planId: "pl1", pageIndex: 0 },
      b: { planId: "pl2", pageIndex: 0 },
    });
    const dup = await call("POST", { jobId: "j1", action: "add-link" }, {
      kind: "same-board",
      identifier: "DB-2",
      a: { planId: "pl1", pageIndex: 0 },
      b: { planId: "pl2", pageIndex: 0 },
    });
    expect(dup.statusCode).toBe(409);
    const self = await call("POST", { jobId: "j1", action: "add-link" }, {
      kind: "same-board",
      identifier: "DB-3",
      a: { planId: "pl1", pageIndex: 0 },
      b: { planId: "pl1", pageIndex: 0 },
    });
    expect(self.statusCode).toBe(400);
  });

  it("duplicate-count warnings surface on BOTH pages once both carry accepted counts", async () => {
    // accepted counts on pl1:0 and pl2:0 + a proposed link between them
    legendRows.push({
      id: "le_gpo",
      job_id: "j1",
      origin: "ai",
      status: "accepted",
      label: "Double GPO",
      normalized_label: "double gpo",
      human_label: null,
      symbol_text: null,
      symbol_crop_url: null,
    });
    for (const [planId, sha] of [["pl1", "sha0"], ["pl2", "sha0"]] as const) {
      deviceDetections.push({
        id: `d_${planId}`,
        job_id: "j1",
        plan_id: planId,
        page_index: 0,
        page_sha256: sha,
        run_id: "run_x",
        kind: "device",
        legend_entry_id: "le_gpo",
        label: "Double GPO",
        bbox: { x: 0.4, y: 0.4, w: 0.04, h: 0.04 },
        confidence: 0.9,
        note: null,
        created_at: "2026-07-03T00:00:00.000Z",
      });
      await call("POST", { jobId: "j1", action: "accept-count" }, {
        planId,
        pageIndex: 0,
        legendEntryId: "le_gpo",
      });
    }
    await call("POST", { jobId: "j1", action: "add-link" }, {
      kind: "same-board",
      identifier: "DB-1",
      a: { planId: "pl1", pageIndex: 0 },
      b: { planId: "pl2", pageIndex: 0 },
    });
    const res = await call("GET", { jobId: "j1", action: "count-review" });
    const pl1 = (res.body.pages as Row[]).find((p) => p.planId === "pl1") as Row;
    const pl2 = (res.body.pages as Row[]).find((p) => p.planId === "pl2") as Row;
    expect(pl1.duplicateCountWarnings).toEqual([
      { otherPlanId: "pl2", otherPageIndex: 0, identifier: "DB-1", status: "confirmed" },
    ]);
    expect((pl2.duplicateCountWarnings as Row[])).toHaveLength(1);
  });

  it("502s on unusable refs output — spend recorded, nothing stored (P7)", async () => {
    aiNextText = "there are some references around the edges";
    const res = await extractRefs();
    expect(res.statusCode).toBe(502);
    expect(spendLedger().calls).toHaveLength(1);
    expect(sheetRefsArr).toHaveLength(0);
  });
});

describe("takeoff assembly (#213)", () => {
  // accepted device counts on two pages + an accepted lighting schedule row
  // + an accepted cable run + a confirmed cross-sheet link (overlap warning)
  function seedAcceptedEverything() {
    acceptedCounts.push(
      {
        id: "ac_1",
        job_id: "j1",
        plan_id: "pl1",
        page_index: 0,
        page_sha256: "sha0",
        legend_entry_id: "le_gpo",
        label: "Double GPO",
        count: 12,
        basis: { markerKeys: ["d:d1"], markers: [], reviewIds: [] },
        status: "live",
        superseded_by: null,
        accepted_at: "2026-07-03T00:00:00.000Z",
        accepted_by_label: "boss",
      },
      {
        id: "ac_2",
        job_id: "j1",
        plan_id: "pl2",
        page_index: 0,
        page_sha256: "sha0",
        legend_entry_id: "le_gpo",
        label: "Double GPO",
        count: 4,
        basis: { markerKeys: ["d:d9"], markers: [], reviewIds: [] },
        status: "live",
        superseded_by: null,
        accepted_at: "2026-07-03T00:00:01.000Z",
        accepted_by_label: "boss",
      },
    );
    scheduleTables.push({
      id: "st_1",
      job_id: "j1",
      plan_id: "pl1",
      page_index: 1,
      page_sha256: "sha1",
      table_kind: "lighting",
      board_identifier: null,
      status: "live",
    });
    scheduleRowsArr.push(
      {
        id: "sr_1",
        table_id: "st_1",
        job_id: "j1",
        row_index: 0,
        status: "accepted",
        cells: {
          typeCode: { value: "L1", confidence: 0.9 },
          description: { value: "LED DOWNLIGHT", confidence: 0.9 },
          qty: { value: "24", confidence: 0.9 },
        },
        human_cells: null,
      },
      {
        id: "sr_2",
        table_id: "st_1",
        job_id: "j1",
        row_index: 1,
        status: "suggested", // unreviewed — must NOT assemble
        cells: { typeCode: { value: "L2", confidence: 0.9 } },
        human_cells: null,
      },
    );
    cableRuns.push({
      id: "cr_1",
      job_id: "j1",
      plan_id: "pl1",
      page_index: 0,
      page_sha256: "sha0",
      status: "accepted",
      factors: { routingFactor: 1.15, riseDropMm: 4000, slackFactor: 1.1 },
      inputs: {},
      results: {
        boards: [{ boardIdentifier: "DB-1", deviceCount: 12, totalMm: 184600 }],
        totalMm: 184600,
        deviceCount: 12,
      },
      superseded_by: null,
      created_at: "2026-07-03T00:00:00.000Z",
      created_by_label: "boss",
      accepted_at: "2026-07-03T00:00:02.000Z",
      accepted_by_label: "boss",
    });
    entityLinksArr.push({
      id: "el_1",
      job_id: "j1",
      kind: "same-board",
      identifier: "DB-1",
      a_plan_id: "pl1",
      a_page_index: 0,
      b_plan_id: "pl2",
      b_page_index: 0,
      confidence: 0.9,
      evidence: "test",
      origin: "ai",
      status: "confirmed",
      created_at: "2026-07-03T00:00:00.000Z",
      created_by_label: null,
      reviewed_at: "2026-07-03T00:00:00.000Z",
      reviewed_by_label: "boss",
    });
  }

  const assemble = () => call("POST", { jobId: "j1", action: "assemble-takeoff" }, {});

  it("409s with nothing accepted — unverified output never assembles", async () => {
    const res = await assemble();
    expect(res.statusCode).toBe(409);
    expect(String(res.body.error)).toContain("nothing accepted");
  });

  it("assembles ONLY accepted rows: provenance per line, estimates labelled, overlap warnings carried", async () => {
    seedAcceptedEverything();
    const res = await assemble();
    expect(res.statusCode).toBe(200);
    const draft = res.body.draft;
    expect(draft.status).toBe("draft");
    expect(draft.version).toBe(1);
    // 2 count lines + 1 accepted schedule row (suggested row excluded) + 1 cable line
    expect(draft.lines).toHaveLength(4);
    const types = draft.lines.map((l: Row) => l.sourceType);
    expect(types).toEqual(["device-count", "device-count", "schedule-row", "cable-estimate"]);
    // provenance resolves back to the exact rows
    expect(draft.lines[0].provenance).toMatchObject({ acceptedCountId: "ac_1", planId: "pl1" });
    expect(draft.lines[2].provenance).toMatchObject({ rowId: "sr_1", tableKind: "lighting" });
    expect(draft.lines[3]).toMatchObject({ estimate: true, unit: "m", qty: 184.6 });
    // both counted pages are linked → duplicate-scope warnings flag the lines
    expect(draft.warnings.length).toBeGreaterThanOrEqual(1);
    expect(draft.lines[0].flagged).toBe(true);
    expect(String(draft.lines[0].flagReason)).toContain("duplicate scope");
    const audit = auditEntries.find((a) => (a.metadata as Row)?.kind === "takeoff");
    expect(String(audit?.summary)).toContain("draft");
  });

  it("adjustments are recorded and win; effectiveQty is the quoting number", async () => {
    seedAcceptedEverything();
    const res = await assemble();
    const line = res.body.draft.lines[0];
    const adjusted = await call("POST", { jobId: "j1", action: "adjust-takeoff-line" }, {
      lineId: line.id,
      qty: 10,
      note: "two GPOs double-counted on the overlap",
    });
    expect(adjusted.statusCode).toBe(200);
    expect(adjusted.body.line).toMatchObject({
      qty: 12,
      humanQty: 10,
      effectiveQty: 10,
      adjustedBy: "boss",
      note: "two GPOs double-counted on the overlap",
    });
    // clearing returns to the assembled number
    const cleared = await call("POST", { jobId: "j1", action: "adjust-takeoff-line" }, {
      lineId: line.id,
      qty: null,
    });
    expect(cleared.body.line).toMatchObject({ humanQty: null, effectiveQty: 12 });
  });

  it("manual lines join the draft; sign-off freezes everything (immutable)", async () => {
    seedAcceptedEverything();
    const res = await assemble();
    const takeoffId = res.body.draft.id;
    const added = await call("POST", { jobId: "j1", action: "add-takeoff-line" }, {
      takeoffId,
      description: "Temporary site board",
      qty: 1,
      unit: "ea",
    });
    expect(added.statusCode).toBe(200);
    expect(added.body.line).toMatchObject({ sourceType: "manual", qty: 1 });

    const signed = await call("POST", { jobId: "j1", action: "sign-off-takeoff" }, { takeoffId });
    expect(signed.statusCode).toBe(200);
    expect(signed.body.draft).toBeNull();
    expect(signed.body.signedOff).toMatchObject({ status: "signed_off", signedOffBy: "boss" });
    expect(signed.body.signedOff.lines).toHaveLength(5);
    const audit = auditEntries.find((a) => a.action === "document.takeoff_signed_off");
    expect(String(audit?.summary)).toContain("quoting source");

    // immutability: adjusting or adding on a signed-off takeoff refuses
    const adjust = await call("POST", { jobId: "j1", action: "adjust-takeoff-line" }, {
      lineId: signed.body.signedOff.lines[0].id,
      qty: 1,
    });
    expect(adjust.statusCode).toBe(409);
    expect(String(adjust.body.error)).toContain("immutable");
    const addAfter = await call("POST", { jobId: "j1", action: "add-takeoff-line" }, {
      takeoffId,
      description: "x",
      qty: 1,
      unit: "ea",
    });
    expect(addAfter.statusCode).toBe(409);
  });

  it("re-assembly supersedes the draft; signing the new version supersedes the old signed-off", async () => {
    seedAcceptedEverything();
    const v1 = await assemble();
    await call("POST", { jobId: "j1", action: "sign-off-takeoff" }, {
      takeoffId: v1.body.draft.id,
    });
    // more work gets accepted → assemble v2
    acceptedCounts.push({
      id: "ac_3",
      job_id: "j1",
      plan_id: "pl1",
      page_index: 1,
      page_sha256: "sha1",
      legend_entry_id: "le_dl",
      label: "LED downlight",
      count: 24,
      basis: { markerKeys: [], markers: [], reviewIds: [] },
      status: "live",
      superseded_by: null,
      accepted_at: "2026-07-03T01:00:00.000Z",
      accepted_by_label: "boss",
    });
    const v2 = await assemble();
    expect(v2.body.draft.version).toBe(2);
    expect(v2.body.signedOff.version).toBe(1); // v1 stays the quoting source until v2 signs
    const signed = await call("POST", { jobId: "j1", action: "sign-off-takeoff" }, {
      takeoffId: v2.body.draft.id,
    });
    expect(signed.body.signedOff.version).toBe(2);
    expect(takeoffsArr.filter((t) => t.status === "superseded")).toHaveLength(1);
    // Epic 7 seam returns exactly the latest signed-off
    expect(takeoffsArr.filter((t) => t.status === "signed_off")).toHaveLength(1);
  });

  it("GET takeoff returns draft + signedOff views", async () => {
    seedAcceptedEverything();
    await assemble();
    const res = await call("GET", { jobId: "j1", action: "takeoff" });
    expect(res.statusCode).toBe(200);
    expect(res.body.draft).not.toBeNull();
    expect(res.body.signedOff).toBeNull();
  });
});
