import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

/**
 * api/_lib/xero/reference-sync.js (#610) — pure mappers (allow-lists: PII
 * never stored), employee pagination, wholesale per-group replace, partial
 * failure honesty (one group failing never blocks or fakes the others),
 * append-only sync log, and stale detection.
 */

const requireFromHere = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const refSync = requireFromHere("../../../api/_lib/xero/reference-sync.js");

const ENV = {
  XERO_CLIENT_ID: "client-id-1",
  XERO_CLIENT_SECRET: "client-secret-1",
  XERO_TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString("base64"),
  APP_BASE_URL: "https://buhlos.com",
  SUPABASE_DB_URL: "postgres://user:pass@host:6543/db",
};

function future(ms: number) {
  return new Date(Date.now() + ms).toISOString();
}

function makeFakeStore() {
  const row = {
    id: "conn-1",
    tenant_id: "tenant-1",
    status: "connected",
    refresh_version: 1,
    access_token_expires_at: future(30 * 60_000),
    external_tenant_id: "org-1",
    external_tenant_name: "Buhl Electrical",
    granted_scopes:
      "openid profile email offline_access payroll.employees.read payroll.settings.read accounting.settings.read",
  };
  return {
    row,
    getConnection: vi.fn(async (): Promise<Record<string, unknown> | null> => ({ ...row })),
    decryptTokens: vi.fn(() => ({ accessToken: "at-1", refreshToken: "rt-1" })),
    rotateTokens: vi.fn(async () => ({ ...row })),
    markFailure: vi.fn(async () => ({ ...row })),
    touchSuccess: vi.fn(async () => {}),
  };
}

type Item = { kind: string; xero_id: string; name: string; active: boolean; payload: unknown };
type SyncRow = {
  sync_group: string;
  status: string;
  item_count: number | null;
  error_category: string | null;
  correlation_id: string | null;
  created_at: string;
};

function makeFakeSql(state: { items: Item[]; syncs: SyncRow[] }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sql: any = (strings: TemplateStringsArray | unknown[], ...vals: unknown[]) => {
    // postgres.js list helper: sql(['a','b']) inside a template
    if (!Object.prototype.hasOwnProperty.call(strings, "raw")) {
      return { __list: strings };
    }
    const text = (strings as TemplateStringsArray).join("$v");
    return (async () => {
      if (text.includes("delete from public.xero_reference_items")) {
        const list = vals.find((v) => v && typeof v === "object" && "__list" in (v as object)) as
          | { __list: string[] }
          | undefined;
        const kinds = new Set(list ? list.__list : []);
        state.items = state.items.filter((i) => !kinds.has(i.kind));
        return [];
      }
      if (text.includes("insert into public.xero_reference_items")) {
        // the ::jsonb cast is load-bearing: without it the payload lands as a
        // double-encoded jsonb STRING scalar (proven on the first live sync)
        if (!text.includes("::jsonb")) throw new Error("payload insert missing ::jsonb cast");
        const [, , kind, xeroId, name, active, payload] = vals;
        state.items.push({
          kind: kind as string,
          xero_id: xeroId as string,
          name: name as string,
          active: active as boolean,
          payload: JSON.parse(payload as string),
        });
        return [];
      }
      if (text.includes("insert into public.xero_reference_syncs")) {
        const [, , group, status, itemCount, errorCategory, correlationId] = vals;
        state.syncs.push({
          sync_group: group as string,
          status: status as string,
          item_count: itemCount as number | null,
          error_category: errorCategory as string | null,
          correlation_id: correlationId as string | null,
          created_at: new Date().toISOString(),
        });
        return [];
      }
      if (text.includes("group by kind")) {
        const byKind = new Map<string, number>();
        for (const i of state.items) byKind.set(i.kind, (byKind.get(i.kind) ?? 0) + 1);
        return [...byKind.entries()].map(([kind, count]) => ({ kind, count, oldest_synced_at: null }));
      }
      if (text.includes("distinct on (sync_group)")) {
        const latest = new Map<string, SyncRow>();
        for (const s of state.syncs) latest.set(s.sync_group, s); // later rows overwrite
        return [...latest.values()];
      }
      if (text.includes("and kind = $v")) {
        const kind = vals[2] as string;
        return state.items
          .filter((i) => i.kind === kind)
          .map((i) => ({ ...i, synced_at: new Date().toISOString() }));
      }
      throw new Error(`fake sql: unmatched query: ${text.slice(0, 90)}`);
    })();
  };
  sql.begin = async (cb: (tx: unknown) => Promise<unknown>) => cb(sql);
  return sql;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  };
}

const EMPLOYEE = {
  EmployeeID: "emp-1",
  FirstName: "Karen",
  LastName: "Buhl",
  Status: "ACTIVE",
  Email: "karen@example.com",
  PayrollCalendarID: "cal-1",
  UpdatedDateUTC: "/Date(1783000000000+0000)/",
  // fields the allow-list must DROP:
  DateOfBirth: "/Date(536457600000+0000)/",
  HomeAddress: { AddressLine1: "1 Secret St" },
  TaxFileNumber: "123456789",
  Phone: "0400000000",
};

