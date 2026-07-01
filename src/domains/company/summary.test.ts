import { describe, expect, it } from "vitest";
import {
  buildItpTemplatesSummary,
  buildQaSummary,
  buildQuotesSummary,
} from "./summary";
import type { QuoteStatus, QuoteSummary } from "@/domains/quoting/schema";
import type { QaDashboard } from "@/domains/itp/qa-rollup";
import type { ITPTemplateSummary } from "@/domains/itp/types";

// ── fixtures ────────────────────────────────────────────────────────────────

function quote(status: QuoteStatus, totalIncGst: number): QuoteSummary {
  return {
    id: `q_${status}_${totalIncGst}`,
    name: `Quote ${status}`,
    status,
    updatedAt: "2026-06-20T00:00:00.000Z",
    totalIncGst,
    lineCount: 3,
  };
}

function tile(vm: { tiles: ReadonlyArray<{ key: string }> }, key: string) {
  const t = vm.tiles.find((x) => x.key === key);
  if (!t) throw new Error(`tile ${key} not found`);
  return t as (typeof vm.tiles)[number] & {
    label: string;
    value: string;
    hint: string;
    tone: string;
  };
}

function dashboard(
  totals: QaDashboard["totals"],
  oldestActiveAgeDays: number | null,
): QaDashboard {
  return { rows: [], totals, oldestActiveAgeDays };
}

function template(over: Partial<ITPTemplateSummary>): ITPTemplateSummary {
  return { id: "t", name: "T", ...over };
}

// ── Quotes ──────────────────────────────────────────────────────────────────

describe("buildQuotesSummary", () => {
  it("counts live (draft + submitted) and sums the live pipeline sell-side total only", () => {
    const vm = buildQuotesSummary([
      quote("draft", 1000),
      quote("submitted", 2000),
      quote("won", 9999), // terminal — excluded from live count AND pipeline value
      quote("lost", 8888),
      quote("archived", 7777),
    ]);
    expect(tile(vm, "live").value).toBe("2");
    // pipeline = 1000 + 2000 only (won/lost/archived excluded)
    expect(tile(vm, "pipeline").value).toBe("$3,000.00");
    expect(tile(vm, "submitted").value).toBe("1");
    expect(tile(vm, "won").value).toBe("1");
    expect(vm.subline).toBe("5 quotes · 2 live");
  });

  it("shows pipeline as — (not $0.00) when there are no live quotes", () => {
    const vm = buildQuotesSummary([quote("won", 5000), quote("lost", 1000)]);
    expect(tile(vm, "live").value).toBe("0");
    expect(tile(vm, "pipeline").value).toBe("—");
    expect(tile(vm, "won").value).toBe("1");
  });

  it("won tile turns success only when a quote is actually won", () => {
    const none = buildQuotesSummary([quote("draft", 100)]);
    expect(tile(none, "won").tone).toBe("neutral");
    const some = buildQuotesSummary([quote("won", 100)]);
    expect(tile(some, "won").tone).toBe("success");
  });

  it("submitted tile reads info when quotes are out with the client", () => {
    const out = buildQuotesSummary([quote("submitted", 100)]);
    expect(tile(out, "submitted").tone).toBe("info");
    const none = buildQuotesSummary([quote("draft", 100)]);
    expect(tile(none, "submitted").tone).toBe("neutral");
  });

  it("handles an empty register honestly (zeros + em-dash pipeline)", () => {
    const vm = buildQuotesSummary([]);
    expect(tile(vm, "live").value).toBe("0");
    expect(tile(vm, "pipeline").value).toBe("—");
    expect(vm.subline).toBe("0 quotes · 0 live");
  });

  it("ignores a non-finite total rather than producing NaN", () => {
    const vm = buildQuotesSummary([
      quote("draft", Number.NaN),
      quote("draft", 500),
    ]);
    expect(tile(vm, "pipeline").value).toBe("$500.00");
  });

  it("singularises the subline for one quote", () => {
    expect(buildQuotesSummary([quote("draft", 1)]).subline).toBe("1 quote · 1 live");
  });
});

// ── QA ──────────────────────────────────────────────────────────────────────

