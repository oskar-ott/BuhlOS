import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * api/_lib/xero/worker-mappings.js (#248) — the mapping store + board against
 * a scripted in-memory postgres fake: roster rule (tracked + disabled-with-
 * links), board states (mapped / suggested / invalid-legacy / org-mismatch /
 * employee-drift), 1:1-both-directions with the conflict NAMED, remap,
 * confirm-time snapshots, terminated-employee confirm (allowed, flagged),
 * unlink, the #249 readiness seam, and honest cache provenance.
 */

const requireFromHere = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = requireFromHere("../../../api/_lib/xero/worker-mappings.js");

type MappingRow = Record<string, unknown> & { local_id: string; xero_id: string; external_tenant_id: string; kind: string };

const CONN = {
  id: "conn-1",
  tenant_id: "tenant-1",
  status: "connected",
  external_tenant_id: "org-1",
  external_tenant_name: "Demo Company (AU)",
};

const USERS = [
  { id: "w_karen", username: "Karen", name: "Karen Buhl", email: "karen@buhl.com", role: "electrician", assignedJobIds: [] },
  { id: "w_alex", username: "Alex Buhltest", name: "Alex Buhltest", email: null, role: "tradie", xeroEmployeeId: "stale-id", assignedJobIds: [] },
  { id: "w_old", username: "Old Mate", name: "Old Mate", email: null, role: "tradie", archived: true, xeroEmployeeId: "emp-old", assignedJobIds: [] },
  { id: "w_gone", username: "Long Gone", name: "Long Gone", email: null, role: "tradie", archived: true, assignedJobIds: [] },
  { id: "u_admin", username: "boss", name: "Boss", email: "boss@buhl.com", role: "boss", assignedJobIds: [] },
];

const EMPLOYEES = [
  { xero_id: "emp-karen", name: "Karen Buhl", active: true, payload: { email: "karen@buhl.com", status: "ACTIVE" } },
  { xero_id: "emp-alex", name: "Alex Buhltest", active: true, payload: { email: null, status: "ACTIVE" } },
  { xero_id: "emp-old", name: "Old Mate", active: false, payload: { email: null, status: "TERMINATED" } },
];

function makeFakeSql(state: { mappings: MappingRow[]; employees: typeof EMPLOYEES; lastSync: Record<string, unknown> | null }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sql: any = (strings: TemplateStringsArray | unknown[], ...vals: unknown[]) => {
    if (!Object.prototype.hasOwnProperty.call(strings, "raw")) return { __list: strings };
    const text = (strings as TemplateStringsArray).join("$v");
    return (async () => {
      if (text.includes("from public.xero_reference_items")) {
        return state.employees.map((e) => ({ ...e }));
      }
      if (text.includes("from public.xero_reference_syncs")) {
        return state.lastSync ? [{ ...state.lastSync }] : [];
      }
      if (text.includes("select * from public.xero_mappings")) {
        return state.mappings.map((m) => ({ ...m }));
      }
      if (text.includes("insert into public.xero_mappings")) {
        const [, extTenant, kind, localId, xeroId, nameSnap, statusSnap, source, byId, byName] = vals;
        const existing = state.mappings.find(
          (m) => m.external_tenant_id === extTenant && m.kind === kind && m.local_id === localId
        );
        const row = {
          id: existing ? existing.id : `map-${state.mappings.length + 1}`,
          tenant_id: "tenant-1",
          external_tenant_id: extTenant as string,
          kind: kind as string,
          local_id: localId as string,
          xero_id: xeroId as string,
          xero_name_snapshot: nameSnap,
          xero_status_snapshot: statusSnap,
          source,
          linked_by_legacy_id: byId,
          linked_by_name: byName,
          created_at: new Date().toISOString(),
        };
        if (existing) Object.assign(existing, row);
        else state.mappings.push(row as MappingRow);
        return [{ ...row }];
      }
      if (text.includes("delete from public.xero_mappings")) {
        const [, extTenant, kind, localId] = vals;
        const idx = state.mappings.findIndex(
          (m) => m.external_tenant_id === extTenant && m.kind === kind && m.local_id === localId
        );
        if (idx === -1) return [];
        const [gone] = state.mappings.splice(idx, 1);
        return [{ ...gone }];
      }
      if (text.includes("select local_id, xero_id from public.xero_mappings")) {
        const [, extTenant, kind] = vals;
        return state.mappings
          .filter((m) => m.external_tenant_id === extTenant && m.kind === kind)
          .map((m) => ({ local_id: m.local_id, xero_id: m.xero_id }));
      }
      throw new Error(`fake sql: unmatched query: ${text.slice(0, 90)}`);
    })();
  };
  return sql;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let state: { mappings: MappingRow[]; employees: any; lastSync: Record<string, unknown> | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let deps: any;

beforeEach(() => {
  state = {
    mappings: [],
    employees: EMPLOYEES.map((e) => ({ ...e, payload: { ...e.payload } })),
    lastSync: { status: "ok", item_count: 3, error_category: null, created_at: new Date().toISOString() },
  };
  deps = {
    sql: makeFakeSql(state),
    store: { getConnection: vi.fn(async () => ({ ...CONN })) },
    readBlob: vi.fn(async () => ({ users: JSON.parse(JSON.stringify(USERS)) })),
  };
});

describe("getWorkerMappingBoard", () => {
  it("lists tracked workers + disabled-with-links only; suggestions and invalid legacy ids visible", async () => {
    const board = await lib.getWorkerMappingBoard({ ...deps });
    const ids = board.workers.map((w: { workerId: string }) => w.workerId);
    expect(ids).toContain("w_karen");
    expect(ids).toContain("w_alex");
    expect(ids).toContain("w_old"); // disabled but carries a legacy id → visible, flagged
    expect(ids).not.toContain("w_gone"); // disabled, no link, no legacy id → not listed
    expect(ids).not.toContain("u_admin"); // office tier is not hours-tracked

    const karen = board.workers.find((w: { workerId: string }) => w.workerId === "w_karen");
    expect(karen.suggestion).toEqual({ employeeId: "emp-karen", employeeName: "Karen Buhl", reason: "email" });
    const alex = board.workers.find((w: { workerId: string }) => w.workerId === "w_alex");
    expect(alex.invalidLegacyId).toBe("stale-id");
    // name still suggests emp-alex despite the stale legacy id
    expect(alex.suggestion).toEqual({ employeeId: "emp-alex", employeeName: "Alex Buhltest", reason: "name" });
    const old = board.workers.find((w: { workerId: string }) => w.workerId === "w_old");
    expect(old.disabled).toBe(true);
    expect(board.unmappedCount).toBe(2); // karen + alex (disabled rows don't count)
  });

  it("flags org-mismatched links instead of hiding them, and employee drift", async () => {
    state.mappings.push({
      id: "m1", tenant_id: "tenant-1", external_tenant_id: "org-OTHER", kind: "worker_employee",
      local_id: "w_karen", xero_id: "emp-karen", xero_name_snapshot: "Karen Buhl",
      xero_status_snapshot: "ACTIVE", source: "manual", linked_by_name: "Boss",
      created_at: new Date().toISOString(),
    } as MappingRow);
    state.mappings.push({
      id: "m2", tenant_id: "tenant-1", external_tenant_id: "org-1", kind: "worker_employee",
      local_id: "w_alex", xero_id: "emp-vanished", xero_name_snapshot: "Vanished Person",
      xero_status_snapshot: "ACTIVE", source: "manual", linked_by_name: "Boss",
      created_at: new Date().toISOString(),
    } as MappingRow);
    const board = await lib.getWorkerMappingBoard({ ...deps });
    const karen = board.workers.find((w: { workerId: string }) => w.workerId === "w_karen");
    expect(karen.mapping.orgMismatch).toBe(true);
    const alex = board.workers.find((w: { workerId: string }) => w.workerId === "w_alex");
    expect(alex.mapping.orgMismatch).toBe(false);
    expect(alex.mapping.employeeMissingFromCache).toBe(true);
  });

  it("distinguishes empty-because-never-synced from a trustworthy zero", async () => {
    state.employees = [];
    state.lastSync = null;
    const board = await lib.getWorkerMappingBoard({ ...deps });
    expect(board.employeeCache.trustworthy).toBe(false);
    state.lastSync = { status: "failed", item_count: null, error_category: "rate_limit", created_at: "t" };
    const board2 = await lib.getWorkerMappingBoard({ ...deps });
    expect(board2.employeeCache.trustworthy).toBe(false);
    expect(board2.employeeCache.lastSync.errorCategory).toBe("rate_limit");
  });

  it("throws typed errors when not connected / pending", async () => {
    deps.store.getConnection.mockResolvedValueOnce(null);
    await expect(lib.getWorkerMappingBoard({ ...deps })).rejects.toMatchObject({ category: "not_connected" });
    deps.store.getConnection.mockResolvedValueOnce({ ...CONN, external_tenant_id: null });
    await expect(lib.getWorkerMappingBoard({ ...deps })).rejects.toMatchObject({ category: "pending_selection" });
  });
});

describe("confirmMapping / removeMapping", () => {
  it("confirms with name+status snapshots; remap records the previous employee", async () => {
    const first = await lib.confirmMapping({
      workerId: "w_karen", employeeId: "emp-karen", source: "email_suggestion",
      actor: { id: "u_admin", name: "Boss" }, deps: { ...deps },
    });
    expect(first.mapping).toMatchObject({
      local_id: "w_karen", xero_id: "emp-karen",
      xero_name_snapshot: "Karen Buhl", xero_status_snapshot: "ACTIVE", source: "email_suggestion",
    });
    expect(first.previousEmployeeId).toBeNull();

    const remap = await lib.confirmMapping({
      workerId: "w_karen", employeeId: "emp-alex", source: "manual",
      actor: { id: "u_admin", name: "Boss" }, deps: { ...deps },
    });
    expect(remap.previousEmployeeId).toBe("emp-karen");
    expect(state.mappings).toHaveLength(1);
    expect(state.mappings[0]!.xero_id).toBe("emp-alex");
  });

  it("1:1 both directions — the conflicting holder is NAMED", async () => {
    await lib.confirmMapping({ workerId: "w_karen", employeeId: "emp-karen", actor: { id: "a" }, deps: { ...deps } });
    await expect(
      lib.confirmMapping({ workerId: "w_alex", employeeId: "emp-karen", actor: { id: "a" }, deps: { ...deps } })
    ).rejects.toMatchObject({
      category: "conflict",
      conflictWith: { workerId: "w_karen", workerName: "Karen Buhl" },
    });
    expect(state.mappings).toHaveLength(1);
  });

  it("terminated employee can still be confirmed (final pay) but is flagged", async () => {
    const out = await lib.confirmMapping({
      workerId: "w_old", employeeId: "emp-old", actor: { id: "a" }, deps: { ...deps },
    });
    expect(out.employeeInactive).toBe(true);
    expect(out.mapping.xero_status_snapshot).toBe("TERMINATED");
  });

  it("rejects unknown worker / employee ids", async () => {
    await expect(
      lib.confirmMapping({ workerId: "w_nobody", employeeId: "emp-karen", deps: { ...deps } })
    ).rejects.toMatchObject({ category: "validation" });
    await expect(
      lib.confirmMapping({ workerId: "w_karen", employeeId: "emp-forged", deps: { ...deps } })
    ).rejects.toMatchObject({ category: "validation" });
  });

  it("unlink removes the row; unlinking nothing returns null", async () => {
    await lib.confirmMapping({ workerId: "w_karen", employeeId: "emp-karen", actor: { id: "a" }, deps: { ...deps } });
    const removed = await lib.removeMapping({ workerId: "w_karen", deps: { ...deps } });
    expect(removed.xero_id).toBe("emp-karen");
    expect(state.mappings).toHaveLength(0);
    expect(await lib.removeMapping({ workerId: "w_karen", deps: { ...deps } })).toBeNull();
  });
});

describe("mappingReadiness (#249 seam)", () => {
  it("names mapped and unmapped workers for the current org only", async () => {
    await lib.confirmMapping({ workerId: "w_karen", employeeId: "emp-karen", actor: { id: "a" }, deps: { ...deps } });
    state.mappings.push({
      id: "mx", tenant_id: "tenant-1", external_tenant_id: "org-OTHER", kind: "worker_employee",
      local_id: "w_alex", xero_id: "emp-alex", created_at: "t",
    } as MappingRow);
    const out = await lib.mappingReadiness(["w_karen", "w_alex"], { ...deps });
    expect(out).toEqual([
      { workerId: "w_karen", employeeId: "emp-karen", mapped: true },
      { workerId: "w_alex", employeeId: null, mapped: false }, // other-org link does NOT count
    ]);
  });
});
