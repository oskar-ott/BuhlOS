import { describe, expect, it } from "vitest";
import { computeClaimTotals, withComputedValues } from "./math";
import {
  boqSourceKey,
  carryForwardManualLines,
  packageSourceKey,
  quoteLineValueCents,
  seedLinesFromPackages,
  seedLinesFromQuote,
  type SeedQuote,
} from "./seed";
import type { ProgressClaim, ProgressClaimLine } from "./types";

/** Arthur-shaped quote: two sections, awkward qty×rate arithmetic included. */
const quote: SeedQuote = {
  id: "q1",
  sections: [
    {
      id: "s1",
      title: "East Gym",
      lines: [
        { id: "l1", description: "ZIP tap & dedicated 20A circuit", qty: 1, rate: 1850 },
        { id: "l2", description: "GPO double, RCD protected", qty: 14, rate: 68.5 },
      ],
    },
    {
      id: "s2",
      title: "Amenities",
      lines: [{ id: "l3", description: "Heated towel rail circuit", qty: 3, rate: 210.33 }],
    },
  ],
};

const packages = [
  {
    id: "wp_zip",
    title: "East Gym — ZIP tap & dedicated 20A circuit",
    boqLineRefs: [{ quoteId: "q1", sectionId: "s1", lineId: "l1" }],
  },
  { id: "wp_amen", title: "Amenities fit-off", boqLineRefs: [] },
];

function seedDeps(priorClaims: ProgressClaim[] = []) {
  let n = 0;
  return { mintLineId: () => `cl_test_${++n}`, priorClaims };
}

describe("quoteLineValueCents — grounded in the quoting footing rule", () => {
  it("qty × rate rounded to cents, as integer cents", () => {
    expect(quoteLineValueCents({ qty: 1, rate: 1850 })).toBe(185_000);
    expect(quoteLineValueCents({ qty: 14, rate: 68.5 })).toBe(95_900);
    // 3 × 210.33 = 630.99 exactly
    expect(quoteLineValueCents({ qty: 3, rate: 210.33 })).toBe(63_099);
  });

  it("float-artefact rates still round like the printed quote", () => {
    // 2.675 dollars → 267.5 cents → rounds half-up to 268 (the quoting rule).
    expect(quoteLineValueCents({ qty: 1, rate: 2.675 })).toBe(268);
  });
});

describe("seedLinesFromQuote", () => {
  it("one line per priced quote line with section grouping + positional refs", () => {
    const lines = seedLinesFromQuote(quote, packages, seedDeps());
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.lineRef)).toEqual(["1.1", "1.2", "2.1"]);
    expect(lines[0]!.sectionLabel).toBe("East Gym");
    expect(lines[2]!.sectionLabel).toBe("Amenities");
    expect(lines[0]!.contractValueCents).toBe(185_000);
    expect(lines[0]!.contractValueSource).toBe("quote_line");
    expect(lines[0]!.boqLineRef).toEqual({ quoteId: "q1", sectionId: "s1", lineId: "l1" });
  });

  it("stable sourceKeys + work-package resolution via boqLineRefs", () => {
    const lines = seedLinesFromQuote(quote, packages, seedDeps());
    expect(lines[0]!.sourceKey).toBe(boqSourceKey("q1", "s1", "l1"));
    expect(lines[0]!.workPackageId).toBe("wp_zip");
    expect(lines[1]!.workPackageId).toBeNull();
  });

  it("seeds at 0% this-claim with previous derived from prior claims", () => {
    const priorLine: ProgressClaimLine = withComputedValues({
      id: "cl_prev",
      sourceKey: boqSourceKey("q1", "s1", "l1"),
      lineRef: "1.1",
      sectionLabel: "East Gym",
      description: "ZIP tap & dedicated 20A circuit",
      boqLineRef: { quoteId: "q1", sectionId: "s1", lineId: "l1" },
      workPackageId: "wp_zip",
      contractValueCents: 185_000,
      contractValueSource: "quote_line",
      previousPctBp: 0,
      previousValueCents: 0,
      thisPctBp: 4000,
      overClaimOverride: false,
      evidenceRefs: [],
      toDatePctBp: 0,
      toDateValueCents: null,
      thisValueCents: null,
      order: 0,
    });
    const prior: ProgressClaim = {
      id: "pc_1",
      jobId: "job-1",
      number: 1,
      periodLabel: null,
      status: "submitted",
      seedSource: "quote",
      quoteId: "q1",
      previousClaimId: null,
      lines: [priorLine],
      attachments: [],
      totals: computeClaimTotals([priorLine], []),
      evidenceManifest: null,
      createdAt: "2026-06-01T00:00:00.000Z",
      createdBy: null,
    };
    const lines = seedLinesFromQuote(quote, packages, seedDeps([prior]));
    expect(lines[0]!.previousPctBp).toBe(4000);
    expect(lines[0]!.previousValueCents).toBe(74_000);
    expect(lines[0]!.thisPctBp).toBe(0);
    // The other lines were never claimed — clean zero baseline.
    expect(lines[1]!.previousPctBp).toBe(0);
  });
});

describe("seedLinesFromPackages", () => {
  it("one UNPRICED line per package — no invented contract values", () => {
    const lines = seedLinesFromPackages(packages, seedDeps());
    expect(lines).toHaveLength(2);
    expect(lines[0]!.sourceKey).toBe(packageSourceKey("wp_zip"));
    expect(lines[0]!.contractValueCents).toBeNull();
    expect(lines[0]!.contractValueSource).toBe("manual");
    expect(lines[0]!.workPackageId).toBe("wp_zip");
    expect(lines[0]!.thisValueCents).toBeNull();
  });
});

describe("carryForwardManualLines", () => {
  it("carries manual lines from the latest non-draft claim with their value + chain", () => {
    const manual: ProgressClaimLine = withComputedValues({
      id: "cl_m1",
      sourceKey: "manual:cl_m1",
      lineRef: "M1",
      sectionLabel: null,
      description: "Temporary site power",
      boqLineRef: null,
      workPackageId: null,
      contractValueCents: 40_000,
      contractValueSource: "manual",
      previousPctBp: 0,
      previousValueCents: 0,
      thisPctBp: 5000,
      overClaimOverride: false,
      evidenceRefs: [],
      toDatePctBp: 0,
      toDateValueCents: null,
      thisValueCents: null,
      order: 3,
    });
    const prior: ProgressClaim = {
      id: "pc_1",
      jobId: "job-1",
      number: 1,
      periodLabel: null,
      status: "submitted",
      seedSource: "quote",
      quoteId: "q1",
      previousClaimId: null,
      lines: [manual],
      attachments: [],
      totals: computeClaimTotals([manual], []),
      evidenceManifest: null,
      createdAt: "2026-06-01T00:00:00.000Z",
      createdBy: null,
    };
    const deps = seedDeps([prior]);
    const seeded = seedLinesFromQuote(quote, packages, deps);
    const all = carryForwardManualLines(seeded, deps);
    expect(all).toHaveLength(4);
    const carried = all[3]!;
    expect(carried.sourceKey).toBe("manual:cl_m1");
    expect(carried.contractValueCents).toBe(40_000);
    expect(carried.previousPctBp).toBe(5000);
    expect(carried.previousValueCents).toBe(20_000);
  });

  it("no prior claims → seeded lines unchanged", () => {
    const deps = seedDeps();
    const seeded = seedLinesFromQuote(quote, packages, deps);
    expect(carryForwardManualLines(seeded, deps)).toHaveLength(3);
  });
});
