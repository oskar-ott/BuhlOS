import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CreateGearAssetPayloadSchema,
  GearAssetSchema,
  GearDetailResponseSchema,
  GearHistoryEntrySchema,
  GearListResponseSchema,
  GearMutationResponseSchema,
  GEAR_ASSET_CONDITIONS,
  GEAR_ASSET_STATUSES,
  GEAR_ASSET_TYPES,
  GEAR_HISTORY_KINDS,
  REPORT_KINDS,
  ReportGearPayloadSchema,
  TransferGearPayloadSchema,
} from "./schema";
import {
  applyReportCondition,
  assignmentsFromHistory,
  buildReturnToDepotPayload,
  canTransition,
  canWorkerActOnAsset,
  deriveStatus,
  historyKindForReport,
  statusTone,
} from "./service";
import {
  assetDisplayName,
  conditionLabel,
  formatShortDate,
  formatTimestamp,
  historyKindLabel,
  isOverdue,
  statusLabel,
  typeLabel,
} from "./format";
import {
  createGearAsset,
  getGearDetail,
  listGear,
  reportGear,
  transferGear,
} from "./client";
import type { GearAsset, GearHistoryEntry } from "./types";

/* ----------------------------------------------------------------------
 * Schema fixtures
 * -------------------------------------------------------------------- */

const baseAsset: GearAsset = {
  id: "a_abc123",
  name: "Makita drill",
  type: "tool",
  identifier: "MK-001",
  notes: null,
  currentHolderId: null,
  currentHolderName: null,
  assignedAt: null,
  expectedReturn: null,
  archived: false,
  createdAt: "2026-05-01T08:00:00Z",
  updatedAt: "2026-05-01T08:00:00Z",
  createdBy: "u_admin",
};

/* ----------------------------------------------------------------------
 * Status derivation — single source of truth for "what does the pill say?"
 * -------------------------------------------------------------------- */

describe("deriveStatus()", () => {
  it("returns 'available' for an unheld, non-archived, good-condition asset", () => {
    expect(deriveStatus(baseAsset)).toBe("available");
  });

  it("returns 'assigned' when a worker holds it", () => {
    expect(deriveStatus({ ...baseAsset, currentHolderId: "u_sam" })).toBe("assigned");
  });

  it("returns 'damaged' when condition is damaged (even with no holder)", () => {
    expect(deriveStatus({ ...baseAsset, condition: "damaged" })).toBe("damaged");
    expect(deriveStatus({ ...baseAsset, currentHolderId: "u_sam", condition: "damaged" })).toBe(
      "damaged"
    );
  });

  it("returns 'missing' when condition is missing", () => {
    expect(deriveStatus({ ...baseAsset, condition: "missing", currentHolderId: "u_sam" })).toBe(
      "missing"
    );
  });

  it("returns 'retired' when archived (precedence over condition + holder)", () => {
    expect(deriveStatus({ ...baseAsset, archived: true })).toBe("retired");
    expect(
      deriveStatus({ ...baseAsset, archived: true, condition: "damaged", currentHolderId: "u_sam" })
    ).toBe("retired");
  });

  it("treats absent condition as 'good' (legacy rows without the field)", () => {
    const legacy: GearAsset = { ...baseAsset, currentHolderId: "u_sam" };
    expect("condition" in legacy ? legacy.condition : undefined).toBeUndefined();
    expect(deriveStatus(legacy)).toBe("assigned");
  });
});

