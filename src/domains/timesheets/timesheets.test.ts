import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AmendApproveTimeEntryPayloadSchema,
  ApproveTimeEntryPayloadSchema,
  CreateTimeEntryPayloadSchema,
  RejectTimeEntryPayloadSchema,
  TimeEntryListResponseSchema,
  TimeEntryMutationResponseSchema,
  TimeEntrySchema,
  TIME_ENTRY_STATUSES,
} from "./schema";
import {
  approveEntry,
  listForApprover,
  listOwnEntries,
  rejectEntry,
  submitNewEntry,
} from "./client";
import {
  STANDARD_DAY_HOURS,
  STANDARD_DAY_MINUTES,
  STANDARD_DAY_OT_ADD_ONS,
  MAX_HOURS_PER_DAY,
  MAX_BACKDATE_DAYS,
  BUSINESS_TIMEZONE,
  autoSplitOT,
  allocationsSumValid,
  canSubmit,
  canEdit,
  canApprove,
  localDateString,
  weekStartOf,
  weekEndOf,
  addDays,
  buildStandardDayPayload,
  buildCustomHoursPayload,
  isWithinBackdateWindow,
  parseFixDate,
  primaryJobId,
  splitHoursMinutes,
  hoursFromHm,
  lastLoggedJobFor,
  standardDayPlusOt,
  summariseMissing,
} from "./service";
import {
  amendmentLine,
  formatHoursLabel,
  statusLabel,
  statusTone,
  formatDateLabel,
  formatShortDateLabel,
  logActionTitle,
  otChipLabel,
  otSplitLabel,
} from "./format";

describe("timesheets service constants", () => {
  it("Standard Day equals 7.6 hours / 456 minutes", () => {
    expect(STANDARD_DAY_HOURS).toBe(7.6);
    expect(STANDARD_DAY_MINUTES).toBe(456);
    expect(Math.round(STANDARD_DAY_HOURS * 60)).toBe(STANDARD_DAY_MINUTES);
  });

  it("MAX_HOURS_PER_DAY is 16 (audit doc §validation)", () => {
    expect(MAX_HOURS_PER_DAY).toBe(16);
  });

  it("MAX_BACKDATE_DAYS matches legacy server's 14-day window", () => {
    expect(MAX_BACKDATE_DAYS).toBe(14);
  });
});

describe("formatHoursLabel()", () => {
  it("formats 7.6 as '7h 36m'", () => {
    expect(formatHoursLabel(7.6)).toBe("7h 36m");
  });

  it("formats 8 as '8h' (no minutes part)", () => {
    expect(formatHoursLabel(8)).toBe("8h");
  });

  it("formats 8.25 as '8h 15m'", () => {
    expect(formatHoursLabel(8.25)).toBe("8h 15m");
  });

  it("formats 0.5 as '30m' (no hours part)", () => {
    expect(formatHoursLabel(0.5)).toBe("30m");
  });

  it("formats 0 / NaN / negatives as '0h'", () => {
    expect(formatHoursLabel(0)).toBe("0h");
    expect(formatHoursLabel(-1)).toBe("0h");
    expect(formatHoursLabel(NaN)).toBe("0h");
  });
});

describe("autoSplitOT()", () => {
  it("overtime starts after the STANDARD DAY (7.6h) — owner-directed 2026-08-09, was 8h", () => {
    expect(autoSplitOT(7.6)).toEqual({ ordinary: 7.6, overtime: 0 });
    // "Standard day + 1h OT" (8.6) stores as EXACTLY that — with the old 8h
    // boundary it stored 8 + 0.6 and the app's "+1h OT" disagreed with the
    // payslip. This is the line that pins the fix.
    expect(autoSplitOT(8.6)).toEqual({ ordinary: 7.6, overtime: 1 });
    expect(autoSplitOT(8)).toEqual({ ordinary: 7.6, overtime: 0.4 });
    expect(autoSplitOT(10)).toEqual({ ordinary: 7.6, overtime: 2.4 });
    expect(autoSplitOT(8.25)).toEqual({ ordinary: 7.6, overtime: 0.65 });
    // Short days are all ordinary — the boundary only splits the excess.
    expect(autoSplitOT(4)).toEqual({ ordinary: 4, overtime: 0 });
  });
});

describe("otSplitLabel() — the single split-display source (#130)", () => {
  it("returns null at/under the threshold — zero added noise on a normal day", () => {
    // 7.6h standard day and exactly 8.0h both have no overtime → no label.
    expect(otSplitLabel({ ordinaryHours: 7.6, overtimeHours: 0, totalHours: 7.6 })).toBeNull();
    expect(otSplitLabel({ ordinaryHours: 8, overtimeHours: 0, totalHours: 8 })).toBeNull();
  });

  it("renders the office split above the threshold (8.01h / 10h / 16h)", () => {
    expect(otSplitLabel({ ordinaryHours: 8, overtimeHours: 0.01, totalHours: 8.01 })).toBe(
      "8h + 1m OT",
    );
    expect(otSplitLabel({ ordinaryHours: 8, overtimeHours: 2, totalHours: 10 })).toBe("8h + 2h OT");
    expect(otSplitLabel({ ordinaryHours: 8, overtimeHours: 8, totalHours: 16 })).toBe("8h + 8h OT");
  });

  it("uses worker words for the Phil audience — 'overtime', never 'OT' (P11)", () => {
    expect(
      otSplitLabel({ ordinaryHours: 8, overtimeHours: 2, totalHours: 10 }, { audience: "worker" }),
    ).toBe("8h + 2h overtime");
  });

  it("HONESTY GUARD (P7): a stored split that doesn't reconcile returns null", () => {
    // ordinary + overtime (8 + 2 = 10) != total (12) → never invent a split.
    expect(otSplitLabel({ ordinaryHours: 8, overtimeHours: 2, totalHours: 12 })).toBeNull();
    // Tiny rounding drift (≤ 0.01) is tolerated, not treated as garbage.
    expect(otSplitLabel({ ordinaryHours: 8, overtimeHours: 2.005, totalHours: 10 })).toBe(
      "8h + 2h OT",
    );
  });

  it("returns null for non-finite stored fields rather than throwing", () => {
    expect(
      otSplitLabel({ ordinaryHours: NaN, overtimeHours: 2, totalHours: 10 }),
    ).toBeNull();
  });
});

