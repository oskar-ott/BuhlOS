import { describe, expect, it } from "vitest";
import type { ExceptionItem, ExceptionSeverity } from "@/domains/exceptions/types";
import { buildBoard, heatFor, type BoardSignals, type OpenWorkInput } from "./board";

function ex(id: string, severity: ExceptionSeverity): ExceptionItem {
  return {
    id,
    source: "snag",
    sourceId: id,
    title: `Exception ${id}`,
    severity,
    actionState: "available",
  };
}

const NO_PULSE = {
  crewOnSite: null,
  rosterTotal: null,
  loggedHoursLabel: null,
  pendingApprovals: 0,
  jobsLiveToday: null,
} satisfies Omit<BoardSignals, "exceptions" | "openWork">;

function signals(over: Partial<BoardSignals>): BoardSignals {
  return { ...NO_PULSE, exceptions: [], openWork: [], ...over };
}

const work = (key: string, count: number): OpenWorkInput => ({
  key,
  label: key,
  count,
  href: `/${key}`,
});

describe("heatFor", () => {
  it("grades on the brief's thresholds (red ≥8, amber ≥4, calm below)", () => {
    expect(heatFor(0)).toBe("calm");
    expect(heatFor(3)).toBe("calm");
    expect(heatFor(4)).toBe("amber");
    expect(heatFor(7)).toBe("amber");
    expect(heatFor(8)).toBe("red");
    expect(heatFor(99)).toBe("red");
  });
});

describe("buildBoard — hero", () => {
  it("is critical when any actionable item is critical", () => {
    const vm = buildBoard(signals({ exceptions: [ex("a", "critical"), ex("b", "warning")] }));
    expect(vm.hero.tone).toBe("critical");
    expect(vm.hero.tag).toBe("CRITICAL");
    expect(vm.hero.headline).toBe("1 decision is holding crews up right now.");
  });

  it("pluralises the critical headline", () => {
    const vm = buildBoard(signals({ exceptions: [ex("a", "critical"), ex("b", "critical")] }));
    expect(vm.hero.headline).toBe("2 decisions are holding crews up right now.");
  });

  it("is busy (not critical) when only warnings or open work exist", () => {
    const warnOnly = buildBoard(signals({ exceptions: [ex("a", "warning")] }));
    expect(warnOnly.hero.tone).toBe("busy");
    expect(warnOnly.hero.headline).toBe("1 item needs action — nothing critical.");

    const workOnly = buildBoard(signals({ openWork: [work("snags", 3)] }));
    expect(workOnly.hero.tone).toBe("busy");
    expect(workOnly.hero.headline).toContain("3 open items across the loops");
  });

  it("is calm when nothing is actionable and no open work (info doesn't count)", () => {
    const vm = buildBoard(signals({ exceptions: [ex("a", "info")] }));
    expect(vm.hero.tone).toBe("calm");
    expect(vm.hero.tag).toBe("CALM");
  });
});

describe("buildBoard — needsNow", () => {
  it("drops info, sorts critical→warning, exposes all actionable + the cap", () => {
    const vm = buildBoard(
      signals({
        exceptions: [
          ex("w1", "warning"),
          ex("i1", "info"),
          ex("c1", "critical"),
          ex("w2", "warning"),
          ex("c2", "critical"),
          ex("w3", "warning"),
        ],
      }),
    );
    // 5 actionable (2 critical + 3 warning); info excluded.
    expect(vm.needsNow.total).toBe(5);
    expect(vm.needsNow.items).toHaveLength(5);
    expect(vm.needsNow.cap).toBe(4);
    // criticals first; no info anywhere.
    expect(vm.needsNow.items.slice(0, 2).map((e) => e.severity)).toEqual([
      "critical",
      "critical",
    ]);
    expect(vm.needsNow.items.some((e) => e.severity === "info")).toBe(false);
  });

  it("exposes a single actionable item under the cap", () => {
    const vm = buildBoard(signals({ exceptions: [ex("c1", "critical")] }));
    expect(vm.needsNow.total).toBe(1);
    expect(vm.needsNow.items).toHaveLength(1);
  });
});

describe("buildBoard — openWork", () => {
  it("keeps only count>0, sorts busiest first, grades + totals", () => {
    const vm = buildBoard(
      signals({
        openWork: [work("a", 0), work("b", 5), work("c", 12), work("d", 2)],
      }),
    );
    expect(vm.openWork.tiles.map((t) => t.key)).toEqual(["c", "b", "d"]); // 12, 5, 2
    expect(vm.openWork.tiles.map((t) => t.heat)).toEqual(["red", "amber", "calm"]);
    expect(vm.openWork.total).toBe(19); // includes the zero bucket's 0
  });

  it("carries the per-loop icon through to the tile (heatmap corner icon)", () => {
    const vm = buildBoard(
      signals({
        openWork: [
          { key: "snags", label: "Snags", count: 9, href: "/s", icon: "alert-octagon" },
          { key: "hours", label: "Hours", count: 3, href: "/h", icon: "clipboard-check" },
        ],
      }),
    );
    const tile = (key: string) => vm.openWork.tiles.find((t) => t.key === key)!;
    expect(tile("snags").icon).toBe("alert-octagon");
    expect(tile("hours").icon).toBe("clipboard-check");
  });
});

describe("buildBoard — pulse", () => {
  it("renders '—' for unloaded signals, never a fabricated 0", () => {
    const vm = buildBoard(signals({}));
    const tile = (key: string) => vm.pulse.find((t) => t.key === key)!;
    expect(tile("onclock").value).toBe("—");
    expect(tile("logged").value).toBe("—");
    expect(tile("jobs").value).toBe("—");
    // pending is a real count (0 is meaningful here, not a missing signal).
    expect(tile("pending").value).toBe("0");
    expect(tile("pending").amber).toBe(false);
  });

  it("flags pending approvals amber when waiting", () => {
    const vm = buildBoard(signals({ pendingApprovals: 3 }));
    const pending = vm.pulse.find((t) => t.key === "pending")!;
    expect(pending.value).toBe("3");
    expect(pending.amber).toBe(true);
  });

  it("computes the ring only when a roster denominator exists", () => {
    const withRoster = buildBoard(signals({ crewOnSite: 14, rosterTotal: 21 }));
    const ring = withRoster.pulse.find((t) => t.key === "onclock")!;
    expect(ring.value).toBe("14");
    expect(ring.denom).toBe("/21");
    expect(ring.ringPct).toBe(67); // round(14/21*100)

    const noRoster = buildBoard(signals({ crewOnSite: 14, rosterTotal: null }));
    const plain = noRoster.pulse.find((t) => t.key === "onclock")!;
    expect(plain.value).toBe("14");
    expect(plain.denom).toBeUndefined();
    expect(plain.ringPct).toBeUndefined();
  });

  it("leads the approvals + jobs tiles with an icon; on-clock + logged carry none", () => {
    const vm = buildBoard(signals({}));
    const tile = (key: string) => vm.pulse.find((t) => t.key === key)!;
    expect(tile("pending").icon).toBe("clipboard-check");
    expect(tile("jobs").icon).toBe("briefcase");
    expect(tile("onclock").icon).toBeUndefined();
    expect(tile("logged").icon).toBeUndefined();
  });
});