describe("canTransition()", () => {
  it("rejects same-state self-transition", () => {
    expect(canTransition("available", "available")).toBe(false);
    expect(canTransition("assigned", "assigned")).toBe(false);
  });

  it("treats retired as terminal", () => {
    expect(canTransition("retired", "available")).toBe(false);
    expect(canTransition("retired", "assigned")).toBe(false);
    expect(canTransition("retired", "damaged")).toBe(false);
  });

  it("allows available → assigned | damaged | missing | retired", () => {
    expect(canTransition("available", "assigned")).toBe(true);
    expect(canTransition("available", "damaged")).toBe(true);
    expect(canTransition("available", "missing")).toBe(true);
    expect(canTransition("available", "retired")).toBe(true);
  });

  it("allows assigned → available (return) | damaged | missing | retired", () => {
    expect(canTransition("assigned", "available")).toBe(true);
    expect(canTransition("assigned", "damaged")).toBe(true);
    expect(canTransition("assigned", "missing")).toBe(true);
    expect(canTransition("assigned", "retired")).toBe(true);
  });

  it("allows damaged → available (repaired) | retired only", () => {
    expect(canTransition("damaged", "available")).toBe(true);
    expect(canTransition("damaged", "retired")).toBe(true);
    expect(canTransition("damaged", "assigned")).toBe(false);
    expect(canTransition("damaged", "missing")).toBe(false);
  });

  it("allows missing → available (recovered) | retired only", () => {
    expect(canTransition("missing", "available")).toBe(true);
    expect(canTransition("missing", "retired")).toBe(true);
    expect(canTransition("missing", "assigned")).toBe(false);
    expect(canTransition("missing", "damaged")).toBe(false);
  });
});

/* ----------------------------------------------------------------------
 * Visibility / permission helpers
 * -------------------------------------------------------------------- */

describe("canWorkerActOnAsset()", () => {
  it("admin can act on anything", () => {
    expect(canWorkerActOnAsset(baseAsset, "u_admin", "admin")).toBe(true);
    expect(canWorkerActOnAsset({ ...baseAsset, currentHolderId: "u_sam" }, "u_admin", "admin")).toBe(
      true
    );
  });

  it("worker can act on assets they hold", () => {
    expect(
      canWorkerActOnAsset({ ...baseAsset, currentHolderId: "u_sam" }, "u_sam", "tradie")
    ).toBe(true);
    expect(
      canWorkerActOnAsset({ ...baseAsset, currentHolderId: "u_sam" }, "u_sam", "leadingHand")
    ).toBe(true);
  });

  it("worker cannot act on assets held by someone else", () => {
    expect(
      canWorkerActOnAsset({ ...baseAsset, currentHolderId: "u_sam" }, "u_jess", "tradie")
    ).toBe(false);
  });

  it("worker cannot act on assets in storage (unheld)", () => {
    expect(canWorkerActOnAsset(baseAsset, "u_sam", "tradie")).toBe(false);
  });
});

/* ----------------------------------------------------------------------
 * Payload builders + report mapping
 * -------------------------------------------------------------------- */

describe("buildReturnToDepotPayload()", () => {
  it("builds a transfer-to-null payload with the depot note", () => {
    const payload = buildReturnToDepotPayload({ id: "a_abc" });
    expect(payload.assetId).toBe("a_abc");
    expect(payload.toUserId).toBeNull();
    expect(payload.expectedReturn).toBeNull();
    expect(payload.note).toMatch(/depot/i);
  });

  it("the payload validates against TransferGearPayloadSchema", () => {
    const payload = buildReturnToDepotPayload({ id: "a_abc" });
    expect(TransferGearPayloadSchema.safeParse(payload).success).toBe(true);
  });
});

describe("historyKindForReport()", () => {
  it("maps each report kind onto the persisted history kind", () => {
    expect(historyKindForReport("check")).toBe("check");
    expect(historyKindForReport("damaged")).toBe("report_damaged");
    expect(historyKindForReport("missing")).toBe("report_missing");
  });
});

describe("applyReportCondition()", () => {
  it("damaged / missing override the current condition", () => {
    expect(applyReportCondition("good", "damaged")).toBe("damaged");
    expect(applyReportCondition("good", "missing")).toBe("missing");
    expect(applyReportCondition("damaged", "missing")).toBe("missing");
  });

  it("check does not change condition (defaults absent → good)", () => {
    expect(applyReportCondition("damaged", "check")).toBe("damaged");
    expect(applyReportCondition("good", "check")).toBe("good");
    expect(applyReportCondition(undefined, "check")).toBe("good");
  });
});

/* ----------------------------------------------------------------------
 * Assignment slice derivation
 * -------------------------------------------------------------------- */