describe("allocationsSumValid()", () => {
  it("accepts allocations that sum to the total", () => {
    expect(allocationsSumValid(7.6, [{ hours: 7.6 }])).toBe(true);
    expect(allocationsSumValid(8, [{ hours: 4 }, { hours: 4 }])).toBe(true);
  });

  it("tolerates 0.01 rounding drift", () => {
    expect(allocationsSumValid(8, [{ hours: 2.5 }, { hours: 5.495 }])).toBe(true);
  });

  it("rejects allocations that don't sum to the total", () => {
    expect(allocationsSumValid(8, [{ hours: 4 }, { hours: 3 }])).toBe(false);
    expect(allocationsSumValid(8, [{ hours: 5 }])).toBe(false);
  });
});

describe("status transitions", () => {
  it("worker can submit from draft and rejected", () => {
    expect(canSubmit("draft")).toBe(true);
    expect(canSubmit("rejected")).toBe(true);
  });

  it("worker cannot submit from submitted or approved", () => {
    expect(canSubmit("submitted")).toBe(false);
    expect(canSubmit("approved")).toBe(false);
  });

  it("worker can edit drafts, rejected AND submitted (undecided) entries", () => {
    expect(canEdit("draft")).toBe(true);
    expect(canEdit("rejected")).toBe(true);
    // 2026-07-26 owner-directed: a worker can fix a sent day until the office
    // decides. The server has always allowed this (handlePatch only locks
    // approved/exported); the client predicate now tells the same truth.
    expect(canEdit("submitted")).toBe(true);
  });

  it("worker cannot edit approved entries (locked for pay)", () => {
    expect(canEdit("approved")).toBe(false);
  });

  it("admin/LH can only approve entries currently submitted", () => {
    expect(canApprove("submitted")).toBe(true);
    expect(canApprove("draft")).toBe(false);
    expect(canApprove("approved")).toBe(false);
    expect(canApprove("rejected")).toBe(false);
  });

  it("statuses enum covers every legal value", () => {
    expect([...TIME_ENTRY_STATUSES].sort()).toEqual(["approved", "draft", "rejected", "submitted"]);
  });
});