describe("mappers (allow-lists)", () => {
  it("mapEmployee keeps mapping fields only — never PII", () => {
    const m = refSync.mapEmployee(EMPLOYEE);
    expect(m).toMatchObject({
      kind: "employee",
      xeroId: "emp-1",
      name: "Karen Buhl",
      active: true,
    });
    expect(m.payload).toEqual({
      firstName: "Karen",
      lastName: "Buhl",
      status: "ACTIVE",
      email: "karen@example.com",
      payrollCalendarID: "cal-1",
      updatedDateUTC: "/Date(1783000000000+0000)/",
    });
    const s = JSON.stringify(m);
    expect(s).not.toContain("123456789");
    expect(s).not.toContain("Secret St");
    expect(s).not.toContain("536457600000");
    expect(s).not.toContain("0400000000");
  });

  it("terminated employees stay in the cache, marked inactive", () => {
    const m = refSync.mapEmployee({ ...EMPLOYEE, Status: "TERMINATED" });
    expect(m.active).toBe(false);
  });

  it("mapPayItems splits the four kinds and honours CurrentRecord", () => {
    const items = refSync.mapPayItems({
      EarningsRates: [
        { EarningsRateID: "er-1", Name: "Ordinary Hours", EarningsType: "ORDINARYTIMEEARNINGS", RateType: "RATEPERUNIT" },
        { EarningsRateID: "er-2", Name: "Old Rate", CurrentRecord: false },
      ],
      LeaveTypes: [{ LeaveTypeID: "lt-1", Name: "Annual Leave", TypeOfUnits: "Hours" }],
      DeductionTypes: [{ DeductionTypeID: "dt-1", Name: "Child Support" }],
      ReimbursementTypes: [{ ReimbursementTypeID: "rt-1", Name: "Travel" }],
    });
    expect(items.map((i: { kind: string }) => i.kind)).toEqual([
      "earnings_rate",
      "earnings_rate",
      "leave_type",
      "deduction_type",
      "reimbursement_type",
    ]);
    expect(items[1]).toMatchObject({ xeroId: "er-2", active: false });
    expect(items[0].payload).toMatchObject({ earningsType: "ORDINARYTIMEEARNINGS", rateType: "RATEPERUNIT" });
  });

  it("mapTrackingCategory keeps options and marks archived inactive", () => {
    const m = refSync.mapTrackingCategory({
      TrackingCategoryID: "tc-1",
      Name: "Job",
      Status: "ARCHIVED",
      Options: [{ TrackingOptionID: "to-1", Name: "100 Arthur", Status: "ACTIVE" }],
    });
    expect(m.active).toBe(false);
    expect(m.payload.options).toEqual([{ id: "to-1", name: "100 Arthur", status: "ACTIVE" }]);
  });
});