describe("assignmentsFromHistory()", () => {
  const transfer = (
    over: Partial<GearHistoryEntry> & { id: string; at: string }
  ): GearHistoryEntry => ({
    kind: "transfer",
    from: null,
    to: null,
    ...over,
  });

  it("yields nothing for an empty history", () => {
    expect(assignmentsFromHistory([])).toEqual([]);
  });

  it("opens an assignment on storage → worker and closes on worker → storage", () => {
    const history: GearHistoryEntry[] = [
      transfer({
        id: "h1",
        at: "2026-05-01T08:00:00Z",
        from: null,
        to: "u_sam",
        toName: "Sam",
        byUserId: "u_admin",
        byName: "Admin",
      }),
      transfer({
        id: "h2",
        at: "2026-05-04T17:00:00Z",
        from: "u_sam",
        to: null,
        fromName: "Sam",
        byUserId: "u_sam",
        byName: "Sam",
        note: "Returned to depot",
      }),
    ];
    const slices = assignmentsFromHistory(history);
    expect(slices).toHaveLength(1);
    expect(slices[0]?.workerId).toBe("u_sam");
    expect(slices[0]?.startedAt).toBe("2026-05-01T08:00:00Z");
    expect(slices[0]?.endedAt).toBe("2026-05-04T17:00:00Z");
    expect(slices[0]?.assignedByName).toBe("Admin");
    expect(slices[0]?.endNote).toBe("Returned to depot");
  });

  it("keeps the open assignment last when never returned", () => {
    const history: GearHistoryEntry[] = [
      transfer({
        id: "h1",
        at: "2026-05-01T08:00:00Z",
        from: null,
        to: "u_sam",
        toName: "Sam",
      }),
    ];
    const slices = assignmentsFromHistory(history);
    expect(slices).toHaveLength(1);
    expect(slices[0]?.endedAt).toBeNull();
  });

  it("ignores non-transfer history kinds (checks, damage reports) when slicing", () => {
    const history: GearHistoryEntry[] = [
      transfer({
        id: "h1",
        at: "2026-05-01T08:00:00Z",
        from: null,
        to: "u_sam",
        toName: "Sam",
      }),
      { id: "h2", kind: "check", at: "2026-05-02T08:00:00Z", byUserId: "u_sam" },
      { id: "h3", kind: "report_damaged", at: "2026-05-03T08:00:00Z", byUserId: "u_sam", condition: "damaged" },
      transfer({
        id: "h4",
        at: "2026-05-04T08:00:00Z",
        from: "u_sam",
        to: null,
      }),
    ];
    const slices = assignmentsFromHistory(history);
    expect(slices).toHaveLength(1);
    expect(slices[0]?.endedAt).toBe("2026-05-04T08:00:00Z");
  });

  it("handles worker → worker handoff as one close + one open", () => {
    const history: GearHistoryEntry[] = [
      transfer({
        id: "h1",
        at: "2026-05-01T08:00:00Z",
        from: null,
        to: "u_sam",
        toName: "Sam",
      }),
      transfer({
        id: "h2",
        at: "2026-05-02T08:00:00Z",
        from: "u_sam",
        to: "u_jess",
        fromName: "Sam",
        toName: "Jess",
      }),
      transfer({
        id: "h3",
        at: "2026-05-03T08:00:00Z",
        from: "u_jess",
        to: null,
        fromName: "Jess",
      }),
    ];
    const slices = assignmentsFromHistory(history);
    expect(slices).toHaveLength(2);
    // Newest first per UI convention
    expect(slices[0]?.workerId).toBe("u_jess");
    expect(slices[1]?.workerId).toBe("u_sam");
  });
});

/* ----------------------------------------------------------------------
 * Display + formatting
 * -------------------------------------------------------------------- */

