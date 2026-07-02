import { describe, expect, it } from "vitest";
import { bpToCsvPct, centsToCsvMoney, claimCsvFilename, claimToCsv } from "./csv";
import { computeClaimTotals, withComputedValues } from "./math";
import type { ProgressClaim, ProgressClaimLine } from "./types";

function line(overrides: Partial<ProgressClaimLine> = {}): ProgressClaimLine {
  return withComputedValues({
    id: "cl_zip",
    sourceKey: "boq:q1/s1/l1",
    lineRef: "1.1",
    sectionLabel: "East Gym",
    description: 'ZIP tap "instant boil" & 20A circuit',
    boqLineRef: { quoteId: "q1", sectionId: "s1", lineId: "l1" },
    workPackageId: "wp_zip",
    contractValueCents: 185_000,
    contractValueSource: "quote_line",
    previousPctBp: 3000,
    previousValueCents: 55_500,
    thisPctBp: 2500,
    overClaimOverride: false,
    evidenceRefs: [{ kind: "evidence", id: "ev1", label: "Circuit photo" }],
    toDatePctBp: 0,
    toDateValueCents: null,
    thisValueCents: null,
    order: 0,
    ...overrides,
  });
}

function claim(overrides: Partial<ProgressClaim> = {}): ProgressClaim {
  const lines = overrides.lines ?? [line()];
  const attachments = overrides.attachments ?? [];
  return {
    id: "pc_3",
    jobId: "job-1",
    number: 3,
    periodLabel: "July 2026",
    status: "submitted",
    seedSource: "quote",
    quoteId: "q1",
    previousClaimId: "pc_2",
    lines,
    attachments,
    totals: computeClaimTotals(lines, attachments),
    evidenceManifest: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    createdBy: "karen",
    submittedAt: "2026-07-02T00:00:00.000Z",
    submittedBy: "karen",
    ...overrides,
  };
}

describe("CSV cells", () => {
  it("money is plain dollars with 2dp, empty for unpriced, signed for credits", () => {
    expect(centsToCsvMoney(185_000)).toBe("1850.00");
    expect(centsToCsvMoney(5)).toBe("0.05");
    expect(centsToCsvMoney(-1050)).toBe("-10.50");
    expect(centsToCsvMoney(null)).toBe("");
  });

  it("percent is a plain number, max 2dp", () => {
    expect(bpToCsvPct(1250)).toBe("12.5");
    expect(bpToCsvPct(10_000)).toBe("100");
    expect(bpToCsvPct(3333)).toBe("33.33");
  });
});

describe("claimToCsv", () => {
  it("emits the Payapps keying columns and is deterministic", () => {
    const c = claim();
    const csv = claimToCsv(c);
    expect(claimToCsv(c)).toBe(csv); // deterministic
    const rows = csv.split("\n");
    expect(rows[0]).toBe(
      '"Line ref","Section","Description","Contract value","Previously claimed %","Previously claimed value","This claim %","This claim value","Claimed to date %","Claimed to date value","Evidence linked"',
    );
    // Quotes in the description are escaped, money/percent keyed plain.
    expect(rows[1]).toContain('"ZIP tap ""instant boil"" & 20A circuit"');
    expect(rows[1]).toContain('"1850.00"');
    expect(rows[1]).toContain('"30","555.00"'); // prev % + prev value
    expect(rows[1]).toContain('"25"');
    expect(rows[1]).toContain('"55"');
  });

  it("orders lines by their stored order", () => {
    const c = claim({
      lines: [
        line({ id: "cl_b", lineRef: "1.2", order: 1, sourceKey: "boq:q1/s1/l2" }),
        line({ id: "cl_a", lineRef: "1.1", order: 0 }),
      ],
    });
    const rows = claimToCsv(c).split("\n");
    expect(rows[1]!.startsWith('"1.1"')).toBe(true);
    expect(rows[2]!.startsWith('"1.2"')).toBe(true);
  });

  it("attachment sections export by reference, dayworks with no invented money", () => {
    const c = claim({
      attachments: [
        { kind: "variation", id: "vc_1", ref: "VO-001", label: "Extra GPO run", valueCents: 25_000 },
        { kind: "daywork", id: "dw_1", ref: "DW-004", label: "Builder direction", valueCents: null },
      ],
    });
    const rows = claimToCsv(c).split("\n");
    const vo = rows.find((r) => r.includes("VO-001"));
    expect(vo).toContain('"Variations"');
    expect(vo).toContain('"250.00"');
    const dw = rows.find((r) => r.includes("DW-004"));
    expect(dw).toContain('"Dayworks"');
    expect(dw).not.toContain('"0.00"'); // no invented value
  });

  it("draft exports carry a DRAFT marker in the totals row and filename", () => {
    const c = claim({ status: "draft", submittedAt: null, submittedBy: null });
    expect(claimToCsv(c)).toContain("DRAFT — not submitted");
    expect(claimCsvFilename("job-1", c)).toBe("progress-claim-job-1-claim-3-DRAFT.csv");
    expect(claimCsvFilename("job-1", claim())).toBe("progress-claim-job-1-claim-3.csv");
  });

  it("the totals row foots against the line rows", () => {
    const c = claim();
    const rows = claimToCsv(c).split("\n");
    const total = rows[rows.length - 1]!;
    expect(total.startsWith('"TOTAL"')).toBe(true);
    expect(total).toContain('"1850.00"'); // contract
    expect(total).toContain('"555.00"'); // previously claimed
    // this claim value = to-date 55% (101,750) − previous (55,500) = 462.50
    expect(total).toContain('"462.50"');
    expect(total).toContain('"1017.50"'); // to date
  });
});
