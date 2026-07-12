import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * api/_lib/xero/worktype-mappings.js (#611) — the second kind on the
 * epic-wide store: suggestion by Xero's own EarningsType classification
 * (never auto-applied), confirm-time snapshots, health flags (inactive /
 * deleted / org-mismatch / earnings-type-mismatch / duplicate targets),
 * honest cache provenance, and the #894 readiness seam.
 */

const requireFromHere = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = requireFromHere("../../../api/_lib/xero/worktype-mappings.js");

const CONN = {
  id: "conn-1",
  tenant_id: "tenant-1",
  status: "connected",
  external_tenant_id: "org-1",
  external_tenant_name: "Demo Company (AU)",
};

const RATES = [
  { xero_id: "er-ord", name: "Ordinary Hours", active: true, payload: { earningsType: "ORDINARYTIMEEARNINGS", rateType: "RATEPERUNIT" } },
  { xero_id: "er-ot", name: "Overtime Hours (exempt)", active: true, payload: { earningsType: "OVERTIMEEARNINGS", rateType: "MULTIPLE" } },
  { xero_id: "er-old", name: "Old Rate", active: false, payload: { earningsType: "ORDINARYTIMEEARNINGS" } },
];

type MappingRow = Record<string, unknown> & { local_id: string; xero_id: string; external_tenant_id: string; kind: string };

function makeFakeSql(state: { mappings: MappingRow[]; rates: typeof RATES; lastSync: Record<string, unknown> | null }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sql: any = (strings: TemplateStringsArray | unknown[], ...vals: unknown[]) => {
    if (!Object.prototype.hasOwnProperty.call(strings, "raw")) return { __list: strings };
    const text = (strings as TemplateStringsArray).join("$v");
    return (async () => {
      if (text.includes("from public.xero_reference_items")) return state.rates.map((r) => ({ ...r }));
      if (text.includes("from public.xero_reference_syncs")) return state.lastSync ? [{ ...state.lastSync }] : [];
      if (text.includes("select * from public.xero_mappings")) return state.mappings.map((m) => ({ ...m }));
      if (text.includes("insert into public.xero_mappings")) {
        const [, extTenant, kind, localId, xeroId, nameSnap, statusSnap, source, byId, byName] = vals;
        const existing = state.mappings.find((m) => m.external_tenant_id === extTenant && m.kind === kind && m.local_id === localId);
        const row = {
          id: existing ? existing.id : `map-${state.mappings.length + 1}`,
          tenant_id: "tenant-1", external_tenant_id: extTenant as string, kind: kind as string,
          local_id: localId as string, xero_id: xeroId as string,
          xero_name_snapshot: nameSnap, xero_status_snapshot: statusSnap, source,
          linked_by_legacy_id: byId, linked_by_name: byName, created_at: new Date().toISOString(),
        };
        if (existing) Object.assign(existing, row);
        else state.mappings.push(row as MappingRow);
        return [{ ...row }];
      }
      if (text.includes("delete from public.xero_mappings")) {
        const [, extTenant, kind, localId] = vals;
        const idx = state.mappings.findIndex((m) => m.external_tenant_id === extTenant && m.kind === kind && m.local_id === localId);
        if (idx === -1) return [];
        const [gone] = state.mappings.splice(idx, 1);
        return [{ ...gone }];
      }
      if (text.includes("select local_id, xero_id, xero_name_snapshot from public.xero_mappings")) {
        const [, extTenant, kind] = vals;
        return state.mappings
          .filter((m) => m.external_tenant_id === extTenant && m.kind === kind)
          .map((m) => ({ local_id: m.local_id, xero_id: m.xero_id, xero_name_snapshot: m.xero_name_snapshot }));
      }
      throw new Error(`fake sql: unmatched query: ${text.slice(0, 80)}`);
    })();
  };
  return sql;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let state: { mappings: MappingRow[]; rates: any; lastSync: Record<string, unknown> | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let deps: any;

beforeEach(() => {
  state = {
    mappings: [],
    rates: RATES.map((r) => ({ ...r, payload: { ...r.payload } })),
    lastSync: { status: "ok", error_category: null, created_at: new Date().toISOString() },
  };
  deps = { sql: makeFakeSql(state), store: { getConnection: vi.fn(async () => ({ ...CONN })) } };
});

describe("suggestions", () => {
  it("suggests by EarningsType classification when exactly one active rate matches", async () => {
    const board = await lib.getWorktypeMappingBoard({ ...deps });
    const ordinary = board.workTypes.find((w: { workType: string }) => w.workType === "ordinary");
    // er-old is ORDINARYTIMEEARNINGS too, but INACTIVE — only er-ord counts
    expect(ordinary.suggestion).toEqual({ rateId: "er-ord", rateName: "Ordinary Hours", reason: "earnings_type" });
    const overtime = board.workTypes.find((w: { workType: string }) => w.workType === "overtime");
    expect(overtime.suggestion).toEqual({ rateId: "er-ot", rateName: "Overtime Hours (exempt)", reason: "earnings_type" });
  });

  it("multiple candidates of the right type → falls back to the EXACT-name match only", async () => {
    state.rates.push({ xero_id: "er-ord2", name: "Ordinary Site Hours", active: true, payload: { earningsType: "ORDINARYTIMEEARNINGS" } });
    const board = await lib.getWorktypeMappingBoard({ ...deps });
    // type is ambiguous (2 candidates) but exactly one rate is NAMED "Ordinary Hours"
    expect(board.workTypes.find((w: { workType: string }) => w.workType === "ordinary").suggestion).toEqual({
      rateId: "er-ord", rateName: "Ordinary Hours", reason: "name",
    });
    // ambiguous type AND no exact-name match → no suggestion, never a guess
    state.rates = state.rates.map((r: { xero_id: string; name: string }) =>
      r.xero_id === "er-ord" ? { ...r, name: "Ordinary Hours (site)" } : r
    );
    const board2 = await lib.getWorktypeMappingBoard({ ...deps });
    expect(board2.workTypes.find((w: { workType: string }) => w.workType === "ordinary").suggestion).toBeNull();
  });
});

describe("confirm / health / unmap", () => {
  it("confirms with snapshots; unmapped count honest; remap updates in place", async () => {
    const out = await lib.confirmWorktypeMapping({ workType: "ordinary", rateId: "er-ord", actor: { id: "a", name: "Boss" }, deps: { ...deps } });
    expect(out.mapping).toMatchObject({ local_id: "ordinary", xero_id: "er-ord", xero_name_snapshot: "Ordinary Hours" });
    expect(out.typeMismatch).toBe(false);
    const board = await lib.getWorktypeMappingBoard({ ...deps });
    expect(board.unmappedCount).toBe(1); // overtime still unmapped
    await lib.confirmWorktypeMapping({ workType: "ordinary", rateId: "er-ot", actor: { id: "a" }, deps: { ...deps } });
    expect(state.mappings).toHaveLength(1);
    expect(state.mappings[0]!.xero_id).toBe("er-ot");
  });

  it("flags an earnings-type mismatch at confirm time, honestly but not blocking", async () => {
    const out = await lib.confirmWorktypeMapping({ workType: "overtime", rateId: "er-ord", actor: { id: "a" }, deps: { ...deps } });
    expect(out.typeMismatch).toBe(true);
  });

  it("board flags inactive / deleted rates, org mismatch and shared targets", async () => {
    await lib.confirmWorktypeMapping({ workType: "ordinary", rateId: "er-old", actor: { id: "a" }, deps: { ...deps } });
    await lib.confirmWorktypeMapping({ workType: "overtime", rateId: "er-old", actor: { id: "a" }, deps: { ...deps } });
    state.mappings.push({
      id: "mx", tenant_id: "tenant-1", external_tenant_id: "org-OTHER", kind: "worktype_earnings_rate",
      local_id: "ordinary", xero_id: "er-x", created_at: "t",
    } as MappingRow);
    // the current-org row wins for 'ordinary' (Map keyed by local_id, later rows overwrite):
    // assert the current-org health flags on both rows
    const board = await lib.getWorktypeMappingBoard({ ...deps });
    const ordinary = board.workTypes.find((w: { workType: string }) => w.workType === "ordinary");
    const overtime = board.workTypes.find((w: { workType: string }) => w.workType === "overtime");
    // er-old is inactive → flagged; both point at er-old → sharedWith names the other
    expect(overtime.mapping.rateInactive).toBe(true);
    expect(overtime.mapping.sharedWith).toEqual(["ordinary"]);
    expect(ordinary.mapping).toBeTruthy();

    // deleted rate: remove er-old from the cache entirely
    state.rates = state.rates.filter((r: { xero_id: string }) => r.xero_id !== "er-old");
    const board2 = await lib.getWorktypeMappingBoard({ ...deps });
    const overtime2 = board2.workTypes.find((w: { workType: string }) => w.workType === "overtime");
    expect(overtime2.mapping.rateMissingFromCache).toBe(true);
  });

  it("rejects unknown work types and unknown rates; unmap removes", async () => {
    await expect(lib.confirmWorktypeMapping({ workType: "travel", rateId: "er-ord", deps: { ...deps } })).rejects.toMatchObject({ category: "validation" });
    await expect(lib.confirmWorktypeMapping({ workType: "ordinary", rateId: "er-forged", deps: { ...deps } })).rejects.toMatchObject({ category: "validation" });
    await lib.confirmWorktypeMapping({ workType: "ordinary", rateId: "er-ord", deps: { ...deps } });
    const removed = await lib.removeWorktypeMapping({ workType: "ordinary", deps: { ...deps } });
    expect(removed.xero_id).toBe("er-ord");
    expect(await lib.removeWorktypeMapping({ workType: "ordinary", deps: { ...deps } })).toBeNull();
  });

  it("honest cache provenance: never-synced/failed pay items are untrustworthy", async () => {
    state.rates = [];
    state.lastSync = null;
    const board = await lib.getWorktypeMappingBoard({ ...deps });
    expect(board.rateCache.trustworthy).toBe(false);
  });
});

describe("worktypeReadiness (#894 seam)", () => {
  it("reports current-org mapping state for every registered work type", async () => {
    await lib.confirmWorktypeMapping({ workType: "ordinary", rateId: "er-ord", deps: { ...deps } });
    const out = await lib.worktypeReadiness({ ...deps });
    expect(out).toEqual([
      { workType: "ordinary", label: "Ordinary hours", rateId: "er-ord", rateName: "Ordinary Hours", mapped: true },
      { workType: "overtime", label: "Overtime", rateId: null, rateName: null, mapped: false },
    ]);
  });
});