describe("formatting helpers", () => {
  it("typeLabel renders every legacy type label", () => {
    expect(typeLabel("vehicle")).toBe("Vehicle");
    expect(typeLabel("key")).toBe("Key");
    expect(typeLabel("tool")).toBe("Tool");
    expect(typeLabel("accessory")).toBe("Accessory");
    expect(typeLabel("ppe")).toBe("PPE");
    expect(typeLabel("other")).toBe("Other");
  });

  it("statusLabel covers every derived status", () => {
    expect(statusLabel("available")).toBe("Available");
    expect(statusLabel("assigned")).toBe("Assigned");
    expect(statusLabel("damaged")).toBe("Damaged");
    expect(statusLabel("missing")).toBe("Missing");
    expect(statusLabel("retired")).toBe("Retired");
  });

  it("conditionLabel handles undefined as 'Good' (legacy default)", () => {
    expect(conditionLabel(undefined)).toBe("Good");
    expect(conditionLabel("good")).toBe("Good");
    expect(conditionLabel("damaged")).toBe("Damaged");
    expect(conditionLabel("missing")).toBe("Missing");
  });

  it("historyKindLabel covers every kind + falls back to 'Transferred' for legacy rows", () => {
    expect(historyKindLabel("transfer")).toBe("Transferred");
    expect(historyKindLabel("check")).toBe("Checked");
    expect(historyKindLabel("report_damaged")).toBe("Reported damaged");
    expect(historyKindLabel("report_missing")).toBe("Reported missing");
    expect(historyKindLabel("admin_updated")).toBe("Admin updated");
    expect(historyKindLabel(undefined)).toBe("Transferred");
  });

  it("statusTone maps every status to the correct Pill tone", () => {
    expect(statusTone("available")).toBe("success");
    expect(statusTone("assigned")).toBe("info");
    expect(statusTone("damaged")).toBe("danger");
    expect(statusTone("missing")).toBe("warning");
    expect(statusTone("retired")).toBe("neutral");
  });

  it("assetDisplayName combines name + identifier", () => {
    expect(assetDisplayName({ name: "Makita drill", identifier: "MK-001" })).toBe(
      "Makita drill · MK-001"
    );
  });

  it("assetDisplayName falls back to bare name when no identifier", () => {
    expect(assetDisplayName({ name: "Makita drill", identifier: null })).toBe("Makita drill");
    expect(assetDisplayName({ name: "Makita drill" })).toBe("Makita drill");
  });

  it("formatTimestamp returns null on null / unparseable / undefined", () => {
    expect(formatTimestamp(null)).toBeNull();
    expect(formatTimestamp(undefined)).toBeNull();
    expect(formatTimestamp("not a date")).toBeNull();
  });

  it("formatTimestamp renders a valid ISO as a short en-AU label", () => {
    const out = formatTimestamp("2026-05-04T08:32:00Z");
    expect(out).not.toBeNull();
    expect(out).toMatch(/May/);
  });

  it("formatShortDate renders a valid YYYY-MM-DD as Mon 4 May", () => {
    const out = formatShortDate("2026-05-04");
    expect(out).not.toBeNull();
    expect(out).toMatch(/Mon/);
  });

  it("formatShortDate returns null on bad input", () => {
    expect(formatShortDate("not a date")).toBeNull();
    expect(formatShortDate(null)).toBeNull();
    expect(formatShortDate(undefined)).toBeNull();
  });

  it("isOverdue is true only when held and expected return is in the past", () => {
    const today = "2026-05-15";
    expect(isOverdue({ currentHolderId: "u_sam", expectedReturn: "2026-05-10" }, today)).toBe(true);
    expect(isOverdue({ currentHolderId: "u_sam", expectedReturn: "2026-05-20" }, today)).toBe(false);
    expect(isOverdue({ currentHolderId: null, expectedReturn: "2026-05-10" }, today)).toBe(false);
    expect(isOverdue({ currentHolderId: "u_sam", expectedReturn: null }, today)).toBe(false);
  });
});

/* ----------------------------------------------------------------------
 * Schema validation
 * -------------------------------------------------------------------- */

describe("CreateGearAssetPayloadSchema", () => {
  it("accepts a minimal valid asset", () => {
    const r = CreateGearAssetPayloadSchema.safeParse({ name: "Makita drill", type: "tool" });
    expect(r.success).toBe(true);
  });

  it("rejects missing name", () => {
    expect(CreateGearAssetPayloadSchema.safeParse({ name: "", type: "tool" }).success).toBe(false);
    expect(
      CreateGearAssetPayloadSchema.safeParse({ name: "   ", type: "tool" }).success
    ).toBe(false);
  });

  it("rejects unknown type", () => {
    const r = CreateGearAssetPayloadSchema.safeParse({ name: "x", type: "spaceship" });
    expect(r.success).toBe(false);
  });

  it("rejects badly-formed expectedReturn", () => {
    expect(
      CreateGearAssetPayloadSchema.safeParse({
        name: "x",
        type: "tool",
        expectedReturn: "next week",
      }).success
    ).toBe(false);
  });

  it("accepts a null expectedReturn (open-ended assignment)", () => {
    expect(
      CreateGearAssetPayloadSchema.safeParse({
        name: "x",
        type: "tool",
        expectedReturn: null,
      }).success
    ).toBe(true);
  });
});

