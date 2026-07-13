import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * api/_lib/xero/timesheet-export.js (#249) — the export/reconcile service, the
 * FIRST Xero write. Runs the REAL service against a fake tagged-template SQL
 * (an in-memory model of payroll_batches / _items / xero_reference_items /
 * timesheet_attempts / _events) and a mocked Xero client that echoes POSTed
 * timesheets back on readback.
 *
 * Pins the non-negotiables:
 *   - preview performs NO write;
 *   - a durable `pending` event is written BEFORE the POST;
 *   - the attempt row is immutable and inserted with its terminal outcome;
 *   - accepted_by_xero ≠ verified_against_xero (readback must match);
 *   - a readback mismatch → drifted, never silently "verified";
 *   - changed hours for an already-accepted worker are BLOCKED (no overwrite);
 *   - partial success is itemised; only accepted+verified workers get stamped;
 *   - retry re-reads an accepted-but-unverified worker (no second POST);
 *   - reconcile never POSTs.
 */

const requireFromHere = createRequire(import.meta.url);
const clientPath = requireFromHere.resolve("../../../api/_lib/xero/client.js");
const dbPath = requireFromHere.resolve("../../../api/_lib/supabase-db.js");
const timeEntriesPath = requireFromHere.resolve("../../../api/_lib/time-entries.js");
const svcPath = requireFromHere.resolve("../../../api/_lib/xero/timesheet-export.js");
const errorsPath = requireFromHere.resolve("../../../api/_lib/xero/errors.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let svc: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let XeroError: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let xeroFetch: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let timeEntries: any;

const CONN = { tenant_id: "t1", external_tenant_id: "org-1", status: "active" };
const PERIOD = { period_start: "2026-07-06", period_end: "2026-07-12" };

// ── in-memory DB model + a fake tagged-template `sql` ─────────────────────────
type Row = Record<string, unknown>;
interface Model {
  batch: Row;
  items: Row[];
  reference: Row[];
  attempts: Row[];
  events: Row[];
  seq: number;
}

function freshModel(over: Partial<Model> = {}): Model {
  return {
    batch: { id: "b1", status: "locked", external_tenant_id: "org-1", tenant_id: "t1", ...PERIOD, source_hash: "h1", item_count: 2, total_hours: 10 },
    items: [
      refItem("w-alex", "Alex", "e-alex", "r-ord", "Ordinary", "2026-07-06", 8),
      refItem("w-alex", "Alex", "e-alex", "r-ot", "Overtime 1.5x", "2026-07-08", 2),
      refItem("w-jamie", "Jamie", "e-jamie", "r-ord", "Ordinary", "2026-07-06", 8),
    ],
    reference: [
      { kind: "employee", xero_id: "e-alex", name: "Alex", active: true, payload: { payrollCalendarID: "cal-weekly" } },
      { kind: "employee", xero_id: "e-jamie", name: "Jamie", active: true, payload: { payrollCalendarID: "cal-weekly" } },
      { kind: "payroll_calendar", xero_id: "cal-weekly", name: "Weekly", active: true, payload: { calendarType: "WEEKLY", startDate: "2026-07-06" } },
    ],
    attempts: [],
    events: [],
    seq: 0,
    ...over,
  };
}
function refItem(worker_id: string, worker_name: string, employee_id: string, earnings_rate_id: string, earnings_rate_name: string, entry_date: string, hours: number): Row {
  return { worker_id, worker_name, employee_id, employee_name: worker_name, earnings_rate_id, earnings_rate_name, work_type: earnings_rate_id === "r-ot" ? "overtime" : "ordinary", entry_date, job_name: "Riverside", hours };
}

function makeSql(m: Model) {
  return async function sql(strings: TemplateStringsArray, ...values: unknown[]) {
    const q = strings.join(" ? ").replace(/\s+/g, " ").trim().toLowerCase();

    if (q.startsWith("insert into public.payroll_batch_timesheet_attempts")) {
      const k = ["id", "tenant_id", "batch_id", "external_tenant_id", "worker_id", "worker_name", "employee_id", "period_start", "period_end", "content_hash", "request_hash", "xero_timesheet_id", "correlation_id", "http_status", "outcome", "error_category", "error_detail", "actor_legacy_id", "actor_name"];
      const row: Row = { _seq: ++m.seq };
      k.forEach((key, i) => (row[key] = values[i]));
      m.attempts.push(row);
      return [];
    }
    if (q.startsWith("insert into public.payroll_batch_timesheet_events")) {
      const [tenant_id, batch_id, attempt_id, worker_id, event, detail] = values;
      m.events.push({ _seq: ++m.seq, tenant_id, batch_id, attempt_id, worker_id, event, detail: detail == null ? null : JSON.parse(String(detail)) });
      return [];
    }
    if (q.includes("update public.payroll_batches")) {
      if (q.includes("set status = 'exporting'")) {
        if (m.batch.status === "locked") { m.batch.status = "exporting"; return [{ id: m.batch.id }]; }
        return [];
      }
      const status = values[0];
      if (["exporting", "partially_exported"].includes(String(m.batch.status))) m.batch.status = status;
      return [];
    }
    if (q.includes("from public.payroll_batches")) {
      return m.batch.id === values[0] ? [clone(m.batch)] : [];
    }
    if (q.includes("from public.payroll_batch_items")) {
      if (q.includes("distinct entry_date")) {
        const [batchId, workerId] = values;
        const dates = [...new Set(m.items.filter((r) => r.worker_id === workerId).map((r) => r.entry_date))];
        void batchId;
        return dates.map((d) => ({ entry_date: d }));
      }
      return m.items.map(clone);
    }
    if (q.includes("from public.xero_reference_items")) {
      return m.reference.map(clone);
    }
    if (q.includes("from public.payroll_batch_timesheet_attempts")) {
      if (q.includes("outcome = 'accepted'")) {
        const [ext, emp, ps, pe] = values;
        const hit = m.attempts
          .filter((a) => a.external_tenant_id === ext && a.employee_id === emp && a.period_start === ps && a.period_end === pe && a.outcome === "accepted")
          .sort((a, b) => Number(b._seq) - Number(a._seq))[0];
        return hit ? [clone(hit)] : [];
      }
      return [...m.attempts].sort((a, b) => Number(b._seq) - Number(a._seq)).map(clone);
    }
    if (q.includes("from public.payroll_batch_timesheet_events")) {
      if (q.includes("distinct on (worker_id)")) {
        const latest = new Map<unknown, Row>();
        for (const e of [...m.events].sort((a, b) => Number(a._seq) - Number(b._seq))) latest.set(e.worker_id, e);
        return [...latest.values()].map((e) => ({ worker_id: e.worker_id, event: e.event }));
      }
      if (q.includes("limit 1")) {
        const [batchId, workerId] = values;
        const hit = m.events.filter((e) => e.batch_id === batchId && e.worker_id === workerId).sort((a, b) => Number(b._seq) - Number(a._seq))[0];
        return hit ? [clone(hit)] : [];
      }
      return [...m.events].sort((a, b) => Number(b._seq) - Number(a._seq)).map(clone);
    }
    throw new Error("unhandled query: " + q);
  };
}
function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}
function deps(m: Model) {
  return { sql: makeSql(m), store: { getConnection: async () => clone(CONN) } };
}

// ── mocked Xero client: POST creates + stores; GET echoes it back ─────────────
function installXeroEcho() {
  const created = new Map<string, Row>();
  let n = 0;
  xeroFetch.mockImplementation(async (url: string, opts: Record<string, unknown> = {}) => {
    const method = (opts.method as string) || "GET";
    if (method === "POST" && /\/Timesheets$/.test(url)) {
      const sent = (opts.body as { Timesheets: Row[] }).Timesheets[0];
      const id = `ts-${++n}`;
      const rec = { TimesheetID: id, EmployeeID: sent.EmployeeID, StartDate: sent.StartDate, EndDate: sent.EndDate, Status: "DRAFT", TimesheetLines: sent.TimesheetLines };
      created.set(id, rec);
      return { data: { Timesheets: [rec] }, correlationId: "corr-post", status: 200 };
    }
    const mm = url.match(/\/Timesheets\/([^/?]+)/);
    if (mm) {
      const rec = created.get(mm[1]);
      return { data: { Timesheets: rec ? [rec] : [] }, correlationId: "corr-get", status: 200 };
    }
    return { data: {}, status: 200 };
  });
  return created;
}

beforeEach(() => {
  for (const p of [clientPath, dbPath, timeEntriesPath, svcPath]) delete requireFromHere.cache[p];
  xeroFetch = vi.fn();
  requireFromHere.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: { xeroFetch, PAYROLL_AU_BASE: "https://api.xero.com/payroll.xro/1.0" } } as NodeJS.Module;
  const fakeSql = null; // stampWorkerEntries uses getDb — return a model-bound sql per test via closure
  void fakeSql;
  let stampModel: Model | null = null;
  requireFromHere.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: { getDb: () => makeSql(stampModel ?? freshModel()), __setStampModel: (m: Model) => { stampModel = m; } },
  } as NodeJS.Module;
  timeEntries = {
    readEntry: vi.fn(async (userId: string, date: string) => ({ id: `te_${userId}_${date}`, userId, date, __rev: "r1" })),
    writeEntry: vi.fn(async () => ({})),
    appendAudit: vi.fn(async () => ({})),
  };
  requireFromHere.cache[timeEntriesPath] = { id: timeEntriesPath, filename: timeEntriesPath, loaded: true, exports: timeEntries } as NodeJS.Module;

  ({ XeroError } = requireFromHere(errorsPath));
  svc = requireFromHere(svcPath);
});

