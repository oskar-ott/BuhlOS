import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * api/_lib/xero/payroll-batches.js (#893) — deterministic source hashing,
 * item building from the shared rows, create (ready|blocked by validation),
 * lock with source-hash re-verification + CAS (concurrent locks: one
 * winner), unlock, delete rules, and the correction chain — against a
 * scripted in-memory postgres fake that ENFORCES the immutability the DB
 * triggers enforce in production.
 */

const requireFromHere = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = requireFromHere("../../../api/_lib/xero/payroll-batches.js");

const CONN = {
  id: "conn-1",
  tenant_id: "tenant-1",
  status: "connected",
  external_tenant_id: "org-1",
  external_tenant_name: "Demo Company (AU)",
};

function row(over: Record<string, unknown> = {}) {
  return {
    workerId: "w1", workerName: "Karen Buhl", date: "2026-07-07", jobId: "job-1", jobName: "100 Arthur",
    hours: 10, ordinaryHours: 8, overtimeHours: 2, status: "approved", exportId: "",
    ...over,
  };
}

const FRESH = new Date().toISOString();

type BatchRow = Record<string, unknown> & { id: string; status: string };

function makeFakeSql(state: {
  batches: BatchRow[];
  items: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sql: any = (strings: TemplateStringsArray | unknown[], ...vals: unknown[]) => {
    if (!Object.prototype.hasOwnProperty.call(strings, "raw")) return { __list: strings };
    const text = (strings as TemplateStringsArray).join("$v");
    return (async () => {
      if (text.includes("from public.xero_reference_items")) {
        return [
          { kind: "employee", xero_id: "emp-1", name: "Karen Buhl", active: true, payload: { status: "ACTIVE", payrollCalendarID: "cal-1", email: "k@x.com" } },
          { kind: "earnings_rate", xero_id: "er-1", name: "Ordinary Hours", active: true, payload: { earningsType: "ORDINARYTIMEEARNINGS" } },
          { kind: "earnings_rate", xero_id: "er-2", name: "Overtime", active: true, payload: { earningsType: "OVERTIMEEARNINGS" } },
        ];
      }
      if (text.includes("from public.xero_reference_syncs")) {
        return [
          { sync_group: "employees", status: "ok", created_at: FRESH },
          { sync_group: "pay_items", status: "ok", created_at: FRESH },
        ];
      }
      if (text.includes("insert into public.payroll_batches")) {
        const [, extTenant, pStart, pEnd, status, hash, validation, supersedes, revision, itemCount, totalHours, byId, byName] = vals;
        const b: BatchRow = {
          id: `batch-${state.batches.length + 1}`,
          tenant_id: "tenant-1", external_tenant_id: extTenant as string,
          period_start: pStart, period_end: pEnd, status: status as string,
          source_hash: hash, validation: JSON.parse(validation as string),
          supersedes_batch_id: supersedes, revision, item_count: itemCount, total_hours: totalHours,
          created_by_legacy_id: byId, created_by_name: byName,
          locked_at: null, created_at: new Date().toISOString(),
        };
        state.batches.push(b);
        return [{ ...b }];
      }
      if (text.includes("insert into public.payroll_batch_items")) {
        const batchId = vals[1] as string;
        const owner = state.batches.find((b) => b.id === batchId);
        if (owner && !["blocked", "ready"].includes(owner.status)) {
          throw new Error("trigger: payroll batch items are immutable");
        }
        state.items.push({ batch_id: batchId, worker_id: vals[2], work_type: vals[8], entry_date: vals[9], hours: vals[12] });
        return [];
      }
      if (text.includes("insert into public.payroll_batch_events")) {
        state.events.push({ batch_id: vals[1], event: vals[2], actor_name: vals[4], detail: vals[5] ? JSON.parse(vals[5] as string) : null, created_at: new Date().toISOString() });
        return [];
      }
      if (text.includes("select * from public.payroll_batches where id =")) {
        const b = state.batches.find((x) => x.id === vals[0]);
        return b ? [{ ...b }] : [];
      }
      if (text.includes("set status = 'locked'")) {
        // vals: [lockedById, lockedByName, validationJson, batchId]
        const target = state.batches.find((x) => x.id === vals[3] && x.status === "ready");
        if (!target) return [];
        Object.assign(target, {
          status: "locked",
          locked_by_legacy_id: vals[0], locked_by_name: vals[1],
          locked_at: new Date().toISOString(), validation: JSON.parse(vals[2] as string),
        });
        return [{ ...target }];
      }
      if (text.includes("set status = 'blocked'")) {
        const id = vals.find((v) => typeof v === "string" && String(v).startsWith("batch-"));
        const target = state.batches.find((x) => x.id === id && x.status === "ready");
        if (target) Object.assign(target, { status: "blocked", validation: JSON.parse(vals[0] as string) });
        return target ? [{ ...target }] : [];
      }
      if (text.includes("set status = 'ready', locked_at = null")) {
        const target = state.batches.find((x) => x.id === vals[0] && x.status === "locked");
        if (!target) return [];
        Object.assign(target, { status: "ready", locked_at: null });
        return [{ ...target }];
      }
      if (text.includes("delete from public.payroll_batches")) {
        const idx = state.batches.findIndex((x) => x.id === vals[0] && ["blocked", "ready"].includes(x.status));
        if (idx >= 0) {
          const gone = state.batches[idx]!;
          state.batches.splice(idx, 1);
          state.items = state.items.filter((i) => i.batch_id !== gone.id);
        }
        return [];
      }
      if (text.includes("from public.payroll_batch_items")) {
        return state.items.filter((i) => i.batch_id === vals[0]).map((i) => ({ ...i }));
      }
      if (text.includes("from public.payroll_batch_events")) {
        return state.events.filter((e) => e.batch_id === vals[0]).map((e) => ({ ...e }));
      }
      if (text.includes("select * from public.payroll_batches")) {
        return state.batches.map((b) => ({ ...b }));
      }
      throw new Error(`fake sql: unmatched query: ${text.slice(0, 80)}`);
    })();
  };
  sql.begin = async (cb: (tx: unknown) => Promise<unknown>) => cb(sql);
  return sql;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let state: { batches: BatchRow[]; items: any[]; events: any[] };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let deps: any;
let liveRows: Array<Record<string, unknown>>;

beforeEach(() => {
  state = { batches: [], items: [], events: [] };
  liveRows = [row()];
  deps = {
    sql: makeFakeSql(state),
    store: { getConnection: vi.fn(async () => ({ ...CONN })) },
    collectRows: vi.fn(async ({ fromDate, toDate }: { fromDate: string; toDate: string }) => ({
      ok: true, fromDate, toDate, rows: liveRows.map((r) => ({ ...r })),
    })),
    mappingReadiness: vi.fn(async (ids: string[]) => ids.map((id) => ({ workerId: id, employeeId: "emp-1", mapped: true }))),
    worktypeReadiness: vi.fn(async () => [
      { workType: "ordinary", label: "Ordinary hours", rateId: "er-1", rateName: "Ordinary Hours", mapped: true },
      { workType: "overtime", label: "Overtime", rateId: "er-2", rateName: "Overtime", mapped: true },
    ]),
  };
});

const PERIOD = { periodStart: "2026-07-06", periodEnd: "2026-07-12" };

describe("sourceHashOf / buildItems", () => {
  it("hash is deterministic and order-independent; changes when source changes", () => {
    const a = lib.sourceHashOf([row(), row({ workerId: "w2" })]);
    const b = lib.sourceHashOf([row({ workerId: "w2" }), row()]);
    expect(a).toBe(b);
    expect(lib.sourceHashOf([row({ ordinaryHours: 7 })])).not.toBe(a);
  });

  it("splits a row into ordinary + overtime items with mapping snapshots", () => {
    const items = lib.buildItems([row()], {
      workerReadiness: [{ workerId: "w1", employeeId: "emp-1", mapped: true }],
      worktypeReadiness: [
        { workType: "ordinary", rateId: "er-1", rateName: "Ordinary Hours", mapped: true },
        { workType: "overtime", rateId: "er-2", rateName: "Overtime", mapped: true },
      ],
      employeesById: new Map([["emp-1", { name: "Karen Buhl", active: true }]]),
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ workType: "ordinary", hours: 8, employeeId: "emp-1", employeeName: "Karen Buhl", earningsRateId: "er-1" });
    expect(items[1]).toMatchObject({ workType: "overtime", hours: 2, earningsRateId: "er-2", sourceEntryRef: "users/w1/time-entries/2026-07-07.json" });
  });
});

describe("create / lock / unlock / delete", () => {
  it("creates a READY batch with items, events and validation snapshot", async () => {
    const out = await lib.createBatch({ ...PERIOD, actor: { id: "a", name: "Boss" }, deps });
    expect(out.batch.status).toBe("ready");
    expect(out.batch.item_count).toBe(2);
    expect(state.items).toHaveLength(2);
    expect(state.events.map((e) => e.event)).toEqual(["created"]);
    expect(out.validation.ready).toBe(true);
  });

  it("creates a BLOCKED batch when validation fails, with the reasons stored", async () => {
    // Sole worker unmapped = the degenerate all-unmapped case, which still
    // BLOCKS under the 2026-07-26 withhold-and-warn ratification (nothing to push).
    deps.mappingReadiness.mockResolvedValueOnce([{ workerId: "w1", employeeId: null, mapped: false }]);
    const out = await lib.createBatch({ ...PERIOD, actor: { id: "a" }, deps });
    expect(out.batch.status).toBe("blocked");
    expect(out.validation.errors.map((e: { code: string }) => e.code)).toContain("unmapped_workers");
  });

  it("locks a ready batch (CAS): concurrent second lock loses", async () => {
    const { batch } = await lib.createBatch({ ...PERIOD, actor: { id: "a" }, deps });
    const locked = await lib.lockBatch({ batchId: batch.id, actor: { id: "a", name: "Boss" }, deps });
    expect(locked.batch.status).toBe("locked");
    expect(state.events.map((e) => e.event)).toContain("locked");
    await expect(lib.lockBatch({ batchId: batch.id, actor: { id: "a" }, deps })).rejects.toMatchObject({ category: "conflict" });
  });

  it("REFUSES to lock over drifted source, blocks the batch loudly", async () => {
    const { batch } = await lib.createBatch({ ...PERIOD, actor: { id: "a" }, deps });
    liveRows = [row({ ordinaryHours: 7.5, hours: 9.5 })]; // hours edited after batch creation
    await expect(lib.lockBatch({ batchId: batch.id, actor: { id: "a" }, deps })).rejects.toMatchObject({ category: "conflict" });
    const b = state.batches.find((x) => x.id === batch.id)!;
    expect(b.status).toBe("blocked");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((b.validation as any).errors.map((e: { code: string }) => e.code)).toContain("source_drift");
    expect(state.events.map((e) => e.event)).toContain("revalidated");
  });

  it("REFUSES to lock when validation regressed (e.g. mapping removed)", async () => {
    const { batch } = await lib.createBatch({ ...PERIOD, actor: { id: "a" }, deps });
    deps.mappingReadiness.mockResolvedValue([{ workerId: "w1", employeeId: null, mapped: false }]);
    await expect(lib.lockBatch({ batchId: batch.id, actor: { id: "a" }, deps })).rejects.toMatchObject({ category: "conflict" });
    expect(state.batches.find((x) => x.id === batch.id)!.status).toBe("blocked");
  });

  it("unlock returns a locked batch to ready; unlocking anything else 409s", async () => {
    const { batch } = await lib.createBatch({ ...PERIOD, actor: { id: "a" }, deps });
    await lib.lockBatch({ batchId: batch.id, actor: { id: "a" }, deps });
    const unlocked = await lib.unlockBatch({ batchId: batch.id, actor: { id: "a" }, deps });
    expect(unlocked.status).toBe("ready");
    await expect(lib.unlockBatch({ batchId: batch.id, actor: { id: "a" }, deps })).rejects.toMatchObject({ category: "conflict" });
  });

  it("delete works pre-lock only; a locked batch refuses deletion", async () => {
    const { batch } = await lib.createBatch({ ...PERIOD, actor: { id: "a" }, deps });
    await lib.lockBatch({ batchId: batch.id, actor: { id: "a" }, deps });
    await expect(lib.deleteBatch({ batchId: batch.id, actor: { id: "a" }, deps })).rejects.toMatchObject({ category: "conflict" });
    await lib.unlockBatch({ batchId: batch.id, actor: { id: "a" }, deps });
    const gone = await lib.deleteBatch({ batchId: batch.id, actor: { id: "a" }, deps });
    expect(gone.id).toBe(batch.id);
    expect(state.batches).toHaveLength(0);
    expect(state.items).toHaveLength(0);
  });
});

describe("correction chain", () => {
  it("a correction batch supersedes a locked batch (rev+1) and may include exported rows", async () => {
    const { batch } = await lib.createBatch({ ...PERIOD, actor: { id: "a" }, deps });
    await lib.lockBatch({ batchId: batch.id, actor: { id: "a" }, deps });
    liveRows = [row({ exportId: "exp_1" })]; // now exported — a normal batch would block
    const correction = await lib.createBatch({ ...PERIOD, supersedesBatchId: batch.id, actor: { id: "a" }, deps });
    expect(correction.batch.status).toBe("ready"); // allowExported: exported rows pass
    expect(correction.batch.revision).toBe(2);
    expect(correction.batch.supersedes_batch_id).toBe(batch.id);
    const events = state.events.map((e) => e.event);
    expect(events).toContain("correction_created");
    expect(events).toContain("superseded");
  });

  it("refuses a correction of an unlocked batch, and of an unknown batch", async () => {
    const { batch } = await lib.createBatch({ ...PERIOD, actor: { id: "a" }, deps });
    await expect(
      lib.createBatch({ ...PERIOD, supersedesBatchId: batch.id, actor: { id: "a" }, deps })
    ).rejects.toMatchObject({ category: "validation" });
    await expect(
      lib.createBatch({ ...PERIOD, supersedesBatchId: "batch-none", actor: { id: "a" }, deps })
    ).rejects.toMatchObject({ category: "validation" });
  });
});

// 2026-07-26 owner ratification (lean-reset replica): unmapped workers are
// withheld with a warning; the batch pushes everyone else. Launch pain point:
// one unmapped worker used to freeze the whole period's pay.
describe("withhold-and-warn: unmapped workers", () => {
  const mixedMapping = (ids: string[]) =>
    ids.map((id) => ({ workerId: id, employeeId: id === "w2" ? null : "emp-1", mapped: id !== "w2" }));

  beforeEach(() => {
    liveRows = [row(), row({ workerId: "w2", workerName: "Alex West", hours: 6, ordinaryHours: 6, overtimeHours: 0 })];
    deps.mappingReadiness.mockImplementation(async (ids: string[]) => mixedMapping(ids));
  });

  it("creates a READY batch that withholds the unmapped worker's rows entirely", async () => {
    const out = await lib.createBatch({ ...PERIOD, actor: { id: "a", name: "Boss" }, deps });
    expect(out.batch.status).toBe("ready");
    expect(out.validation.ready).toBe(true);
    const warning = out.validation.warnings.find((w: { code: string }) => w.code === "unmapped_workers_withheld");
    expect(warning.withheldWorkers).toEqual([{ workerId: "w2", workerName: "Alex West", hours: 6 }]);
    expect(out.validation.withheldWorkers).toEqual([{ workerId: "w2", workerName: "Alex West", hours: 6 }]);
    // the snapshot (and therefore the export payload source) has NO withheld rows
    expect(out.items.every((i: { workerId: string }) => i.workerId === "w1")).toBe(true);
    expect(state.items.every((i) => i.worker_id === "w1")).toBe(true);
    // the withheld list is recorded on the batch (validation snapshot + event)
    const created = state.events.find((e) => e.event === "created");
    expect(created!.detail.withheldWorkers).toEqual([{ workerId: "w2", workerName: "Alex West", hours: 6 }]);
  });

  it("the export payload builder receives no withheld worker", async () => {
    const out = await lib.createBatch({ ...PERIOD, actor: { id: "a" }, deps });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildTimesheets } = requireFromHere("../../../api/_lib/xero/timesheet-payload.js");
    const built = buildTimesheets({
      items: out.items,
      periodStart: PERIOD.periodStart,
      periodEnd: PERIOD.periodEnd,
      employeesById: new Map([["emp-1", { name: "Karen Buhl", active: true, payload: { payrollCalendarID: "cal-1" } }]]),
      calendarsById: new Map([["cal-1", { name: "Weekly", payload: { calendarType: "WEEKLY", startDate: "2026-07-06" } }]]),
    });
    expect(built.workers.map((w: { workerId: string }) => w.workerId)).toEqual(["w1"]);
    expect(built.workers[0].timesheet.EmployeeID).toBe("emp-1");
  });

  it("withheld rows keep no exportId: a follow-up batch pays exactly them once the worker is mapped", async () => {
    // batch A: w2 withheld, w1 pushed
    const a = await lib.createBatch({ ...PERIOD, actor: { id: "a" }, deps });
    expect(a.batch.status).toBe("ready");
    await lib.lockBatch({ batchId: a.batch.id, actor: { id: "a" }, deps });

    // after export, w1's source rows are stamped; w2's withheld rows are NOT.
    // The worker then gets mapped in Xero settings.
    liveRows = [
      row({ exportId: String(a.batch.id) }),
      row({ workerId: "w2", workerName: "Alex West", hours: 6, ordinaryHours: 6, overtimeHours: 0 }),
    ];
    deps.mappingReadiness.mockImplementation(async (ids: string[]) =>
      ids.map((id) => ({ workerId: id, employeeId: "emp-1", mapped: true })));

    // follow-up NORMAL batch over the same period validates cleanly and
    // contains exactly the previously-withheld rows
    const b = await lib.createBatch({ ...PERIOD, actor: { id: "a" }, deps });
    expect(b.batch.status).toBe("ready");
    expect(b.validation.ready).toBe(true);
    expect(b.validation.errors).toEqual([]);
    expect(b.validation.warnings.map((w: { code: string }) => w.code)).toContain("already_exported_excluded");
    expect(b.items.map((i: { workerId: string }) => i.workerId)).toEqual(["w2"]);
    expect(b.validation.withheldWorkers).toEqual([]);

    // double-pay guard: once EVERYTHING is exported, another normal batch blocks
    liveRows = [row({ exportId: String(a.batch.id) })];
    const c = await lib.createBatch({ ...PERIOD, actor: { id: "a" }, deps });
    expect(c.batch.status).toBe("blocked");
    expect(c.validation.errors.map((e: { code: string }) => e.code)).toContain("already_exported");
  });

  it("mapping a withheld worker between create and lock reads as source drift — the lock refuses", async () => {
    const a = await lib.createBatch({ ...PERIOD, actor: { id: "a" }, deps });
    // w2 becomes mapped → the included set (and its hash) changes
    deps.mappingReadiness.mockImplementation(async (ids: string[]) =>
      ids.map((id) => ({ workerId: id, employeeId: "emp-1", mapped: true })));
    await expect(lib.lockBatch({ batchId: a.batch.id, actor: { id: "a" }, deps })).rejects.toMatchObject({ category: "conflict" });
    const b = state.batches.find((x) => x.id === a.batch.id)!;
    expect(b.status).toBe("blocked");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((b.validation as any).errors.map((e: { code: string }) => e.code)).toContain("source_drift");
  });
});

describe("previewBatch", () => {
  it("validates without persisting anything", async () => {
    const out = await lib.previewBatch({ ...PERIOD, deps });
    expect(out.validation.ready).toBe(true);
    expect(out.items).toHaveLength(2);
    expect(state.batches).toHaveLength(0);
    expect(state.events).toHaveLength(0);
  });
});
