import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApproveTimeEntryPayloadSchema,
  CreateTimeEntryPayloadSchema,
  RejectTimeEntryPayloadSchema,
  TimeEntryListResponseSchema,
  TimeEntryMutationResponseSchema,
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
  buildStandardDayPayload,
  buildCustomHoursPayload,
  isWithinBackdateWindow,
  primaryJobId,
} from "./service";
import { formatHoursLabel, statusLabel, statusTone, formatDateLabel } from "./format";

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
  it("matches the legacy server's split", () => {
    expect(autoSplitOT(7.6)).toEqual({ ordinary: 7.6, overtime: 0 });
    expect(autoSplitOT(8)).toEqual({ ordinary: 8, overtime: 0 });
    expect(autoSplitOT(10)).toEqual({ ordinary: 8, overtime: 2 });
    expect(autoSplitOT(8.25)).toEqual({ ordinary: 8, overtime: 0.25 });
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

  it("worker can edit drafts and rejected entries", () => {
    expect(canEdit("draft")).toBe(true);
    expect(canEdit("rejected")).toBe(true);
  });

  it("worker cannot edit submitted or approved entries", () => {
    expect(canEdit("submitted")).toBe(false);
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
  it("auto-splits overtime above 8 hours", () => {
    const payload = buildCustomHoursPayload({ date: "2026-05-04", jobId: "j", totalHours: 10 });
    expect(payload.totalHours).toBe(10);
    expect(payload.ordinaryHours).toBe(8);
    expect(payload.overtimeHours).toBe(2);
    expect(payload.allocations[0]?.hours).toBe(10);
  });

  it("validates against the create schema for valid hours", () => {
    const payload = buildCustomHoursPayload({ date: "2026-05-04", jobId: "j", totalHours: 6 });
    expect(CreateTimeEntryPayloadSchema.safeParse(payload).success).toBe(true);
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
