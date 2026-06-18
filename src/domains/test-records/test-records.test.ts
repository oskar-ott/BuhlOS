import { describe, expect, it } from "vitest";
import { TestRecordInputSchema, TestRecordSchema } from "./schema";
import { buildTestRecord, deriveOverallStatus, deriveRowStatus } from "./derive";

function baseInput(over: Record<string, unknown> = {}) {
  return {
    jobId: "job_1",
    reportType: "eicr",
    tester: "Sparky",
    testedAt: "2026-06-18T02:00:00.000Z",
    rows: [
      { circuit: "Ring final — kitchen", testType: "insulation_resistance", value: 200, unit: "MOhm", min: 1 },
    ],
    ...over,
  };
}

describe("TestRecord schema", () => {
  it("accepts a minimal valid input", () => {
    expect(TestRecordInputSchema.safeParse(baseInput()).success).toBe(true);
  });

  it("requires at least one row", () => {
    expect(TestRecordInputSchema.safeParse(baseInput({ rows: [] })).success).toBe(false);
  });

  it("requires a non-empty tester and circuit", () => {
    expect(TestRecordInputSchema.safeParse(baseInput({ tester: "" })).success).toBe(false);
    expect(
      TestRecordInputSchema.safeParse(baseInput({ rows: [{ circuit: "", testType: "polarity" }] })).success,
    ).toBe(false);
  });

  it("rejects an unknown test type", () => {
    expect(
      TestRecordInputSchema.safeParse(baseInput({ rows: [{ circuit: "c", testType: "made_up" }] })).success,
    ).toBe(false);
  });

  it("defaults reportType to 'other' and passes unknown forward-compat fields through", () => {
    const parsed = TestRecordInputSchema.parse(baseInput({ reportType: undefined, instrumentSerial: "FLK-1" }));
    expect(parsed.reportType).toBe("other");
    expect((parsed as Record<string, unknown>).instrumentSerial).toBe("FLK-1");
  });
});

describe("deriveRowStatus / deriveOverallStatus", () => {
  it("pass within criteria, fail outside, na with no criteria or no value", () => {
    expect(deriveRowStatus({ circuit: "c", testType: "insulation_resistance", value: 200, min: 1 })).toBe("pass");
    expect(deriveRowStatus({ circuit: "c", testType: "earth_fault_loop_zs", value: 2, max: 1.37 })).toBe("fail");
    expect(deriveRowStatus({ circuit: "c", testType: "polarity" })).toBe("na"); // no criteria + no value
    expect(deriveRowStatus({ circuit: "c", testType: "insulation_resistance", min: 1 })).toBe("na"); // criteria, no value
  });

  it("overall fails if any row fails; passes if any pass and none fail; else na", () => {
    expect(deriveOverallStatus([{ status: "pass" }, { status: "fail" }])).toBe("fail");
    expect(deriveOverallStatus([{ status: "pass" }, { status: "na" }])).toBe("pass");
    expect(deriveOverallStatus([{ status: "na" }, { status: "na" }])).toBe("na");
  });
});

describe("buildTestRecord", () => {
  it("derives every row status + overall, stamps id/audit, round-trips the schema", () => {
    const rec = buildTestRecord(
      TestRecordInputSchema.parse(
        baseInput({
          rows: [
            { circuit: "IR kitchen", testType: "insulation_resistance", value: 200, min: 1 },
            { circuit: "Zs kitchen", testType: "earth_fault_loop_zs", value: 2, max: 1.37 },
          ],
        }),
      ),
      { id: "tr_1", at: "2026-06-18T03:00:00.000Z", createdBy: "u_admin" },
    );
    expect(rec.rows[0]!.status).toBe("pass");
    expect(rec.rows[1]!.status).toBe("fail");
    expect(rec.overallStatus).toBe("fail");
    expect(rec.id).toBe("tr_1");
    expect(rec.createdBy).toBe("u_admin");
    expect(TestRecordSchema.safeParse(rec).success).toBe(true);
  });

  it("a client-asserted 'pass' is ignored — status is always re-derived from the value", () => {
    const rec = buildTestRecord(
      TestRecordInputSchema.parse(
        baseInput({
          rows: [{ circuit: "out of range", testType: "earth_fault_loop_zs", value: 5, max: 1.37, status: "pass" }],
        }),
      ),
      { id: "tr_2", at: "2026-06-18T03:00:00.000Z" },
    );
    expect(rec.rows[0]!.status).toBe("fail"); // derived, not the smuggled "pass"
    expect(rec.overallStatus).toBe("fail");
  });
});
