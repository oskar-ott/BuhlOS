import { describe, it, expect } from "vitest";
import { DayworkSchema } from "./schema";
import type { Daywork } from "./types";
import {
  nextDayworkSeq,
  formatDayworkRef,
  canTransition,
  dayworkAgeMs,
  isUnsignedAging,
  isImmutable,
  assertAmendmentAllowed,
  buildAmendmentSeed,
  compareForRegister,
  summariseRegister,
  UNSIGNED_AGING_THRESHOLD_MS,
} from "./service";
import { dayworkLabourHours, dayworkStatusLabel } from "./format";

const T0 = Date.parse("2026-06-14T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function docket(over: Partial<Daywork> = {}): Daywork {
  return DayworkSchema.parse({
    id: "dw_1",
    jobId: "job_100arthur",
    ref: "DW-001",
    seq: 1,
    date: "2026-06-14",
    description: "Extra make-safe, East Gym",
    status: "unsigned",
    createdById: "u1",
    createdByName: "Worker",
    createdAt: "2026-06-14T00:00:00.000Z",
    ...over,
  });
}

describe("nextDayworkSeq — max+1, never array length", () => {
  it("empty → 1", () => expect(nextDayworkSeq([])).toBe(1));
  it("contiguous → next", () => expect(nextDayworkSeq([{ seq: 1 }, { seq: 2 }])).toBe(3));
  it("gap-safe: a deleted ref is never reused", () => {
    expect(nextDayworkSeq([{ seq: 1 }, { seq: 3 }])).toBe(4);
  });
  it("unordered input", () => expect(nextDayworkSeq([{ seq: 3 }, { seq: 1 }, { seq: 2 }])).toBe(4));
});

describe("formatDayworkRef", () => {
  it("pads to three digits", () => {
    expect(formatDayworkRef(1)).toBe("DW-001");
    expect(formatDayworkRef(42)).toBe("DW-042");
  });
  it("widens past 999", () => expect(formatDayworkRef(1000)).toBe("DW-1000"));
});

describe("canTransition — forward-only pipeline", () => {
  it("allows create and the two forward steps", () => {
    expect(canTransition(null, "unsigned")).toBe(true);
    expect(canTransition("unsigned", "signed")).toBe(true);
    expect(canTransition("signed", "invoiced")).toBe(true);
  });
  it("forbids un-signing, skipping and backward moves", () => {
    expect(canTransition("signed", "unsigned")).toBe(false);
    expect(canTransition("invoiced", "signed")).toBe(false);
    expect(canTransition("unsigned", "invoiced")).toBe(false);
    expect(canTransition("signed", "signed")).toBe(false);
  });
});

describe("unsigned-aging", () => {
  it("ages an unsigned docket past 24h", () => {
    expect(isUnsignedAging(docket(), T0 + 23 * HOUR)).toBe(false);
    expect(isUnsignedAging(docket(), T0 + 25 * HOUR)).toBe(true);
  });
  it("a signed docket is never aging, however old", () => {
    expect(isUnsignedAging(docket({ status: "signed" }), T0 + 1000 * HOUR)).toBe(false);
  });
  it("dayworkAgeMs measures from createdAt", () => {
    expect(dayworkAgeMs("2026-06-14T00:00:00.000Z", T0 + 2 * HOUR)).toBe(2 * HOUR);
  });
  it("threshold is 24h", () => expect(UNSIGNED_AGING_THRESHOLD_MS).toBe(24 * HOUR));
});

describe("immutability & amendment", () => {
  it("signed/invoiced are immutable; unsigned is not", () => {
    expect(isImmutable("unsigned")).toBe(false);
    expect(isImmutable("signed")).toBe(true);
    expect(isImmutable("invoiced")).toBe(true);
  });
  it("you amend an immutable docket, edit an unsigned one", () => {
    expect(() => assertAmendmentAllowed({ status: "unsigned" })).toThrow();
    expect(() => assertAmendmentAllowed({ status: "signed" })).not.toThrow();
  });
  it("buildAmendmentSeed back-links, resets to unsigned, drops the signature", () => {
    const original = docket({
      id: "dw_orig",
      status: "signed",
      signature: {
        supervisorName: "Sup",
        signedAt: "2026-06-14T01:00:00.000Z",
        capturedById: "u1",
        capturedByName: "Worker",
      },
      labourLines: [{ id: "l1", workerName: "Worker", hours: 4 }],
    });
    const seed = buildAmendmentSeed(original);
    expect(seed.amendmentOfId).toBe("dw_orig");
    expect(seed.status).toBe("unsigned");
    expect(seed.signature).toBeNull();
    expect(seed.labourLines).toHaveLength(1);
    // the original is untouched by the pure helper
    expect(original.status).toBe("signed");
    expect(original.signature).not.toBeNull();
  });
  it("refuses to amend an unsigned docket", () => {
    expect(() => buildAmendmentSeed(docket({ status: "unsigned" }))).toThrow();
  });
});

describe("register ordering & summary", () => {
  it("unsigned-aging sorts to the top", () => {
    const aging = docket({ id: "dw_old", seq: 1, status: "unsigned", createdAt: "2026-06-10T00:00:00.000Z" });
    const fresh = docket({ id: "dw_new", seq: 5, status: "unsigned", createdAt: "2026-06-14T00:00:00.000Z" });
    const signed = docket({ id: "dw_s", seq: 3, status: "signed", createdAt: "2026-06-11T00:00:00.000Z" });
    const sorted = [signed, fresh, aging].sort((a, b) => compareForRegister(a, b, T0 + HOUR));
    expect(sorted[0]?.id).toBe("dw_old");
  });
  it("summarises counts and the payment-risk number", () => {
    const dockets = [
      docket({ status: "unsigned", createdAt: "2026-06-10T00:00:00.000Z" }), // aging
      docket({ status: "unsigned", createdAt: "2026-06-14T00:00:00.000Z" }), // fresh
      docket({ status: "signed" }),
      docket({ status: "invoiced" }),
    ];
    const s = summariseRegister(dockets, T0 + HOUR);
    expect(s).toEqual({ total: 4, unsigned: 2, signed: 1, invoiced: 1, unsignedAging: 1 });
  });
});

describe("format", () => {
  it("totals labour hours", () => {
    const d = docket({ labourLines: [{ id: "l1", workerName: "A", hours: 4 }, { id: "l2", workerName: "B", hours: 2.5 }] });
    expect(dayworkLabourHours(d)).toBe(6.5);
  });
  it("labels statuses in plain words", () => {
    expect(dayworkStatusLabel("unsigned")).toBe("Unsigned");
    expect(dayworkStatusLabel("invoiced")).toBe("Invoiced");
  });
});

describe("schema", () => {
  it("a docket without a signature is valid and unsigned (never blocked)", () => {
    const d = docket();
    expect(d.signature).toBeNull();
    expect(d.status).toBe("unsigned");
  });
  it("defaults the line/photo arrays", () => {
    const d = docket();
    expect(d.labourLines).toEqual([]);
    expect(d.linkedTimeEntryIds).toEqual([]);
  });
  it("rejects an out-of-enum status", () => {
    expect(() => DayworkSchema.parse({ ...docket(), status: "approved" })).toThrow();
  });
});
