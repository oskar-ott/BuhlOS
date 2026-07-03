import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #170 — api/_lib/ai-tools.js, the permission-scoped AI read-tool layer.
 * Real auth.js tier logic (canManageJob / isAdminRole), stubbed blob reads.
 * Covers: per-tier gates (field never, LH assigned-only, admin any), honest
 * empties for a job with no data, tool outputs from fixture stores, source
 * references, and runTool's unknown-tool error.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const timeEntriesPath = requireFromHere.resolve("../../../api/_lib/time-entries.js");
const dayPulsePath = requireFromHere.resolve("../../../api/_lib/day-pulse.js");
const toolsPath = requireFromHere.resolve("../../../api/_lib/ai-tools.js");
const vercelBlobPath = requireFromHere.resolve("@vercel/blob");
const dbPath = requireFromHere.resolve("../../../api/_lib/supabase-db.js");
const drawingsStorePath = requireFromHere.resolve("../../../api/_lib/ai-drawings-store.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fixture-shaped tool output, asserted per test
type ToolData = Record<string, any>;
type ToolResult =
  | { ok: true; data: ToolData }
  | { ok: false; error: { code: string; message: string } };
type ToolsModule = {
  runTool: (user: unknown, name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
  listTools: () => Array<{ name: string; description: string }>;
};

let store: Map<string, unknown>;
let approverEntries: unknown[];
let tools: ToolsModule;
// #179 drawing_extractions fixtures — empty by default; describes seed them.
let dbAvailable: boolean;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fixture rows, snake_case like PG
let drawingsFixture: Record<string, any[]>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fixture shape
let signedOffTakeoffFixture: any;

const admin = { id: "u_admin", username: "boss", role: "boss", assignedJobIds: [] };
const lhAssigned = { id: "u_lh", username: "lh", role: "leadingHand", assignedJobIds: ["job-1"] };
const lhOther = { id: "u_lh2", username: "lh2", role: "leadinghand", assignedJobIds: ["job-9"] };
const fieldAssigned = { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["job-1"] };

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  approverEntries = [];
  store = new Map<string, unknown>([
    [
      "jobs.json",
      {
        jobs: [
          {
            id: "job-1",
            name: "Riverside Units",
            type: "multi-res",
            status: "active",
            createdAt: "2026-05-01T00:00:00.000Z",
            roughInTasks: [{ id: "t_r1" }, { id: "t_r2" }],
            fitOffTasks: [{ id: "t_f1" }],
            areaGroups: [{ id: "g1", areas: [{ id: "a1", name: "Unit 1" }, { id: "a2", name: "Unit 2" }] }],
          },
          { id: "job-empty", name: "Bare Job", status: "active", areaGroups: [] },
        ],
      },
    ],
    [
      "jobs/job-1/data.json",
      {
        dwellings: {
          a1: { roughIn: { tasks: { t_r1: "complete", t_r2: "complete" } }, fitOff: { tasks: {} } },
          a2: { roughIn: { tasks: { t_r1: "complete" } }, fitOff: { tasks: { t_f1: "complete" } } },
        },
        snags: [
          { id: "s1", desc: "Missing GPO in kitchen", status: "Open", priority: "High", dwelling: "Unit 1", by: "sparky", createdAt: "2026-06-30T01:00:00.000Z" },
          { id: "s2", desc: "Fixed one", status: "Closed", priority: "Low", closedAt: "2026-06-20T01:00:00.000Z" },
        ],
        evidence: [{ id: "e1" }, { id: "e2" }, { id: "e3" }],
        notes: [],
      },
    ],
    [
      "observations.json",
      {
        observations: [
          { id: "ob_1", jobId: "job-1", type: "blocker", title: "No access to roof", status: "new", priority: "high", requiresAction: true, createdAt: "2026-07-01T00:00:00.000Z" },
          { id: "ob_2", jobId: "job-1", type: "note", title: "Done with this", status: "resolved", priority: "low", requiresAction: false },
          { id: "ob_3", jobId: "job-9", type: "blocker", title: "Other job", status: "new", priority: "high", requiresAction: true },
        ],
      },
    ],
  ]);

  dbAvailable = true;
  drawingsFixture = {
    sheets: [],
    overrides: [],
    legend: [],
    tables: [],
    scheduleRows: [],
    rooms: [],
    refs: [],
    counts: [],
    cableRuns: [],
  };
  signedOffTakeoffFixture = null;
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
  requireFromHere.cache[drawingsStorePath] = {
    id: drawingsStorePath,
    filename: drawingsStorePath,
    loaded: true,
    exports: {
      resolveTenantId: async () => "tenant-1",
      listPlanSheets: async () => drawingsFixture.sheets,
      listOverrides: async () => drawingsFixture.overrides,
      acceptedLegendEntries: async () => drawingsFixture.legend,
      listScheduleTables: async () => drawingsFixture.tables,
      listScheduleRowsForTables: async () => drawingsFixture.scheduleRows,
      listRooms: async () => drawingsFixture.rooms,
      listSheetRefs: async () => drawingsFixture.refs,
      liveAcceptedCounts: async () => drawingsFixture.counts,
      acceptedCableRuns: async () => drawingsFixture.cableRuns,
      signedOffTakeoff: async () => signedOffTakeoffFixture,
    },
  } as NodeJS.Module;
  for (const p of [authPath, dayPulsePath, toolsPath]) delete requireFromHere.cache[p];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        store.has(key) ? clone(store.get(key)) : fallback
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        store.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  requireFromHere.cache[timeEntriesPath] = {
    id: timeEntriesPath,
    filename: timeEntriesPath,
    loaded: true,
    exports: {
      listAllEntriesForApprovers: vi.fn(async () => clone(approverEntries)),
    },
  } as NodeJS.Module;
  requireFromHere.cache[vercelBlobPath] = {
    id: vercelBlobPath,
    filename: vercelBlobPath,
    loaded: true,
    exports: { list: vi.fn(async () => ({ blobs: [] })) },
  } as NodeJS.Module;

  tools = requireFromHere(toolsPath) as ToolsModule;
});