describe("date helpers", () => {
  it("BUSINESS_TIMEZONE is the Sydney/NSW business default", () => {
    // BuhlOS is a NSW electrical business; the server-side "today" must
    // resolve to the Sydney calendar day regardless of where Vercel runs.
    expect(BUSINESS_TIMEZONE).toBe("Australia/Sydney");
  });

  it("localDateString returns YYYY-MM-DD in the supplied timezone", () => {
    // 03:30 UTC on 2026-05-04 is 13:30 in Sydney (UTC+10 in May, AEST).
    const out = localDateString(new Date("2026-05-04T03:30:00Z"), BUSINESS_TIMEZONE);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(out).toBe("2026-05-04");
  });

  it("localDateString respects the timezone arg vs raw UTC", () => {
    // 23:30 UTC on 2026-05-04 is 09:30 the next day in Sydney → "2026-05-05".
    // Without the timezone arg, the result depends on the runtime's local
    // timezone — we just assert the matched-string format, not the value.
    const sydney = localDateString(new Date("2026-05-04T23:30:00Z"), BUSINESS_TIMEZONE);
    expect(sydney).toBe("2026-05-05");
    const local = localDateString(new Date("2026-05-04T23:30:00Z"));
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("weekStartOf returns the Monday of that ISO week", () => {
    // 2026-05-04 is a Monday
    expect(weekStartOf("2026-05-04")).toBe("2026-05-04");
    // 2026-05-07 is a Thursday
    expect(weekStartOf("2026-05-07")).toBe("2026-05-04");
    // 2026-05-03 is a Sunday → previous Monday
    expect(weekStartOf("2026-05-03")).toBe("2026-04-27");
  });

  it("isWithinBackdateWindow accepts today, yesterday, and -13 days", () => {
    const today = new Date("2026-05-15T12:00:00");
    expect(isWithinBackdateWindow("2026-05-15", today)).toBe(true);
    expect(isWithinBackdateWindow("2026-05-14", today)).toBe(true);
    expect(isWithinBackdateWindow("2026-05-01", today)).toBe(true);
  });

  it("isWithinBackdateWindow rejects dates older than 14 days or future > 1 day", () => {
    const today = new Date("2026-05-15T12:00:00");
    expect(isWithinBackdateWindow("2026-04-30", today)).toBe(false);
    expect(isWithinBackdateWindow("2026-05-17", today)).toBe(false);
    expect(isWithinBackdateWindow("nonsense", today)).toBe(false);
  });
});

describe("buildStandardDayPayload()", () => {
  it("builds a submitted Standard Day payload for one job", () => {
    const payload = buildStandardDayPayload({ date: "2026-05-04", jobId: "job-iv" });
    expect(payload.date).toBe("2026-05-04");
    expect(payload.totalHours).toBe(7.6);
    expect(payload.ordinaryHours).toBe(7.6);
    expect(payload.overtimeHours).toBe(0);
    expect(payload.status).toBe("submitted");
    expect(payload.allocations).toHaveLength(1);
    expect(payload.allocations[0]?.jobId).toBe("job-iv");
    expect(payload.allocations[0]?.hours).toBe(7.6);
  });

  it("allows a null jobId (admin flagged as needs-review server-side)", () => {
    const payload = buildStandardDayPayload({ date: "2026-05-04", jobId: null });
    expect(payload.allocations[0]?.jobId).toBeNull();
  });

  it("Standard Day payload validates against the create schema", () => {
    const payload = buildStandardDayPayload({ date: "2026-05-04", jobId: "job-iv" });
    expect(CreateTimeEntryPayloadSchema.safeParse(payload).success).toBe(true);
  });
});

describe("buildCustomHoursPayload()", () => {
  it("auto-splits overtime above the standard day (7.6h)", () => {
    const payload = buildCustomHoursPayload({ date: "2026-05-04", jobId: "j", totalHours: 10 });
    expect(payload.totalHours).toBe(10);
    expect(payload.ordinaryHours).toBe(7.6);
    expect(payload.overtimeHours).toBe(2.4);
    expect(payload.allocations[0]?.hours).toBe(10);
  });

  it("validates against the create schema for valid hours", () => {
    const payload = buildCustomHoursPayload({ date: "2026-05-04", jobId: "j", totalHours: 6 });
    expect(CreateTimeEntryPayloadSchema.safeParse(payload).success).toBe(true);
  });
});

/**
 * OT presets in the custom sheet (owner-directed 2026-08-09; the chips first
 * shipped ON the standard day 2026-08-07 and moved here so the log surface is
 * two options, no more). The sheet's presets wire EXACTLY these helpers (the
 * repo's node-env pattern — drive the same engine the component uses; the SSR
 * markup is pinned in LogHoursSheet.render.test.tsx): a tap writes
 * standardDayPlusOt(addOn) into the sheet's customHours, and the submit rides
 * the EXISTING custom-hours builder — so this suite IS the tap → fill →
 * payload behaviour of the feature.
 */
describe("custom-sheet OT presets", () => {
  it("offers the four owner-approved add-ons: +30m, +1h, +1½h, +2h", () => {
    expect([...STANDARD_DAY_OT_ADD_ONS]).toEqual([0.5, 1, 1.5, 2]);
    expect(STANDARD_DAY_OT_ADD_ONS.map(otChipLabel)).toEqual(["+30m", "+1h", "+1½h", "+2h"]);
  });

  it("standardDayPlusOt derives clean decimal totals — the maths does itself", () => {
    expect(standardDayPlusOt(0.5)).toBe(8.1);
    expect(standardDayPlusOt(1)).toBe(8.6);
    expect(standardDayPlusOt(1.5)).toBe(9.1);
    expect(standardDayPlusOt(2)).toBe(9.6);
  });

  it("a preset fills the exact-time inputs in duration words, never decimals", () => {
    // Tapping "+1h OT" writes 8.6 into customHours; the h/m inputs show the
    // whole-hours + minutes split (pinned here via splitHoursMinutes — the
    // same derivation the inputs inline) and the chip + submit button echo
    // formatHoursLabel — the worker reads "8h 36m", the store speaks 8.6,
    // nobody types either.
    expect(splitHoursMinutes(standardDayPlusOt(1))).toEqual({ hours: 8, minutes: 36 });
    expect(formatHoursLabel(standardDayPlusOt(1))).toBe("8h 36m");
    expect(formatHoursLabel(standardDayPlusOt(0.5))).toBe("8h 6m");
    expect(formatHoursLabel(standardDayPlusOt(1.5))).toBe("9h 6m");
    expect(formatHoursLabel(standardDayPlusOt(2))).toBe("9h 36m");
  });

  it("a preset submit rides the EXISTING custom-hours builder — totalHours 8.6 decimal, unchanged contract", () => {
    const payload = buildCustomHoursPayload({
      date: "2026-08-06",
      jobId: "j1",
      totalHours: standardDayPlusOt(1),
      notes: null,
    });
    // The exact decimal the store speaks — 7.6 + 1, no worker arithmetic —
    // and the stored split IS the tapped framing (OT boundary = standard day).
    expect(payload.totalHours).toBe(8.6);
    expect(payload.ordinaryHours).toBe(7.6);
    expect(payload.overtimeHours).toBe(1);
    expect(payload.allocations).toEqual([{ jobId: "j1", hours: 8.6, notes: null }]);
    expect(CreateTimeEntryPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it("REGRESSION PIN: the standard-day action sends the EXACT payload it always has — OT never rides it", () => {
    const args = { date: "2026-08-06", jobId: "j1", notes: null };
    expect(buildStandardDayPayload(args).totalHours).toBe(STANDARD_DAY_HOURS);
    // …including the null-job admin path.
    expect(buildStandardDayPayload({ date: "2026-08-06", jobId: null }).totalHours).toBe(
      STANDARD_DAY_HOURS,
    );
  });

  it("every preset total stays inside the day cap and validates against the create schema", () => {
    for (const addOn of STANDARD_DAY_OT_ADD_ONS) {
      const payload = buildCustomHoursPayload({
        date: "2026-08-06",
        jobId: "j1",
        totalHours: standardDayPlusOt(addOn),
        notes: null,
      });
      expect(payload.totalHours).toBeLessThanOrEqual(MAX_HOURS_PER_DAY);
      expect(CreateTimeEntryPayloadSchema.safeParse(payload).success).toBe(true);
    }
  });
});

describe("CreateTimeEntryPayloadSchema", () => {
  const validBase = {
    date: "2026-05-04",
    totalHours: 8,
    ordinaryHours: 8,
    overtimeHours: 0,
    allocations: [{ jobId: "j-1", hours: 8 }],
    status: "submitted" as const,
  };

  it("accepts a valid Standard Day payload", () => {
    expect(CreateTimeEntryPayloadSchema.safeParse(validBase).success).toBe(true);
  });

  it("rejects bad date strings", () => {
    const r = CreateTimeEntryPayloadSchema.safeParse({ ...validBase, date: "4 May" });
    expect(r.success).toBe(false);
  });

  it("rejects zero or negative totalHours", () => {
    expect(
      CreateTimeEntryPayloadSchema.safeParse({
        ...validBase,
        totalHours: 0,
        ordinaryHours: 0,
        overtimeHours: 0,
        allocations: [{ jobId: "j-1", hours: 0 }],
      }).success
    ).toBe(false);
    expect(
      CreateTimeEntryPayloadSchema.safeParse({
        ...validBase,
        totalHours: -1,
        ordinaryHours: -1,
        overtimeHours: 0,
        allocations: [{ jobId: "j-1", hours: -1 }],
      }).success
    ).toBe(false);
  });

  it("rejects totalHours over 16", () => {
    const r = CreateTimeEntryPayloadSchema.safeParse({
      ...validBase,
      totalHours: 20,
      ordinaryHours: 8,
      overtimeHours: 12,
      allocations: [{ jobId: "j-1", hours: 20 }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects when ordinary + overtime != total", () => {
    const r = CreateTimeEntryPayloadSchema.safeParse({
      ...validBase,
      ordinaryHours: 5,
      overtimeHours: 1,
    });
    expect(r.success).toBe(false);
  });

  it("rejects when allocations sum != total", () => {
    const r = CreateTimeEntryPayloadSchema.safeParse({
      ...validBase,
      allocations: [{ jobId: "j-1", hours: 4 }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects when allocations is empty", () => {
    const r = CreateTimeEntryPayloadSchema.safeParse({ ...validBase, allocations: [] });
    expect(r.success).toBe(false);
  });

  it("rejects notes longer than 500 characters", () => {
    const longNote = "x".repeat(501);
    const r = CreateTimeEntryPayloadSchema.safeParse({ ...validBase, notes: longNote });
    expect(r.success).toBe(false);
  });
});

describe("RejectTimeEntryPayloadSchema", () => {
  it("requires a non-empty reason (preserves rejection-reason invariant)", () => {
    const noReason = RejectTimeEntryPayloadSchema.safeParse({
      userId: "u-1",
      date: "2026-05-04",
      reason: "",
    });
    expect(noReason.success).toBe(false);
    const withReason = RejectTimeEntryPayloadSchema.safeParse({
      userId: "u-1",
      date: "2026-05-04",
      reason: "Wrong job",
    });
    expect(withReason.success).toBe(true);
  });
});

describe("ApproveTimeEntryPayloadSchema", () => {
  it("requires userId and date", () => {
    expect(
      ApproveTimeEntryPayloadSchema.safeParse({ userId: "u-1", date: "2026-05-04" }).success
    ).toBe(true);
    expect(
      ApproveTimeEntryPayloadSchema.safeParse({ userId: "", date: "2026-05-04" }).success
    ).toBe(false);
    expect(ApproveTimeEntryPayloadSchema.safeParse({ userId: "u-1", date: "bad" }).success).toBe(
      false
    );
  });
});

describe("formatting helpers", () => {
  it("statusLabel and statusTone cover every status", () => {
    expect(statusLabel("draft")).toBe("Draft");
    expect(statusLabel("submitted")).toBe("Submitted");
    expect(statusLabel("approved")).toBe("Approved");
    expect(statusLabel("rejected")).toBe("Rejected");

    expect(statusTone("draft")).toBe("neutral");
    expect(statusTone("submitted")).toBe("info");
    expect(statusTone("approved")).toBe("success");
    expect(statusTone("rejected")).toBe("danger");
  });

  it("formatDateLabel renders en-AU short weekday", () => {
    const label = formatDateLabel("2026-05-04");
    expect(label).toMatch(/Mon/);
    expect(label).toMatch(/2026/);
  });

  it("formatShortDateLabel drops the year (used on the 'logged …' sub-line)", () => {
    const label = formatShortDateLabel("2026-05-04");
    expect(label).toMatch(/Mon/);
    expect(label).toMatch(/May/);
    expect(label).not.toMatch(/2026/);
    // Malformed input is returned unchanged, never throws.
    expect(formatShortDateLabel("not-a-date")).toBe("not-a-date");
  });

  it("logActionTitle says 'today' for today and names the weekday otherwise", () => {
    const today = "2026-06-11"; // a Thursday
    expect(logActionTitle(today, today)).toBe("Log today's hours");
    // 2026-06-09 is a Tuesday — tapping it relabels the action to that day.
    expect(logActionTitle("2026-06-09", today)).toBe("Log Tuesday's hours");
    expect(logActionTitle("2026-06-08", today)).toBe("Log Monday's hours");
    // Malformed input falls back to the generic label, never throws.
    expect(logActionTitle("not-a-date", today)).toBe("Log hours for this day");
  });
});

describe("primaryJobId()", () => {
  it("returns the first allocation jobId", () => {
    expect(
      primaryJobId({
        allocations: [
          { jobId: "j-1", hours: 8 },
          { jobId: "j-2", hours: 0 },
        ],
      })
    ).toBe("j-1");
  });

  it("skips null jobIds (admin-internal allocations)", () => {
    expect(
      primaryJobId({
        allocations: [
          { jobId: null, hours: 1 },
          { jobId: "j-2", hours: 7 },
        ],
      })
    ).toBe("j-2");
  });
});

describe("lastLoggedJobFor()", () => {
  const entry = (date: string, jobId: string | null) => ({
    date,
    allocations: jobId === null ? [] : [{ jobId, hours: 7.6 }],
  });

  it("returns the newest-dated entry's job + its real date", () => {
    const result = lastLoggedJobFor(
      [entry("2026-06-17", "j-1"), entry("2026-06-19", "j-2"), entry("2026-06-12", "j-3")],
      ["j-1", "j-2", "j-3"]
    );
    expect(result).toEqual({ jobId: "j-2", date: "2026-06-19" });
  });

  it("ignores order — the latest date wins regardless of array position", () => {
    const result = lastLoggedJobFor(
      [entry("2026-06-19", "j-2"), entry("2026-06-20", "j-1")],
      ["j-1", "j-2"]
    );
    expect(result).toEqual({ jobId: "j-1", date: "2026-06-20" });
  });

  it("skips a last job that is no longer assignable (archived / unassigned)", () => {
    // Most recent is j-gone (not assignable) → falls back to the newest entry
    // whose job IS still assignable, never defaulting to a stale job.
    const result = lastLoggedJobFor(
      [entry("2026-06-20", "j-gone"), entry("2026-06-18", "j-1")],
      ["j-1"]
    );
    expect(result).toEqual({ jobId: "j-1", date: "2026-06-18" });
  });

  it("returns null when nothing matches (no recent log, or all unassignable)", () => {
    expect(lastLoggedJobFor([], ["j-1"])).toBeNull();
    expect(lastLoggedJobFor([entry("2026-06-20", "j-gone")], ["j-1"])).toBeNull();
    expect(lastLoggedJobFor([entry("2026-06-20", null)], ["j-1"])).toBeNull();
  });
});

describe("response schemas", () => {
  it("parses a server entry list response", () => {
    const list = {
      entries: [
        {
          id: "e-1",
          userId: "u-1",
          userName: "Sam",
          userRole: "tradie",
          date: "2026-05-04",
          totalHours: 7.6,
          ordinaryHours: 7.6,
          overtimeHours: 0,
          notes: null,
          status: "submitted" as const,
          submittedAt: "2026-05-04T08:00:00Z",
          approvedBy: null,
          approvedAt: null,
          rejectedReason: null,
          allocations: [{ jobId: "j-1", hours: 7.6, notes: null, sortOrder: 0 }],
          createdAt: "2026-05-04T08:00:00Z",
          updatedAt: "2026-05-04T08:00:00Z",
        },
      ],
    };
    expect(TimeEntryListResponseSchema.safeParse(list).success).toBe(true);
  });

  it("parses a mutation response that preserves rejectedReason", () => {
    const mutation = {
      entry: {
        id: "e-1",
        userId: "u-1",
        date: "2026-05-04",
        totalHours: 7.6,
        ordinaryHours: 7.6,
        overtimeHours: 0,
        status: "rejected" as const,
        rejectedReason: "Wrong job allocation",
        allocations: [{ jobId: "j-1", hours: 7.6 }],
        createdAt: "2026-05-04T08:00:00Z",
        updatedAt: "2026-05-04T09:00:00Z",
      },
    };
    const r = TimeEntryMutationResponseSchema.safeParse(mutation);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.entry.rejectedReason).toBe("Wrong job allocation");
      expect(r.data.entry.status).toBe("rejected");
    }
  });
});

/* -----------------------------------------------------------------------
 * Client integration: every wrapper either returns success or a typed
 * failure — never throws. fetch() is mocked so no network hits the API.
 * --------------------------------------------------------------------- */

describe("timesheets client wrappers", () => {
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

  it("submitNewEntry returns ok:true on 201 with a parsed entry", async () => {
    mockFetch({
      status: 201,
      body: {
        entry: {
          id: "e-1",
          userId: "u-1",
          date: "2026-05-04",
          totalHours: 7.6,
          ordinaryHours: 7.6,
          overtimeHours: 0,
          status: "submitted",
          allocations: [{ jobId: "j-1", hours: 7.6 }],
          createdAt: "2026-05-04T08:00:00Z",
          updatedAt: "2026-05-04T08:00:00Z",
        },
      },
    });
    const r = await submitNewEntry({
      date: "2026-05-04",
      totalHours: 7.6,
      ordinaryHours: 7.6,
      overtimeHours: 0,
      allocations: [{ jobId: "j-1", hours: 7.6 }],
      status: "submitted",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.entry.status).toBe("submitted");
    }
  });

  it("submitNewEntry returns ok:false on 409 duplicate (no throw)", async () => {
    mockFetch({
      status: 409,
      body: { error: "entry already exists for that date — edit it instead" },
    });
    const r = await submitNewEntry({
      date: "2026-05-04",
      totalHours: 7.6,
      ordinaryHours: 7.6,
      overtimeHours: 0,
      allocations: [{ jobId: "j-1", hours: 7.6 }],
      status: "submitted",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.status).toBe(409);
    }
  });

  it("submitNewEntry refuses to call the server with an invalid payload", async () => {
    const sentinel = vi.fn();
    globalThis.fetch = sentinel as unknown as typeof fetch;
    const r = await submitNewEntry({
      date: "bad",
      totalHours: -1,
      ordinaryHours: 0,
      overtimeHours: 0,
      allocations: [],
      status: "submitted",
    });
    expect(r.ok).toBe(false);
    expect(sentinel).not.toHaveBeenCalled();
  });

  it("listOwnEntries returns parsed entries for the current user", async () => {
    mockFetch({
      status: 200,
      body: {
        entries: [
          {
            id: "e-1",
            userId: "u-1",
            date: "2026-05-04",
            totalHours: 7.6,
            ordinaryHours: 7.6,
            overtimeHours: 0,
            status: "submitted" as const,
            allocations: [{ jobId: "j-1", hours: 7.6 }],
            createdAt: "2026-05-04T08:00:00Z",
            updatedAt: "2026-05-04T08:00:00Z",
          },
        ],
      },
    });
    const r = await listOwnEntries();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.entries).toHaveLength(1);
  });

  it("listForApprover sends scope=approver", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ entries: [] })));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await listForApprover("submitted");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(call[0]).toContain("scope=approver");
    expect(call[0]).toContain("status=submitted");
  });

  it("approveEntry sends userId + date and returns the updated entry", async () => {
    mockFetch({
      status: 200,
      body: {
        entry: {
          id: "e-1",
          userId: "u-1",
          date: "2026-05-04",
          totalHours: 7.6,
          ordinaryHours: 7.6,
          overtimeHours: 0,
          status: "approved" as const,
          approvedBy: "admin-1",
          approvedAt: "2026-05-04T09:00:00Z",
          rejectedReason: null,
          allocations: [{ jobId: "j-1", hours: 7.6 }],
          createdAt: "2026-05-04T08:00:00Z",
          updatedAt: "2026-05-04T09:00:00Z",
        },
      },
    });
    const r = await approveEntry({ userId: "u-1", date: "2026-05-04" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.entry.status).toBe("approved");
  });

  it("rejectEntry requires reason at the client", async () => {
    const sentinel = vi.fn();
    globalThis.fetch = sentinel as unknown as typeof fetch;
    const r = await rejectEntry({ userId: "u-1", date: "2026-05-04", reason: "" });
    expect(r.ok).toBe(false);
    expect(sentinel).not.toHaveBeenCalled();
  });

  it("rejectEntry returns the rejected entry on success and preserves the reason", async () => {
    mockFetch({
      status: 200,
      body: {
        entry: {
          id: "e-1",
          userId: "u-1",
          date: "2026-05-04",
          totalHours: 7.6,
          ordinaryHours: 7.6,
          overtimeHours: 0,
          status: "rejected" as const,
          rejectedReason: "Wrong job",
          rejectedAt: "2026-05-04T09:00:00Z",
          allocations: [{ jobId: "j-1", hours: 7.6 }],
          createdAt: "2026-05-04T08:00:00Z",
          updatedAt: "2026-05-04T09:00:00Z",
        },
      },
    });
    const r = await rejectEntry({ userId: "u-1", date: "2026-05-04", reason: "Wrong job" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.entry.status).toBe("rejected");
      expect(r.data.entry.rejectedReason).toBe("Wrong job");
    }
  });
});

describe("weekEndOf() / addDays() (admin weekly overview helpers)", () => {
  it("weekEndOf returns the Sunday of that ISO week", () => {
    // 2026-05-04 is a Monday; the week ends Sunday 2026-05-10.
    expect(weekEndOf("2026-05-04")).toBe("2026-05-10");
    expect(weekEndOf("2026-05-07")).toBe("2026-05-10");
    expect(weekEndOf("2026-05-10")).toBe("2026-05-10");
  });

  it("weekEndOf is always 6 days after the matching weekStartOf", () => {
    for (const d of ["2026-01-01", "2026-02-28", "2026-12-31", "2026-05-07"]) {
      expect(weekEndOf(d)).toBe(addDays(weekStartOf(d), 6));
    }
  });

  it("addDays shifts forwards and backwards across month/year boundaries", () => {
    expect(addDays("2026-05-04", 7)).toBe("2026-05-11");
    expect(addDays("2026-05-04", -7)).toBe("2026-04-27");
    expect(addDays("2026-05-31", 1)).toBe("2026-06-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-05-04", 0)).toBe("2026-05-04");
  });

  it("returns the input unchanged for a malformed date", () => {
    expect(addDays("not-a-date", 3)).toBe("not-a-date");
    expect(weekEndOf("not-a-date")).toBe("not-a-date");
  });
});

describe("summariseMissing() (missing-hours rollup)", () => {
  const missing = [
    { date: "2026-05-06", userId: "u-1", userName: "Bob", role: "tradie" },
    { date: "2026-05-05", userId: "u-1", userName: "Bob", role: "tradie" },
    { date: "2026-05-05", userId: "u-2", userName: "Alice", role: "leadingHand" },
  ];

  it("counts distinct workers and dates, not raw cells", () => {
    const s = summariseMissing(missing);
    expect(s.total).toBe(3);
    expect(s.workerCount).toBe(2);
    expect(s.dateCount).toBe(2);
  });

  it("oldestDate is the earliest missing date (for an age label)", () => {
    expect(summariseMissing(missing).oldestDate).toBe("2026-05-05");
  });

  it("groups by worker, most-missing first, with sorted dates", () => {
    const s = summariseMissing(missing);
    expect(s.byWorker.map((w) => w.userId)).toEqual(["u-1", "u-2"]);
    expect(s.byWorker[0]!.dates).toEqual(["2026-05-05", "2026-05-06"]);
    expect(s.byWorker[1]!.dates).toEqual(["2026-05-05"]);
  });

  it("groups by date ascending with workers alphabetical", () => {
    const s = summariseMissing(missing);
    expect(s.byDate.map((d) => d.date)).toEqual(["2026-05-05", "2026-05-06"]);
    expect(s.byDate[0]!.workers.map((w) => w.userName)).toEqual(["Alice", "Bob"]);
    expect(s.byDate[1]!.workers.map((w) => w.userName)).toEqual(["Bob"]);
  });

  it("dedupes a repeated worker on the same date", () => {
    const s = summariseMissing([
      { date: "2026-05-05", userId: "u-1", userName: "Bob", role: "tradie" },
      { date: "2026-05-05", userId: "u-1", userName: "Bob", role: "tradie" },
    ]);
    expect(s.total).toBe(2); // raw cells, unchanged
    expect(s.workerCount).toBe(1);
    expect(s.dateCount).toBe(1);
    expect(s.byWorker[0]!.dates).toEqual(["2026-05-05"]);
    expect(s.byDate[0]!.workers).toHaveLength(1);
  });

  it("returns an empty, zeroed summary for no missing logs", () => {
    const s = summariseMissing([]);
    expect(s).toEqual({
      total: 0,
      workerCount: 0,
      dateCount: 0,
      oldestDate: null,
      byWorker: [],
      byDate: [],
    });
  });

  it("tolerates a missing role (optional field) by normalising to null", () => {
    const s = summariseMissing([{ date: "2026-05-05", userId: "u-9", userName: "Sam" }]);
    expect(s.byWorker[0]!.role).toBeNull();
    expect(s.byDate[0]!.workers[0]!.role).toBeNull();
  });
});

describe("parseFixDate (?fixDate= deep-link param)", () => {
  it("accepts a well-formed YYYY-MM-DD date", () => {
    expect(parseFixDate("2026-06-01")).toBe("2026-06-01");
  });

  it("ignores everything else instead of erroring (stale/mangled notifications)", () => {
    expect(parseFixDate(undefined)).toBeNull();
    expect(parseFixDate(null)).toBeNull();
    expect(parseFixDate("")).toBeNull();
    expect(parseFixDate("2026-6-1")).toBeNull();
    expect(parseFixDate("2026-06-01T00:00:00Z")).toBeNull();
    expect(parseFixDate("not-a-date")).toBeNull();
    expect(parseFixDate("2026-06-01/extra")).toBeNull();
    // Next.js can hand back an array for repeated params — never a date.
    expect(parseFixDate(["2026-06-01", "2026-06-02"])).toBeNull();
  });
});

/**
 * Owner-directed "fix it and approve" (api/time-entries-amend-approve.js) —
 * the client-side half: the duration conversion the h+m inputs run on, the
 * payload contract, the worker-facing line, and the additive entry fields.
 */
describe("splitHoursMinutes() / hoursFromHm() — the duration dialect", () => {
  it("splits decimal hours into the pair a duration input edits", () => {
    expect(splitHoursMinutes(7.6)).toEqual({ hours: 7, minutes: 36 });
    expect(splitHoursMinutes(8.37)).toEqual({ hours: 8, minutes: 22 });
    expect(splitHoursMinutes(8)).toEqual({ hours: 8, minutes: 0 });
    expect(splitHoursMinutes(0.5)).toEqual({ hours: 0, minutes: 30 });
  });

  it("rounds a whisker under the hour UP into the hour, never 7h 60m", () => {
    expect(splitHoursMinutes(7.999)).toEqual({ hours: 8, minutes: 0 });
  });

  it("treats nothing / rubbish as zero rather than throwing", () => {
    expect(splitHoursMinutes(0)).toEqual({ hours: 0, minutes: 0 });
    expect(splitHoursMinutes(-3)).toEqual({ hours: 0, minutes: 0 });
    expect(splitHoursMinutes(Number.NaN)).toEqual({ hours: 0, minutes: 0 });
  });

  it("converts the pair back to the decimal the store speaks", () => {
    expect(hoursFromHm(8, 36)).toBe(8.6);
    expect(hoursFromHm(7, 36)).toBe(7.6);
    expect(hoursFromHm(8, 0)).toBe(8);
  });

  it("round-trips the incident's numbers — 8h 22m in, 8h 22m out", () => {
    const { hours, minutes } = splitHoursMinutes(8.37);
    expect(formatHoursLabel(hoursFromHm(hours, minutes))).toBe("8h 22m");
    expect(formatHoursLabel(hoursFromHm(8, 36))).toBe("8h 36m");
  });
});

describe("amendmentLine() — what the worker is told", () => {
  it("states the real before → after and the office's reason", () => {
    expect(
      amendmentLine({
        totalHours: 8.6,
        amendedFrom: { totalHours: 8.37 },
        amendedReason: "Typo — you meant 8h 36m",
      }),
    ).toBe("Adjusted by the office — 8h 22m → 8h 36m: Typo — you meant 8h 36m");
  });

  it("says nothing at all on a day the office never touched (P10)", () => {
    expect(amendmentLine({ totalHours: 7.6 })).toBeNull();
    expect(amendmentLine({ totalHours: 7.6, amendedFrom: null })).toBeNull();
  });

  it("HONESTY GUARD (P7): an unusable before-total invents no change", () => {
    expect(
      amendmentLine({
        totalHours: 7.6,
        amendedFrom: { totalHours: Number.NaN },
        amendedReason: "x",
      }),
    ).toBeNull();
  });

  it("never renders '8h → 8h' when only the job split moved", () => {
    const line = amendmentLine({
      totalHours: 8,
      amendedFrom: { totalHours: 8 },
      amendedReason: "Three of those hours were the Depot",
    })!;
    expect(line).toBe("Adjusted by the office — 8h: Three of those hours were the Depot");
    expect(line).not.toContain("→");
  });

  it("uses worker words, never office jargon (P11)", () => {
    const line = amendmentLine({ totalHours: 8.6, amendedFrom: { totalHours: 8.37 } })!;
    expect(line).toContain("Adjusted by the office");
    expect(line).not.toMatch(/amend|administrator|approver/i);
  });
});

describe("AmendApproveTimeEntryPayloadSchema", () => {
  const base = { userId: "u1", date: "2026-06-05", reason: "Typo — you meant 8h 36m" };

  it("accepts a single-job day sending just the corrected total", () => {
    expect(AmendApproveTimeEntryPayloadSchema.safeParse({ ...base, totalHours: 8.6 }).success).toBe(true);
  });

  it("accepts a split day sending each job's hours", () => {
    const parsed = AmendApproveTimeEntryPayloadSchema.safeParse({
      ...base,
      totalHours: 9,
      allocations: [
        { jobId: "j1", hours: 6 },
        { jobId: "j2", hours: 3 },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects allocations that don't sum to the stated total", () => {
    const parsed = AmendApproveTimeEntryPayloadSchema.safeParse({
      ...base,
      totalHours: 9,
      allocations: [{ jobId: "j1", hours: 6 }],
    });
    expect(parsed.success).toBe(false);
  });

  it("requires a reason and some new time", () => {
    expect(AmendApproveTimeEntryPayloadSchema.safeParse({ ...base, reason: "", totalHours: 8 }).success).toBe(false);
    expect(AmendApproveTimeEntryPayloadSchema.safeParse(base).success).toBe(false);
  });

  it("holds the same day cap the worker's own submission has", () => {
    expect(AmendApproveTimeEntryPayloadSchema.safeParse({ ...base, totalHours: 17 }).success).toBe(false);
    expect(AmendApproveTimeEntryPayloadSchema.safeParse({ ...base, totalHours: 0 }).success).toBe(false);
  });
});

describe("TimeEntrySchema — the amendment fields are additive", () => {
  const legacy = {
    id: "te1",
    userId: "u1",
    date: "2026-06-05",
    totalHours: 7.6,
    ordinaryHours: 7.6,
    overtimeHours: 0,
    status: "approved",
    allocations: [{ jobId: "j1", hours: 7.6 }],
    createdAt: "2026-06-05T07:00:00Z",
    updatedAt: "2026-06-05T08:00:00Z",
  };

  it("an entry written before this feature parses unchanged", () => {
    const parsed = TimeEntrySchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.amendedFrom).toBeUndefined();
  });

  it("an amended entry keeps its before picture through the parse", () => {
    const parsed = TimeEntrySchema.safeParse({
      ...legacy,
      totalHours: 8.6,
      ordinaryHours: 8,
      overtimeHours: 0.6,
      allocations: [{ jobId: "j1", hours: 8.6 }],
      amendedBy: "u_admin",
      amendedByName: "Oskar",
      amendedAt: "2026-06-06T02:00:00Z",
      amendedReason: "Typo — you meant 8h 36m",
      amendedFrom: {
        totalHours: 8.37,
        ordinaryHours: 8,
        overtimeHours: 0.37,
        allocations: [{ jobId: "j1", hours: 8.37 }],
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.amendedFrom?.totalHours).toBe(8.37);
      expect(amendmentLine(parsed.data)).toContain("8h 22m → 8h 36m");
    }
  });
});
