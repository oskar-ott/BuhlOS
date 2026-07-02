import { describe, expect, it } from "vitest";
import {
  bpToPct,
  canTransition,
  certifiedVarianceCents,
  computeClaimTotals,
  computeLineValues,
  countedClaims,
  daysBetween,
  deriveClaimedToDateCents,
  formatBpPct,
  formatCentsAud,
  isImmutable,
  oldestUnpaidClaimDays,
  pctToBp,
  previousPositionFor,
  validateForSubmit,
  validateLine,
  valueAtBpCents,
  withComputedValues,
} from "./math";
import type { ProgressClaim, ProgressClaimLine } from "./types";

/** Arthur-shaped line: the ZIP tap + dedicated 20A circuit package, $1,850 ex GST. */
function line(overrides: Partial<ProgressClaimLine> = {}): ProgressClaimLine {
  return {
    id: "cl_zip",
    sourceKey: "boq:q1/s1/l1",
    lineRef: "1.1",
    sectionLabel: "East Gym",
    description: "ZIP tap & dedicated 20A circuit",
    boqLineRef: { quoteId: "q1", sectionId: "s1", lineId: "l1" },
    workPackageId: "wp_zip",
    contractValueCents: 185_000,
    contractValueSource: "quote_line",
    previousPctBp: 0,
    previousValueCents: 0,
    thisPctBp: 0,
    overClaimOverride: false,
    evidenceRefs: [],
    toDatePctBp: 0,
    toDateValueCents: null,
    thisValueCents: null,
    order: 0,
    ...overrides,
  };
}

function claim(overrides: Partial<ProgressClaim> = {}): ProgressClaim {
  const lines = overrides.lines ?? [line()];
  return {
    id: "pc_1",
    jobId: "job-1",
    number: 1,
    periodLabel: null,
    status: "draft",
    seedSource: "quote",
    quoteId: "q1",
    previousClaimId: null,
    lines,
    attachments: [],
    totals: computeClaimTotals(lines, overrides.attachments ?? []),
    evidenceManifest: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    createdBy: "karen",
    ...overrides,
  };
}

describe("percent ↔ basis points", () => {
  it("round-trips whole and fractional percents", () => {
    expect(pctToBp(12.5)).toBe(1250);
    expect(pctToBp(100)).toBe(10_000);
    expect(bpToPct(1250)).toBe(12.5);
  });

  it("rounds sub-basis-point input instead of truncating", () => {
    expect(pctToBp(33.333)).toBe(3333);
    expect(pctToBp(66.667)).toBe(6667);
  });

  it("rounds negatives symmetrically (credits)", () => {
    expect(pctToBp(-12.345)).toBe(-1235);
    expect(pctToBp(12.345)).toBe(1235);
  });
});

describe("valueAtBpCents", () => {
  it("computes exact positions", () => {
    expect(valueAtBpCents(185_000, 5000)).toBe(92_500); // 50% of $1,850
    expect(valueAtBpCents(185_000, 10_000)).toBe(185_000);
    expect(valueAtBpCents(185_000, 0)).toBe(0);
  });

  it("rounds half away from zero", () => {
    // 1 cent at 50% = 0.5c → 1c; and symmetric for a credit position.
    expect(valueAtBpCents(1, 5000)).toBe(1);
    expect(valueAtBpCents(1, -5000)).toBe(-1);
  });
});

describe("computeLineValues — cumulative footing", () => {
  it("this-claim value is the difference of cumulative positions", () => {
    const v = computeLineValues({
      contractValueCents: 185_000,
      previousPctBp: 3000,
      previousValueCents: 55_500,
      thisPctBp: 2500,
    });
    expect(v.toDatePctBp).toBe(5500);
    expect(v.toDateValueCents).toBe(101_750);
    expect(v.thisValueCents).toBe(101_750 - 55_500);
  });

  it("never drifts across many odd-percent claims (footing invariant)", () => {
    // Claim 33.33% three times + 0.01% — cumulative money must always equal
    // the rounded cumulative position exactly, with this-claim as the diff.
    const contract = 99_999; // awkward odd contract
    let prevBp = 0;
    let prevCents = 0;
    let paidOut = 0;
    for (const stepBp of [3333, 3333, 3333, 1]) {
      const v = computeLineValues({
        contractValueCents: contract,
        previousPctBp: prevBp,
        previousValueCents: prevCents,
        thisPctBp: stepBp,
      });
      paidOut += v.thisValueCents as number;
      prevBp = v.toDatePctBp;
      prevCents = v.toDateValueCents as number;
    }
    expect(prevBp).toBe(10_000);
    expect(prevCents).toBe(contract);
    expect(paidOut).toBe(contract); // the diffs sum to exactly the contract
  });

  it("an unpriced line has null values, never $0", () => {
    const v = computeLineValues({
      contractValueCents: null,
      previousPctBp: 0,
      previousValueCents: 0,
      thisPctBp: 5000,
    });
    expect(v.toDateValueCents).toBeNull();
    expect(v.thisValueCents).toBeNull();
  });

  it("supports a negative this-claim (credit) against a prior position", () => {
    const v = computeLineValues({
      contractValueCents: 185_000,
      previousPctBp: 5000,
      previousValueCents: 92_500,
      thisPctBp: -1000,
    });
    expect(v.toDatePctBp).toBe(4000);
    expect(v.thisValueCents).toBe(74_000 - 92_500);
  });
});