afterEach(() => {
  for (const p of [blobPath, timeEntriesPath, vercelBlobPath, authPath, dayPulsePath, toolsPath]) {
    delete requireFromHere.cache[p];
  }
  vi.restoreAllMocks();
});

describe("permission gates (the audit point)", () => {
  it("field tier can NEVER read job tools — even on an assigned job", async () => {
    const r = await tools.runTool(fieldAssigned, "job_overview", { jobId: "job-1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("FORBIDDEN");
  });

  it("leading hand reads an ASSIGNED job, is refused an unassigned one", async () => {
    const okRes = await tools.runTool(lhAssigned, "job_overview", { jobId: "job-1" });
    expect(okRes.ok).toBe(true);
    const denied = await tools.runTool(lhOther, "job_overview", { jobId: "job-1" });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.message).toBe("no access to job");
  });

  it("admin tier reads any job; all three job tools share the gate", async () => {
    for (const name of ["job_overview", "job_hours", "job_open_items"]) {
      const r = await tools.runTool(admin, name, { jobId: "job-1" });
      expect(r.ok, `${name} should allow admin`).toBe(true);
      const f = await tools.runTool(fieldAssigned, name, { jobId: "job-1" });
      expect(f.ok, `${name} should refuse field`).toBe(false);
    }
  });

  it("company_day_pulse is admin-tier only (LH refused despite staff status)", async () => {
    const denied = await tools.runTool(lhAssigned, "company_day_pulse", { date: "2026-06-30" });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.message).toBe("admin tier only");
    const ok = await tools.runTool(admin, "company_day_pulse", { date: "2026-06-30" });
    expect(ok.ok).toBe(true);
  });

  it("missing jobId and unauthenticated user are refused", async () => {
    const noJob = await tools.runTool(admin, "job_overview", {});
    expect(noJob.ok).toBe(false);
    if (!noJob.ok) expect(noJob.error.message).toBe("jobId required");
    const anon = await tools.runTool(null, "job_overview", { jobId: "job-1" });
    expect(anon.ok).toBe(false);
  });
});