// stampWorkerEntries reads via getDb() — point it at the live model so its
// distinct-entry-date query sees the same items.
function bindStamp(m: Model) {
  (requireFromHere.cache[dbPath]!.exports as { __setStampModel: (m: Model) => void }).__setStampModel(m);
}

describe("previewExport — no write", () => {
  it("returns per-worker verdicts and writes nothing", async () => {
    const m = freshModel();
    const out = await svc.previewExport({ batchId: "b1", deps: deps(m) });
    expect(out.counts.total).toBe(2); // alex + jamie
    expect(out.counts.toSend).toBe(2);
    expect(out.workers.every((w: { verdict: string }) => w.verdict === "send")).toBe(true);
    expect(m.attempts).toHaveLength(0);
    expect(m.events).toHaveLength(0);
    expect(xeroFetch).not.toHaveBeenCalled();
    expect(m.batch.status).toBe("locked"); // untouched
  });
});

describe("exportBatch — the write + readback", () => {
  it("writes pending BEFORE the POST, an immutable accepted attempt, then verifies", async () => {
    const m = freshModel();
    bindStamp(m);
    installXeroEcho();
    const out = await svc.exportBatch({ batchId: "b1", actor: { id: "u1", name: "Boss" }, deps: deps(m) });

    // both workers verified
    expect(out.workers.map((w: { outcome: string }) => w.outcome).sort()).toEqual(["verified", "verified"]);
    expect(out.batch.status).toBe("exported");

    // per worker: a pending event exists BEFORE the accepted attempt/event
    const alexEvents = m.events.filter((e) => e.worker_id === "w-alex").sort((a, b) => Number(a._seq) - Number(b._seq));
    expect(alexEvents.map((e) => e.event)).toEqual(["pending", "accepted_by_xero", "verified_against_xero"]);
    const alexAttempt = m.attempts.find((a) => a.worker_id === "w-alex")!;
    expect(alexAttempt.outcome).toBe("accepted");
    expect(Number(alexAttempt._seq)).toBeGreaterThan(Number(alexEvents[0]._seq)); // attempt after the pending event
    // pending event carries the content + request hashes (durable pre-POST record)
    const pending = alexEvents[0].detail as { contentHash: string; requestHash: string };
    expect(pending.contentHash).toBeTruthy();
    expect(pending.requestHash).toMatch(/^[0-9a-f]{64}$/);

    // POST happened before the readback GET for each worker
    const calls = xeroFetch.mock.calls.map((c: unknown[]) => (c[1] as { method?: string })?.method || "GET");
    expect(calls.filter((x: string) => x === "POST")).toHaveLength(2);
    expect(calls.filter((x: string) => x === "GET")).toHaveLength(2);

    // only verified workers get their source entries stamped
    expect(timeEntries.writeEntry).toHaveBeenCalled();
    const stampedArgs = timeEntries.writeEntry.mock.calls.map((c: unknown[]) => (c[1] as { exportId?: string }).exportId);
    expect(stampedArgs.every((id: string) => id === "b1")).toBe(true);
  });

  it("a readback MISMATCH → drifted (accepted ≠ verified), and does NOT stamp", async () => {
    const m = freshModel();
    bindStamp(m);
    const created = installXeroEcho();
    // corrupt the readback: after POST stores the record, mutate its lines so GET differs
    xeroFetch.mockImplementation(async (url: string, opts: Record<string, unknown> = {}) => {
      const method = (opts.method as string) || "GET";
      if (method === "POST" && /\/Timesheets$/.test(url)) {
        const sent = (opts.body as { Timesheets: Array<{ EmployeeID: string; StartDate: string; EndDate: string; TimesheetLines: unknown[] }> }).Timesheets[0];
        const id = `ts-${created.size + 1}`;
        created.set(id, { TimesheetID: id, EmployeeID: sent.EmployeeID, StartDate: sent.StartDate, EndDate: sent.EndDate, Status: "DRAFT", TimesheetLines: [{ EarningsRateID: "r-ord", NumberOfUnits: [99, 0, 0, 0, 0, 0, 0] }] });
        return { data: { Timesheets: [created.get(id)] }, correlationId: "c", status: 200 };
      }
      const mm = url.match(/\/Timesheets\/([^/?]+)/);
      return { data: { Timesheets: mm && created.get(mm[1]) ? [created.get(mm[1])] : [] }, status: 200 };
    });

    const out = await svc.exportBatch({ batchId: "b1", actor: { id: "u1" }, deps: deps(m) });
    expect(out.workers.every((w: { outcome: string }) => w.outcome === "drifted")).toBe(true);
    expect(out.batch.status).toBe("partially_exported");
    // drifted worker recorded, not stamped
    const alexLast = m.events.filter((e) => e.worker_id === "w-alex").sort((a, b) => Number(b._seq) - Number(a._seq))[0];
    expect(alexLast.event).toBe("drifted");
    expect(timeEntries.writeEntry).not.toHaveBeenCalled();
  });

  it("a permanent POST failure → rejected; the batch is partially_exported, never 'exported'", async () => {
    const m = freshModel();
    bindStamp(m);
    installXeroEcho();
    // alex (first, sorted by worker_name) POST throws a validation error; jamie ok
    let posts = 0;
    xeroFetch.mockImplementation(async (url: string, opts: Record<string, unknown> = {}) => {
      const method = (opts.method as string) || "GET";
      if (method === "POST") {
        posts += 1;
        if (posts === 1) throw new XeroError("validation", { detail: "inactive employee" });
        const sent = (opts.body as { Timesheets: Row[] }).Timesheets[0];
        const rec = { TimesheetID: "ts-ok", EmployeeID: sent.EmployeeID, StartDate: sent.StartDate, EndDate: sent.EndDate, Status: "DRAFT", TimesheetLines: sent.TimesheetLines };
        return { data: { Timesheets: [rec] }, status: 200 };
      }
      return { data: { Timesheets: [{ TimesheetID: "ts-ok", EmployeeID: "e-jamie", StartDate: "2026-07-06", EndDate: "2026-07-12", Status: "DRAFT", TimesheetLines: (opts as never) && [] }] }, status: 200 };
    });
    const out = await svc.exportBatch({ batchId: "b1", actor: { id: "u1" }, deps: deps(m) });
    const outcomes = out.workers.map((w: { outcome: string }) => w.outcome).sort();
    expect(outcomes).toContain("rejected");
    expect(out.batch.status).toBe("partially_exported");
  });
});

