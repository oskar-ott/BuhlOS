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