describe("over-claim guard", () => {
  it("blocks past-100% without the explicit override", () => {
    const err = validateLine(withComputedValues(line({ previousPctBp: 9000, thisPctBp: 1500 })));
    expect(err).toEqual({ code: "over_claim", lineId: "cl_zip", toDatePctBp: 10_500 });
  });

  it("allows past-100% with the flagged override", () => {
    const err = validateLine(
      withComputedValues(line({ previousPctBp: 9000, thisPctBp: 1500, overClaimOverride: true })),
    );
    expect(err).toBeNull();
  });

  it("never allows a negative to-date position, even with the override", () => {
    const err = validateLine(
      withComputedValues(line({ previousPctBp: 1000, thisPctBp: -2000, overClaimOverride: true })),
    );
    expect(err).toEqual({ code: "negative_to_date", lineId: "cl_zip", toDatePctBp: -1000 });
  });

  it("exactly 100% needs no override", () => {
    const err = validateLine(withComputedValues(line({ previousPctBp: 9000, thisPctBp: 1000 })));
    expect(err).toBeNull();
  });
});

describe("previousPositionFor — cumulative derivation across claims", () => {
  const claim1 = claim({
    id: "pc_1",
    number: 1,
    status: "submitted",
    lines: [withComputedValues(line({ thisPctBp: 3000 }))],
  });
  const claim2 = claim({
    id: "pc_2",
    number: 2,
    status: "submitted",
    lines: [
      withComputedValues(line({ previousPctBp: 3000, previousValueCents: 55_500, thisPctBp: 2500 })),
    ],
  });

  it("takes the LATEST non-draft claim carrying the sourceKey", () => {
    const prev = previousPositionFor("boq:q1/s1/l1", [claim1, claim2]);
    expect(prev.pctBp).toBe(5500);
    expect(prev.valueCents).toBe(101_750);
    expect(prev.claimId).toBe("pc_2");
  });

  it("ignores drafts entirely", () => {
    const draft = claim({ id: "pc_3", number: 3, status: "draft", lines: [withComputedValues(line({ thisPctBp: 9999 }))] });
    const prev = previousPositionFor("boq:q1/s1/l1", [claim1, draft]);
    expect(prev.claimId).toBe("pc_1");
    expect(prev.pctBp).toBe(3000);
  });

  it("is zero for a never-claimed sourceKey", () => {
    expect(previousPositionFor("boq:q1/s1/other", [claim1, claim2])).toEqual({
      pctBp: 0,
      valueCents: 0,
      claimId: null,
    });
  });

  it("countedClaims sorts by number and drops drafts", () => {
    const draft = claim({ id: "pc_d", number: 9, status: "draft" });
    expect(countedClaims([claim2, draft, claim1]).map((c) => c.id)).toEqual(["pc_1", "pc_2"]);
  });
});

describe("computeClaimTotals", () => {
  it("sums priced lines and counts unpriced ones honestly", () => {
    const lines = [
      withComputedValues(line({ id: "cl_a", sourceKey: "boq:q1/s1/l1", thisPctBp: 5000 })),
      withComputedValues(
        line({ id: "cl_b", sourceKey: "manual:x", contractValueCents: null, thisPctBp: 5000 }),
      ),
    ];
    const totals = computeClaimTotals(lines, [{ valueCents: 25_000 }, { valueCents: null }]);
    expect(totals.contractValueCents).toBe(185_000);
    expect(totals.thisLinesValueCents).toBe(92_500);
    expect(totals.attachmentsValueCents).toBe(25_000);
    expect(totals.thisClaimValueCents).toBe(117_500);
    expect(totals.toDateValueCents).toBe(92_500);
    expect(totals.unpricedLineCount).toBe(1);
  });
});