describe("idempotency + no-overwrite", () => {
  it("skips a worker whose latest accepted attempt has the SAME content hash", async () => {
    const m = freshModel();
    bindStamp(m);
    installXeroEcho();
    await svc.exportBatch({ batchId: "b1", actor: { id: "u1" }, deps: deps(m) });
    const postsFirst = xeroFetch.mock.calls.filter((c: unknown[]) => (c[1] as { method?: string })?.method === "POST").length;
    expect(postsFirst).toBe(2);

    // second export of the unchanged locked batch: both accepted+unchanged → skipped, no new POST
    m.batch.status = "partially_exported"; // resumable
    const out2 = await svc.exportBatch({ batchId: "b1", actor: { id: "u1" }, deps: deps(m) });
    const postsAfter = xeroFetch.mock.calls.filter((c: unknown[]) => (c[1] as { method?: string })?.method === "POST").length;
    expect(postsAfter).toBe(2); // no new POSTs
    expect(out2.workers.every((w: { outcome: string }) => w.outcome === "skipped" || w.outcome === "verified")).toBe(true);
  });

  it("BLOCKS changed hours for an already-accepted worker (never overwrites by employee+period)", async () => {
    const m = freshModel();
    bindStamp(m);
    installXeroEcho();
    await svc.exportBatch({ batchId: "b1", actor: { id: "u1" }, deps: deps(m) });

    // the hours change under the same batch id (simulate a corrected snapshot)
    m.items = m.items.map((r) => (r.worker_id === "w-alex" && r.earnings_rate_id === "r-ord" ? { ...r, hours: 9 } : r));
    m.batch.status = "partially_exported";
    const postsBefore = xeroFetch.mock.calls.filter((c: unknown[]) => (c[1] as { method?: string })?.method === "POST").length;
    const out = await svc.exportBatch({ batchId: "b1", actor: { id: "u1" }, deps: deps(m) });
    const postsAfter = xeroFetch.mock.calls.filter((c: unknown[]) => (c[1] as { method?: string })?.method === "POST").length;

    const alex = out.workers.find((w: { worker: string }) => w.worker === "Alex")!;
    expect(alex.outcome).toBe("blocked");
    expect(postsAfter).toBe(postsBefore); // NO overwrite POST for the changed worker
  });
});

