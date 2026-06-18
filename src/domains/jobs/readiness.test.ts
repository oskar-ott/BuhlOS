import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRESTART_ITEMS,
  PrestartSchema,
  computeReadiness,
  defaultPrestartItems,
  readinessStateLabel,
  readinessStateTone,
  type CrewRegisterSignal,
  type PrestartManualItem,
  type ReadinessSignals,
} from "./readiness";

const CREW = [
  { id: "u1", name: "Dave" },
  { id: "u2", name: "Tom" },
];

const allClearRegister = (): CrewRegisterSignal => ({ byWorkerId: { u1: true, u2: true } });

function tickedItems(): PrestartManualItem[] {
  return defaultPrestartItems().map((i) => ({ ...i, ticked: true, tickedBy: "Boss", tickedAt: "2026-06-18" }));
}

function signals(over: Partial<ReadinessSignals> = {}): ReadinessSignals {
  return {
    crew: CREW,
    inductions: allClearRegister(),
    safetyDocs: allClearRegister(),
    licences: allClearRegister(),
    manualItems: tickedItems(),
    override: null,
    ...over,
  };
}

const itemByKey = (r: ReturnType<typeof computeReadiness>, key: string) => r.items.find((i) => i.key === key)!;

describe("computeReadiness (#371)", () => {
  it("everything satisfied → state 'yes', start approved, no override", () => {
    const r = computeReadiness(signals());
    expect(r.state).toBe("yes");
    expect(r.startApproved).toBe(true);
    expect(r.overridden).toBe(false);
    expect(r.blockingCount).toBe(0);
    expect(r.warningCount).toBe(0);
  });

  it("an assigned worker not inducted → state 'no', and names who is blocked", () => {
    const r = computeReadiness(signals({ inductions: { byWorkerId: { u1: true } } })); // Tom missing
    expect(r.state).toBe("no");
    expect(r.startApproved).toBe(false);
    const induction = itemByKey(r, "induction");
    expect(induction.status).toBe("missing");
    expect(induction.detail).toContain("Tom");
    expect(induction.workers).toEqual([
      { id: "u1", name: "Dave", ok: true },
      { id: "u2", name: "Tom", ok: false },
    ]);
  });

  it("an absent register renders 'not tracked' (never green) and only warns", () => {
    const r = computeReadiness(signals({ inductions: null, safetyDocs: null }));
    expect(itemByKey(r, "induction").status).toBe("not_tracked");
    expect(itemByKey(r, "safety_docs").status).toBe("not_tracked");
    expect(r.state).toBe("warnings"); // not-tracked is a warning, never a blocker, never green
    expect(r.warningCount).toBeGreaterThanOrEqual(2);
  });

  it("a licence gap is a soft WARNING (optional signal), not a hard blocker", () => {
    const r = computeReadiness(signals({ licences: { byWorkerId: { u1: true } } })); // Tom's licence not current
    expect(itemByKey(r, "licences").status).toBe("warning");
    expect(r.state).toBe("warnings");
    expect(r.blockingCount).toBe(0);
  });

  it("an unticked manual obligation is a hard blocker → 'no'", () => {
    const items = tickedItems();
    items[0] = { ...items[0]!, ticked: false, tickedBy: null, tickedAt: null };
    const r = computeReadiness(signals({ manualItems: items }));
    expect(r.state).toBe("no");
    expect(itemByKey(r, `manual:${items[0]!.id}`).status).toBe("missing");
  });

  it("a fresh job (default items unticked, no registers) is honestly 'no', never green", () => {
    const r = computeReadiness({
      crew: [],
      inductions: null,
      safetyDocs: null,
      licences: null,
      manualItems: defaultPrestartItems(),
      override: null,
    });
    expect(r.state).toBe("no"); // every default obligation outstanding
    expect(itemByKey(r, "induction").status).toBe("not_tracked"); // absent register, not green
  });

  it("a tracked register with NO crew assigned yet renders 'not tracked', never green", () => {
    const r = computeReadiness(signals({ crew: [], inductions: allClearRegister() }));
    expect(itemByKey(r, "induction").detail).toContain("No crew assigned");
    expect(itemByKey(r, "induction").status).toBe("not_tracked");
  });

  it("an admin override approves start but NEVER changes the honest state (not green)", () => {
    const items = tickedItems();
    items[0] = { ...items[0]!, ticked: false }; // still a blocker → state 'no'
    const r = computeReadiness(
      signals({ manualItems: items, override: { reason: "client signed waiver", by: "Boss", at: "2026-06-18" } }),
    );
    expect(r.state).toBe("no"); // honest computed state is untouched
    expect(r.overridden).toBe(true);
    expect(r.startApproved).toBe(true);
    expect(r.override?.reason).toBe("client signed waiver");
  });

  it("an override on an already-'yes' job is a no-op flag (nothing to override)", () => {
    const r = computeReadiness(signals({ override: { reason: "x", by: "Boss", at: "2026-06-18" } }));
    expect(r.state).toBe("yes");
    expect(r.overridden).toBe(false); // nothing to override
    expect(r.startApproved).toBe(true);
  });
});

describe("prestart schema + defaults (#371)", () => {
  it("defaults are the honest non-integrated obligations, all unticked", () => {
    const items = defaultPrestartItems();
    expect(items.map((i) => i.id)).toEqual(DEFAULT_PRESTART_ITEMS.map((d) => d.id));
    expect(items.every((i) => i.ticked === false)).toBe(true);
  });

  it("PrestartSchema accepts a stored blob and defaults items to []", () => {
    expect(PrestartSchema.parse({}).items).toEqual([]);
    const parsed = PrestartSchema.parse({
      items: [{ id: "insurances", label: "Insurances lodged", ticked: true, tickedBy: "Boss", tickedAt: "t" }],
      override: { reason: "r", by: "Boss", at: "t" },
    });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.override?.reason).toBe("r");
  });
});

describe("readiness presentation helpers", () => {
  it("labels + tones are honest per state", () => {
    expect(readinessStateLabel("no")).toContain("Not ready");
    expect(readinessStateLabel("warnings")).toContain("warnings");
    expect(readinessStateLabel("yes")).toContain("Ready to start");
    expect(readinessStateTone("no")).toBe("danger");
    expect(readinessStateTone("warnings")).toBe("warning");
    expect(readinessStateTone("yes")).toBe("success");
  });
});