describe("TransferGearPayloadSchema", () => {
  it("accepts a transfer to a worker", () => {
    expect(
      TransferGearPayloadSchema.safeParse({ assetId: "a", toUserId: "u_sam" }).success
    ).toBe(true);
  });

  it("accepts a return to depot (toUserId=null)", () => {
    expect(TransferGearPayloadSchema.safeParse({ assetId: "a", toUserId: null }).success).toBe(
      true
    );
  });

  it("rejects an empty assetId", () => {
    expect(TransferGearPayloadSchema.safeParse({ assetId: "", toUserId: "u" }).success).toBe(
      false
    );
  });
});

describe("ReportGearPayloadSchema", () => {
  it("accepts each valid kind", () => {
    for (const kind of REPORT_KINDS) {
      const r = ReportGearPayloadSchema.safeParse({ assetId: "a", kind });
      expect(r.success).toBe(true);
    }
  });

  it("rejects an unknown kind", () => {
    expect(
      ReportGearPayloadSchema.safeParse({ assetId: "a", kind: "exploded" }).success
    ).toBe(false);
  });

  it("rejects notes longer than 500 chars", () => {
    expect(
      ReportGearPayloadSchema.safeParse({
        assetId: "a",
        kind: "damaged",
        note: "x".repeat(501),
      }).success
    ).toBe(false);
  });
});

describe("enum surface area", () => {
  it("status enum covers the audit-spec set", () => {
    expect([...GEAR_ASSET_STATUSES].sort()).toEqual(
      ["assigned", "available", "damaged", "missing", "retired"].sort()
    );
  });

  it("type enum matches the legacy api/assets.js VALID_TYPES list", () => {
    expect([...GEAR_ASSET_TYPES].sort()).toEqual(
      ["accessory", "key", "other", "ppe", "tool", "vehicle"].sort()
    );
  });

  it("condition enum covers the persisted set", () => {
    expect([...GEAR_ASSET_CONDITIONS].sort()).toEqual(["damaged", "good", "missing"].sort());
  });

  it("history kind enum discriminates transfers from reports", () => {
    expect([...GEAR_HISTORY_KINDS].sort()).toEqual(
      ["admin_updated", "check", "report_damaged", "report_missing", "transfer"].sort()
    );
  });
});

describe("response schemas", () => {
  it("parses an asset list response", () => {
    const body = { assets: [baseAsset] };
    expect(GearListResponseSchema.safeParse(body).success).toBe(true);
  });

  it("parses an asset detail response with mixed history kinds", () => {
    const body = {
      asset: baseAsset,
      history: [
        { id: "h1", kind: "transfer", from: null, to: "u_sam", at: "2026-05-01T08:00:00Z" },
        { id: "h2", kind: "check", at: "2026-05-02T08:00:00Z", byUserId: "u_sam" },
        { id: "h3", at: "2026-05-03T08:00:00Z", byUserId: "u_sam" }, // legacy kindless row
      ],
    };
    expect(GearDetailResponseSchema.safeParse(body).success).toBe(true);
  });

  it("parses a mutation response", () => {
    const body = { asset: { ...baseAsset, condition: "damaged" } };
    expect(GearMutationResponseSchema.safeParse(body).success).toBe(true);
  });

  it("rejects a list response missing the assets key", () => {
    expect(GearListResponseSchema.safeParse({ entries: [] }).success).toBe(false);
  });
});

describe("GearAssetSchema accepts legacy hired-gear fields", () => {
  it("parses an asset with ownership='hired' and hire fields", () => {
    const hired = {
      ...baseAsset,
      ownership: "hired" as const,
      hireSupplier: "Kennards",
      hireEndDate: "2026-06-01",
      hireRateExGst: 95.5,
    };
    expect(GearAssetSchema.safeParse(hired).success).toBe(true);
  });
});