describe("job_overview", () => {
  it("returns the job record + real counts with source references", async () => {
    const r = await tools.runTool(admin, "job_overview", { jobId: "job-1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.job).toMatchObject({ id: "job-1", name: "Riverside Units", status: "active" });
    expect(r.data.areas).toEqual({ count: 2 });
    // 2 areas × 2 rough-in tasks = 4 total, 3 complete; 2 × 1 fit-off = 2, 1 complete.
    expect(r.data.tasks).toEqual({
      roughIn: { total: 4, complete: 3 },
      fitOff: { total: 2, complete: 1 },
    });
    expect(r.data.openSnagCount).toBe(1);
    expect(r.data.evidenceCount).toBe(3);
    expect(r.data.sources).toEqual([
      { store: "jobs.json", id: "job-1" },
      { store: "jobs/job-1/data.json", id: null },
    ]);
  });

  it("a missing job returns an honest null — nothing invented", async () => {
    const r = await tools.runTool(admin, "job_overview", { jobId: "job-nope" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.job).toBeNull();
    expect(r.data.openSnagCount).toBeNull();
    expect(r.data.evidenceCount).toBeNull();
  });

  it("a job with no data.json returns explicit zero counts (honest empties)", async () => {
    const r = await tools.runTool(admin, "job_overview", { jobId: "job-empty" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.job?.id).toBe("job-empty");
    expect(r.data.areas).toEqual({ count: 0 });
    expect(r.data.tasks).toEqual({ roughIn: { total: 0, complete: 0 }, fitOff: { total: 0, complete: 0 } });
    expect(r.data.openSnagCount).toBe(0);
    expect(r.data.evidenceCount).toBe(0);
  });
});

describe("job_hours", () => {
  it("sums approved + submitted allocations for THIS job only, with entry sources", async () => {
    approverEntries = [
      {
        id: "te1", userId: "u_field", date: "2026-06-29", status: "approved",
        allocations: [{ jobId: "job-1", hours: 4 }, { jobId: "job-9", hours: 2 }],
      },
      {
        id: "te2", userId: "u_lh", date: "2026-06-30", status: "submitted",
        allocations: [{ jobId: "job-1", hours: 3.5 }],
      },
      {
        id: "te3", userId: "u_field", date: "2026-06-30", status: "submitted",
        allocations: [{ jobId: "job-9", hours: 8 }],
      },
    ];
    const r = await tools.runTool(admin, "job_hours", { jobId: "job-1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.approved).toEqual({ entryCount: 1, hours: 4 });
    expect(r.data.submitted).toEqual({ entryCount: 1, hours: 3.5 });
    expect(r.data.sources).toEqual([
      { store: "users/u_field/time-entries/2026-06-29.json", id: "te1" },
      { store: "users/u_lh/time-entries/2026-06-30.json", id: "te2" },
    ]);
  });

  it("a job with no hours returns explicit zeros", async () => {
    const r = await tools.runTool(admin, "job_hours", { jobId: "job-1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.approved).toEqual({ entryCount: 0, hours: 0 });
    expect(r.data.submitted).toEqual({ entryCount: 0, hours: 0 });
    expect(r.data.sources).toEqual([]);
  });
});

describe("job_open_items", () => {
  it("returns open snags + live observations for the job, closed items excluded", async () => {
    const r = await tools.runTool(admin, "job_open_items", { jobId: "job-1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.openSnags).toHaveLength(1);
    expect(r.data.openSnags[0]).toMatchObject({
      id: "s1",
      description: "Missing GPO in kitchen",
      priority: "High",
      area: "Unit 1",
    });
    // ob_2 is resolved (closed), ob_3 belongs to another job.
    expect(r.data.openObservations).toHaveLength(1);
    expect(r.data.openObservations[0]).toMatchObject({ id: "ob_1", type: "blocker", status: "new" });
  });

  it("a job with nothing open returns explicit empty arrays", async () => {
    const r = await tools.runTool(admin, "job_open_items", { jobId: "job-empty" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.openSnags).toEqual([]);
    expect(r.data.openObservations).toEqual([]);
  });
});

describe("company_day_pulse", () => {
  it("reuses the today-pulse engine: active jobs + snags opened on the date", async () => {
    const r = await tools.runTool(admin, "company_day_pulse", { date: "2026-06-30" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.date).toBe("2026-06-30");
    expect(r.data.jobs.activeJobs).toBe(2);
    // s1 was created on 2026-06-30 → openedToday 1; no hours blobs → zeros.
    expect(r.data.snags).toEqual({ openedToday: 1, resolvedToday: 0 });
    expect(r.data.hours.crewOnSite).toBe(0);
  });

  it("rejects a malformed date via READ_FAILED (no partial data)", async () => {
    const r = await tools.runTool(admin, "company_day_pulse", { date: "yesterday" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("READ_FAILED");
  });
});

describe("registry plumbing", () => {
  it("runTool refuses an unknown tool", async () => {
    const r = await tools.runTool(admin, "delete_everything", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("UNKNOWN_TOOL");
  });

  it("listTools exposes names + descriptions only", () => {
    const listed = tools.listTools();
    expect(listed.map((t) => t.name).sort()).toEqual([
      "company_day_pulse",
      "drawing_extractions",
      "job_hours",
      "job_open_items",
      "job_overview",
    ]);
    for (const t of listed) {
      expect(Object.keys(t).sort()).toEqual(["description", "name"]);
    }
  });
});

describe("drawing_extractions (#179)", () => {
  it("gates like every job read: field never, LH assigned-only", async () => {
    expect((await tools.runTool(fieldAssigned, "drawing_extractions", { jobId: "job-1" })).ok).toBe(false);
    expect((await tools.runTool(lhOther, "drawing_extractions", { jobId: "job-1" })).ok).toBe(false);
    expect((await tools.runTool(lhAssigned, "drawing_extractions", { jobId: "job-1" })).ok).toBe(true);
  });

  it("says the store is unreachable instead of guessing (preview/local)", async () => {
    dbAvailable = false;
    const res = await tools.runTool(admin, "drawing_extractions", { jobId: "job-1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.available).toBe(false);
    expect(String(res.data.reason)).toContain("not reachable");
  });

  it("returns the extraction index with citations: effective sheet fields, verified counts, live-resolved refs, estimates flagged", async () => {
    drawingsFixture.sheets = [
      {
        plan_id: "pl1", page_index: 0,
        sheet_type: "floorPlan", sheet_number: "E-101", sheet_title: "LEVEL 1 POWER",
        revision: "C", scale: "1:100",
      },
      {
        plan_id: "pl1", page_index: 4,
        sheet_type: "detail", sheet_number: "E-501", sheet_title: "DETAILS",
        revision: "C", scale: null,
      },
    ];
    // a human corrected page 0's number — the effective value must win
    drawingsFixture.overrides = [
      { plan_id: "pl1", page_index: 0, field: "sheetNumber", value: "E-101A" },
    ];
    drawingsFixture.legend = [
      { label: "GPO", human_label: "Double GPO", description: null, category: "Power", source_plan_id: "pl1", source_page_index: 2 },
    ];
    drawingsFixture.counts = [
      { label: "Double GPO", count: 12, plan_id: "pl1", page_index: 0, accepted_by_label: "boss" },
    ];
    drawingsFixture.refs = [
      { plan_id: "pl1", page_index: 0, text: "REFER E-501", target_sheet_number: "E-501" },
      { plan_id: "pl1", page_index: 0, text: "SEE E-999", target_sheet_number: "E-999" },
    ];
    drawingsFixture.rooms = [
      { name: "KITCHEN", human_name: null, plan_id: "pl1", page_index: 0, status: "suggested" },
      { name: "BED2", human_name: "BED 2", plan_id: "pl1", page_index: 0, status: "edited" },
      { name: "GONE", human_name: null, plan_id: "pl1", page_index: 0, status: "rejected" },
    ];
    drawingsFixture.cableRuns = [
      {
        plan_id: "pl1", page_index: 0,
        results: { boards: [{ boardIdentifier: "DB-1", totalMm: 184600 }] },
      },
    ];
    signedOffTakeoffFixture = {
      takeoff: { version: 2, signed_off_by_label: "boss", signed_off_at: "2026-07-03T02:00:00.000Z" },
      lines: [{ id: "tl_1" }, { id: "tl_2" }],
    };

    const res = await tools.runTool(admin, "drawing_extractions", { jobId: "job-1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const d = res.data;
    expect(d.available).toBe(true);
    // effective sheet number (override wins) + citation fields present
    expect(d.sheets.items[0]).toMatchObject({ planId: "pl1", pageIndex: 0, sheetNumber: "E-101A" });
    // human legend label wins
    expect(d.legend.items[0]).toMatchObject({ label: "Double GPO", sourcePlanId: "pl1" });
    // verified counts cite their sheet
    expect(d.verifiedCounts.items[0]).toMatchObject({ label: "Double GPO", count: 12, planId: "pl1", pageIndex: 0 });
    // refs resolve live against EFFECTIVE numbers; unresolved stays null
    expect(d.refs.items[0].resolved).toEqual({ planId: "pl1", pageIndex: 4 });
    expect(d.refs.items[1].resolved).toBeNull();
    // rooms: rejected drops, edited carries the human name + reviewed flag
    expect(d.rooms.total).toBe(2);
    expect(d.rooms.items[1]).toMatchObject({ name: "BED 2", reviewed: true });
    expect(d.rooms.items[0]).toMatchObject({ name: "KITCHEN", reviewed: false });
    // cable estimates flagged estimate: true
    expect(d.cableEstimates.items[0]).toMatchObject({ boardIdentifier: "DB-1", estimate: true });
    // signed-off takeoff summarised
    expect(d.signedOffTakeoff).toMatchObject({ version: 2, lineCount: 2 });
    expect(Array.isArray(d.sources)).toBe(true);
  });

  it("honest empties: a job with no extractions returns zero-count lists, never invented records", async () => {
    const res = await tools.runTool(admin, "drawing_extractions", { jobId: "job-1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.sheets).toEqual({ total: 0, truncated: false, items: [] });
    expect(res.data.verifiedCounts.total).toBe(0);
    expect(res.data.signedOffTakeoff).toBeNull();
  });
});