describe("retry + reconcile — never a blind resend", () => {
  it("retry re-reads an accepted-but-unverified worker without a second POST", async () => {
    const m = freshModel();
    bindStamp(m);
    const created = installXeroEcho();
    // export, but make the FIRST readback fail so alex stays accepted-but-drifted
    let gets = 0;
    const echo = xeroFetch.getMockImplementation()!;
    xeroFetch.mockImplementation(async (url: string, opts: Record<string, unknown> = {}) => {
      const method = (opts.method as string) || "GET";
      if (method !== "POST" && /\/Timesheets\//.test(url)) {
        gets += 1;
        if (gets === 1) throw new XeroError("timeout"); // first readback fails → drifted
      }
      return echo(url, opts);
    });
    const first = await svc.exportBatch({ batchId: "b1", actor: { id: "u1" }, deps: deps(m) });
    const drifted = first.workers.filter((w: { outcome: string }) => w.outcome === "drifted");
    expect(drifted.length).toBeGreaterThanOrEqual(1);
    const postsAfterExport = xeroFetch.mock.calls.filter((c: unknown[]) => (c[1] as { method?: string })?.method === "POST").length;

    // retry: the drifted (accepted) worker is re-read, NOT re-POSTed
    void created;
    const retry = await svc.retryExport({ batchId: "b1", actor: { id: "u1" }, deps: deps(m) });
    const postsAfterRetry = xeroFetch.mock.calls.filter((c: unknown[]) => (c[1] as { method?: string })?.method === "POST").length;
    expect(postsAfterRetry).toBe(postsAfterExport); // no new POST
    expect(retry.workers.some((w: { outcome: string }) => w.outcome === "verified")).toBe(true);
  });

  it("reconcile verifies accepted-but-unverified workers and NEVER POSTs", async () => {
    const m = freshModel();
    bindStamp(m);
    const created = installXeroEcho();
    let gets = 0;
    const echo = xeroFetch.getMockImplementation()!;
    xeroFetch.mockImplementation(async (url: string, opts: Record<string, unknown> = {}) => {
      const method = (opts.method as string) || "GET";
      if (method !== "POST" && /\/Timesheets\//.test(url)) {
        gets += 1;
        if (gets <= 2) throw new XeroError("timeout"); // both first readbacks fail
      }
      return echo(url, opts);
    });
    await svc.exportBatch({ batchId: "b1", actor: { id: "u1" }, deps: deps(m) });
    const postsAfterExport = xeroFetch.mock.calls.filter((c: unknown[]) => (c[1] as { method?: string })?.method === "POST").length;
    void created;

    const rec = await svc.reconcileExport({ batchId: "b1", actor: { id: "u1" }, deps: deps(m) });
    const postsAfterReconcile = xeroFetch.mock.calls.filter((c: unknown[]) => (c[1] as { method?: string })?.method === "POST").length;
    expect(postsAfterReconcile).toBe(postsAfterExport); // reconcile never POSTs
    expect(rec.workers.every((w: { outcome: string }) => w.outcome === "verified")).toBe(true);
    expect(rec.batch.status).toBe("exported");
  });
});

describe("batchCsv — pure snapshot read", () => {
  it("builds a CSV from the batch items without any Xero call", async () => {
    const m = freshModel();
    const out = await svc.batchCsv({ batchId: "b1", deps: deps(m) });
    expect(out.filename).toMatch(/^buhlos-payroll-batch-b1-2026-07-06-to-2026-07-12\.csv$/);
    expect(out.csv.split("\n")[0]).toBe("Pay Period Start,Pay Period End,Worker Name,Xero Employee ID,Work Type,Earnings Rate,Date,Hours");
    expect(out.rowCount).toBe(3);
    expect(xeroFetch).not.toHaveBeenCalled();
  });
});