describe("GearHistoryEntrySchema is lenient about legacy shape", () => {
  it("accepts a legacy transfer row with no kind", () => {
    const legacy = {
      id: "h_legacy",
      from: null,
      to: "u_sam",
      at: "2025-12-15T08:00:00Z",
      byUserId: "u_admin",
      byName: "Admin",
    };
    expect(GearHistoryEntrySchema.safeParse(legacy).success).toBe(true);
  });
});

/* ----------------------------------------------------------------------
 * Client wrappers — happy / error paths, never throws
 * -------------------------------------------------------------------- */

describe("gear client wrappers", () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.clearAllMocks();
  });

  function mockFetch(response: { status: number; body: unknown }) {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { "content-type": "application/json" },
      });
    });
  }

  it("listGear returns parsed assets on success", async () => {
    mockFetch({ status: 200, body: { assets: [baseAsset] } });
    const r = await listGear();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.assets).toHaveLength(1);
  });

  it("listGear({includeArchived:true}) sends archived=1", async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ assets: [] })));
    globalThis.fetch = spy as unknown as typeof fetch;
    await listGear({ includeArchived: true });
    const call = spy.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(call[0]).toContain("archived=1");
  });

  it("getGearDetail returns parsed asset + history on success", async () => {
    mockFetch({
      status: 200,
      body: {
        asset: { ...baseAsset, currentHolderId: "u_sam" },
        history: [{ id: "h1", kind: "transfer", from: null, to: "u_sam", at: "2026-05-01T08:00:00Z" }],
      },
    });
    const r = await getGearDetail("a_abc");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.history).toHaveLength(1);
  });

  it("createGearAsset refuses to call the server with an invalid payload", async () => {
    const sentinel = vi.fn();
    globalThis.fetch = sentinel as unknown as typeof fetch;
    const r = await createGearAsset({ name: "", type: "tool" });
    expect(r.ok).toBe(false);
    expect(sentinel).not.toHaveBeenCalled();
  });

  it("createGearAsset returns the new asset on 201", async () => {
    mockFetch({ status: 201, body: { asset: baseAsset } });
    const r = await createGearAsset({ name: "Makita drill", type: "tool" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.asset.id).toBe(baseAsset.id);
  });

  it("transferGear returns ok:false on 403 (worker tries to transfer not-held)", async () => {
    mockFetch({
      status: 403,
      body: { error: "you can only transfer an asset you currently hold" },
    });
    const r = await transferGear({ assetId: "a_abc", toUserId: "u_jess" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.status).toBe(403);
  });

  it("transferGear sends ?action=transfer", async () => {
    const spy = vi.fn(
      async () =>
        new Response(JSON.stringify({ asset: { ...baseAsset, currentHolderId: "u_sam" } }))
    );
    globalThis.fetch = spy as unknown as typeof fetch;
    await transferGear({ assetId: "a_abc", toUserId: "u_sam" });
    const call = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toContain("action=transfer");
    expect(call[1]?.method).toBe("POST");
  });

  it("reportGear sends ?action=report and the kind in the body", async () => {
    const spy = vi.fn(
      async () =>
        new Response(JSON.stringify({ asset: { ...baseAsset, condition: "damaged" } }))
    );
    globalThis.fetch = spy as unknown as typeof fetch;
    await reportGear({ assetId: "a_abc", kind: "damaged", note: "Battery cracked" });
    const call = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toContain("action=report");
    const body = JSON.parse(call[1]?.body as string);
    expect(body.kind).toBe("damaged");
    expect(body.assetId).toBe("a_abc");
    expect(body.note).toBe("Battery cracked");
  });

  it("reportGear refuses invalid kinds without hitting the network", async () => {
    const sentinel = vi.fn();
    globalThis.fetch = sentinel as unknown as typeof fetch;
    const r = await reportGear({
      assetId: "a_abc",
      // @ts-expect-error — verifying runtime guard
      kind: "exploded",
    });
    expect(r.ok).toBe(false);
    expect(sentinel).not.toHaveBeenCalled();
  });

  it("reportGear returns the updated asset with the new condition on success", async () => {
    mockFetch({
      status: 200,
      body: { asset: { ...baseAsset, currentHolderId: "u_sam", condition: "damaged" } },
    });
    const r = await reportGear({ assetId: "a_abc", kind: "damaged" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.asset.condition).toBe("damaged");
      expect(deriveStatus(r.data.asset)).toBe("damaged");
    }
  });
});