describe("validateForSubmit", () => {
  it("blocks an empty claim", () => {
    expect(validateForSubmit(claim({ lines: [] }))).toEqual([{ code: "no_lines" }]);
  });

  it("blocks a claim with no movement", () => {
    expect(validateForSubmit(claim())).toEqual([{ code: "nothing_claimed" }]);
  });

  it("blocks an unresolved over-claim and reports the line", () => {
    const c = claim({ lines: [withComputedValues(line({ previousPctBp: 9500, previousValueCents: 175_750, thisPctBp: 1000 }))] });
    const blockers = validateForSubmit(c);
    expect(blockers).toContainEqual({ code: "over_claim", lineId: "cl_zip", toDatePctBp: 10_500 });
  });

  it("passes a moving, guarded claim — unsupported lines do NOT block", () => {
    const c = claim({ lines: [withComputedValues(line({ thisPctBp: 2500 }))] });
    expect(validateForSubmit(c)).toEqual([]);
  });

  it("attachment-only movement counts as movement", () => {
    const lines = [withComputedValues(line())];
    const c = claim({
      lines,
      attachments: [{ kind: "variation", id: "vc_1", ref: "VO-001", label: "Extra GPO", valueCents: 25_000 }],
    });
    expect(validateForSubmit(c)).toEqual([]);
  });
});

describe("register derivations", () => {
  const c1 = claim({
    id: "pc_1",
    number: 1,
    status: "submitted",
    submittedAt: "2026-06-01T00:00:00.000Z",
    lines: [withComputedValues(line({ thisPctBp: 3000 }))],
    attachments: [{ kind: "variation", id: "vc_1", ref: "VO-001", label: "Extra GPO", valueCents: 25_000 }],
  });
  const c2 = claim({
    id: "pc_2",
    number: 2,
    status: "submitted",
    submittedAt: "2026-07-01T00:00:00.000Z",
    lines: [
      withComputedValues(line({ previousPctBp: 3000, previousValueCents: 55_500, thisPctBp: 2000 })),
    ],
  });

  it("derives claimedToDate = latest cumulative + all non-draft attachments", () => {
    // latest to-date = 50% of $1,850 = 92,500; + VO-001 25,000 from claim 1.
    expect(deriveClaimedToDateCents([c1, c2])).toBe(92_500 + 25_000);
  });

  it("is 0 with no counted claims (drafts ignored)", () => {
    expect(deriveClaimedToDateCents([claim()])).toBe(0);
  });

  it("ages the OLDEST unpaid claim, null when everything is paid", () => {
    expect(oldestUnpaidClaimDays([c1, c2], "2026-07-03T00:00:00.000Z")).toBe(32);
    const paid1 = { ...c1, status: "paid" as const };
    expect(oldestUnpaidClaimDays([paid1, c2], "2026-07-03T00:00:00.000Z")).toBe(2);
    const paid2 = { ...c2, status: "paid" as const };
    expect(oldestUnpaidClaimDays([paid1, paid2], "2026-07-03T00:00:00.000Z")).toBeNull();
  });

  it("daysBetween floors and never goes negative", () => {
    expect(daysBetween("2026-07-01T00:00:00.000Z", "2026-07-02T23:00:00.000Z")).toBe(1);
    expect(daysBetween("2026-07-03T00:00:00.000Z", "2026-07-01T00:00:00.000Z")).toBe(0);
  });

  it("certified variance = certified − claimed, null until certified", () => {
    expect(certifiedVarianceCents(c2)).toBeNull();
    const certified = { ...c2, status: "certified" as const, certifiedValueCents: 30_000 };
    expect(certifiedVarianceCents(certified)).toBe(30_000 - certified.totals.thisClaimValueCents);
  });
});

describe("lifecycle", () => {
  it("transition table: submitted→certified→paid, submitted→paid; nothing else", () => {
    expect(canTransition("submitted", "certified")).toBe(true);
    expect(canTransition("certified", "paid")).toBe(true);
    expect(canTransition("submitted", "paid")).toBe(true);
    expect(canTransition("draft", "certified")).toBe(false);
    expect(canTransition("paid", "certified")).toBe(false);
    expect(canTransition("certified", "submitted")).toBe(false);
  });

  it("everything past draft is immutable", () => {
    expect(isImmutable({ status: "draft" })).toBe(false);
    expect(isImmutable({ status: "submitted" })).toBe(true);
    expect(isImmutable({ status: "paid" })).toBe(true);
  });
});

describe("display formatting", () => {
  it("formats cents as AUD with honest absence", () => {
    expect(formatCentsAud(185_000)).toBe("$1,850.00");
    expect(formatCentsAud(-1050)).toBe("−$10.50");
    expect(formatCentsAud(null)).toBe("—");
  });

  it("formats basis points", () => {
    expect(formatBpPct(1250)).toBe("12.5%");
    expect(formatBpPct(10_000)).toBe("100%");
    expect(formatBpPct(3333)).toBe("33.33%");
  });
});