describe("syncReferenceData", () => {
  function routes(overrides: Record<string, unknown> = {}) {
    return vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/Employees")) {
        if ("employees" in overrides) return overrides.employees;
        return jsonResponse(200, { Employees: [EMPLOYEE] });
      }
      if (u.includes("/PayrollCalendars")) {
        return jsonResponse(200, {
          PayrollCalendars: [{ PayrollCalendarID: "cal-1", Name: "Weekly", CalendarType: "WEEKLY", StartDate: "x", PaymentDate: "y" }],
        });
      }
      if (u.includes("/PayItems")) {
        return jsonResponse(200, { PayItems: { EarningsRates: [{ EarningsRateID: "er-1", Name: "Ordinary Hours" }] } });
      }
      if (u.includes("/TrackingCategories")) {
        return jsonResponse(200, { TrackingCategories: [{ TrackingCategoryID: "tc-1", Name: "Job", Status: "ACTIVE" }] });
      }
      throw new Error(`unexpected url ${u}`);
    });
  }

  it("fetches all groups, replaces wholesale, logs ok rows", async () => {
    const state = { items: [] as Item[], syncs: [] as SyncRow[] };
    const sql = makeFakeSql(state);
    const store = makeFakeStore();
    const results = await refSync.syncReferenceData({
      deps: { sql, store, env: ENV, fetchImpl: routes() },
    });
    expect(results).toEqual([
      { group: "employees", status: "ok", itemCount: 1 },
      { group: "calendars", status: "ok", itemCount: 1 },
      { group: "pay_items", status: "ok", itemCount: 1 },
      { group: "tracking_categories", status: "ok", itemCount: 1 },
    ]);
    expect(state.items.map((i) => i.kind).sort()).toEqual([
      "earnings_rate",
      "employee",
      "payroll_calendar",
      "tracking_category",
    ]);
    expect(state.syncs.every((s) => s.status === "ok")).toBe(true);
    // no PII landed in storage either
    expect(JSON.stringify(state.items)).not.toContain("123456789");
  });

  it("pages employees until a short page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ ...EMPLOYEE, EmployeeID: `emp-${i}` }));
    const page2 = [{ ...EMPLOYEE, EmployeeID: "emp-last" }];
    let calls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("/Employees")) {
        calls += 1;
        return jsonResponse(200, { Employees: calls === 1 ? page1 : page2 });
      }
      throw new Error("unexpected");
    });
    const state = { items: [] as Item[], syncs: [] as SyncRow[] };
    const results = await refSync.syncReferenceData({
      groups: ["employees"],
      deps: { sql: makeFakeSql(state), store: makeFakeStore(), env: ENV, fetchImpl },
    });
    expect(results[0]).toEqual({ group: "employees", status: "ok", itemCount: 101 });
    expect(calls).toBe(2);
  });

  it("a failing group is honest and keeps the previous cache; others still land", async () => {
    const state = { items: [] as Item[], syncs: [] as SyncRow[] };
    const sql = makeFakeSql(state);
    const store = makeFakeStore();
    // seed a previous employee cache
    state.items.push({ kind: "employee", xero_id: "emp-old", name: "Old", active: true, payload: {} });
    const results = await refSync.syncReferenceData({
      groups: ["employees", "calendars"],
      deps: {
        sql,
        store,
        env: ENV,
        fetchImpl: routes({ employees: jsonResponse(403, {}) }),
      },
    });
    expect(results).toEqual([
      { group: "employees", status: "failed", errorCategory: "forbidden" },
      { group: "calendars", status: "ok", itemCount: 1 },
    ]);
    // previous employee cache intact — a failure is never an emptied list
    expect(state.items.some((i) => i.xero_id === "emp-old")).toBe(true);
    expect(state.items.some((i) => i.kind === "payroll_calendar")).toBe(true);
    const failedLog = state.syncs.find((s) => s.sync_group === "employees");
    expect(failedLog).toMatchObject({ status: "failed", error_category: "forbidden" });
  });

  it("throws typed errors when the sync cannot start", async () => {
    const store = makeFakeStore();
    store.getConnection.mockResolvedValueOnce(null);
    await expect(
      refSync.syncReferenceData({ deps: { sql: makeFakeSql({ items: [], syncs: [] }), store, env: ENV } })
    ).rejects.toMatchObject({ category: "not_connected" });

    const pending = makeFakeStore();
    pending.getConnection.mockResolvedValueOnce({ ...pending.row, status: "pending_selection" });
    await expect(
      refSync.syncReferenceData({ deps: { sql: makeFakeSql({ items: [], syncs: [] }), store: pending, env: ENV } })
    ).rejects.toMatchObject({ category: "pending_selection" });
  });
});

describe("getReferenceItems", () => {
  it("returns object payloads, normalising pre-fix double-encoded string rows", async () => {
    const state = { items: [] as Item[], syncs: [] as SyncRow[] };
    // a post-fix row (object) and a pre-fix row (double-encoded string)
    state.items.push({ kind: "employee", xero_id: "e1", name: "A", active: true, payload: { email: "a@x.com" } });
    state.items.push({
      kind: "employee",
      xero_id: "e2",
      name: "B",
      active: true,
      payload: JSON.stringify({ email: "b@x.com" }) as unknown,
    });
    const items = await refSync.getReferenceItems("employee", {
      deps: { sql: makeFakeSql(state), store: makeFakeStore(), env: ENV },
    });
    expect(items[0].payload).toEqual({ email: "a@x.com" });
    expect(items[1].payload).toEqual({ email: "b@x.com" });
  });
});

describe("getReferenceSummary", () => {
  it("reports never-synced groups as stale with zero counts", async () => {
    const summary = await refSync.getReferenceSummary({
      deps: { sql: makeFakeSql({ items: [], syncs: [] }), store: makeFakeStore(), env: ENV },
    });
    expect(summary.groups).toHaveLength(4);
    for (const g of summary.groups) {
      expect(g.stale).toBe(true);
      expect(g.lastSync).toBeNull();
      expect(g.kinds.every((k: { count: number }) => k.count === 0)).toBe(true);
    }
  });

  it("reports fresh ok syncs as not stale, old ones as stale", async () => {
    const state = { items: [] as Item[], syncs: [] as SyncRow[] };
    state.syncs.push({
      sync_group: "employees",
      status: "ok",
      item_count: 3,
      error_category: null,
      correlation_id: null,
      created_at: new Date().toISOString(),
    });
    state.syncs.push({
      sync_group: "calendars",
      status: "ok",
      item_count: 1,
      error_category: null,
      correlation_id: null,
      created_at: new Date(Date.now() - (refSync.STALE_AFTER_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString(),
    });
    const summary = await refSync.getReferenceSummary({
      deps: { sql: makeFakeSql(state), store: makeFakeStore(), env: ENV },
    });
    const byGroup = new Map(summary.groups.map((g: { group: string }) => [g.group, g]));
    expect((byGroup.get("employees") as { stale: boolean }).stale).toBe(false);
    expect((byGroup.get("calendars") as { stale: boolean }).stale).toBe(true);
    // a failed-last sync keeps honesty via lastSync.status; never-synced pay_items stale
    expect((byGroup.get("pay_items") as { stale: boolean }).stale).toBe(true);
  });
});