describe("buildQaSummary", () => {
  it("reads the server-derived totals straight off the dashboard (no recompute)", () => {
    const vm = buildQaSummary(
      dashboard(
        { jobs: 5, jobsWithItps: 3, instances: 12, activeInstances: 7, awaitingSignOff: 2, openPoints: 4 },
        9,
      ),
    );
    expect(tile(vm, "active").value).toBe("7");
    expect(tile(vm, "awaiting").value).toBe("2");
    expect(tile(vm, "openpoints").value).toBe("4");
    expect(tile(vm, "oldest").value).toBe("9d");
    expect(vm.subline).toBe("5 active jobs · 3 with ITPs");
  });

  it("never treats witnessed (awaiting sign-off) as done — it's its own warning tile", () => {
    const vm = buildQaSummary(
      dashboard(
        { jobs: 1, jobsWithItps: 1, instances: 3, activeInstances: 3, awaitingSignOff: 3, openPoints: 0 },
        1,
      ),
    );
    const awaiting = tile(vm, "awaiting");
    expect(awaiting.value).toBe("3");
    expect(awaiting.tone).toBe("warning");
    expect(awaiting.hint).toMatch(/not reviewed/i);
    // there is no "complete"/"done" tile that could fold witnessed in
    expect(vm.tiles.some((t) => /done|complete/i.test(t.label))).toBe(false);
  });

  it("renders oldest active as — when nothing is in flight", () => {
    const vm = buildQaSummary(
      dashboard(
        { jobs: 2, jobsWithItps: 2, instances: 4, activeInstances: 0, awaitingSignOff: 0, openPoints: 0 },
        null,
      ),
    );
    expect(tile(vm, "oldest").value).toBe("—");
  });

  it("escalates the oldest-active tone by age (>=7 warning, >=14 danger)", () => {
    const base = { jobs: 1, jobsWithItps: 1, instances: 1, activeInstances: 1, awaitingSignOff: 0, openPoints: 0 };
    expect(tile(buildQaSummary(dashboard(base, 3)), "oldest").tone).toBe("neutral");
    expect(tile(buildQaSummary(dashboard(base, 7)), "oldest").tone).toBe("warning");
    expect(tile(buildQaSummary(dashboard(base, 21)), "oldest").tone).toBe("danger");
  });

  it("surfaces jobs with no ITPs as a coverage gap in the oldest tile hint", () => {
    const vm = buildQaSummary(
      dashboard(
        { jobs: 4, jobsWithItps: 1, instances: 2, activeInstances: 1, awaitingSignOff: 0, openPoints: 0 },
        2,
      ),
    );
    expect(tile(vm, "oldest").hint).toMatch(/3 jobs with no ITPs/);
  });
});

// ── ITP templates ─────────────────────────────────────────────────────────

describe("buildItpTemplatesSummary", () => {
  it("counts live / archived and totals checks across LIVE templates only", () => {
    const vm = buildItpTemplatesSummary([
      template({ id: "a", points: [{ id: "p1" }, { id: "p2" }] }),
      template({ id: "b", points: [{ id: "p3" }] }),
      template({ id: "c", archived: true, points: [{ id: "p4" }, { id: "p5" }, { id: "p6" }] }),
    ]);
    expect(tile(vm, "live").value).toBe("2");
    expect(tile(vm, "checks").value).toBe("3"); // 2 + 1; archived's 3 excluded
    expect(tile(vm, "archived").value).toBe("1");
    expect(vm.subline).toBe("2 live · 1 archived");
  });

  it("flags live templates that carry no checks as an authoring gap", () => {
    const vm = buildItpTemplatesSummary([
      template({ id: "a", points: [{ id: "p1" }] }),
      template({ id: "b", points: [] }),
      template({ id: "c" }), // no points field at all → also empty
    ]);
    const empty = tile(vm, "empty");
    expect(empty.value).toBe("2");
    expect(empty.tone).toBe("warning");
  });

  it("shows checks as — when there are no live templates", () => {
    const vm = buildItpTemplatesSummary([
      template({ id: "a", archived: true, points: [{ id: "p1" }] }),
    ]);
    expect(tile(vm, "live").value).toBe("0");
    expect(tile(vm, "checks").value).toBe("—");
    expect(tile(vm, "archived").value).toBe("1");
  });

  it("treats a missing archived flag as live", () => {
    const vm = buildItpTemplatesSummary([template({ id: "a", points: [{ id: "p1" }] })]);
    expect(tile(vm, "live").value).toBe("1");
    expect(tile(vm, "archived").value).toBe("0");
  });
});
