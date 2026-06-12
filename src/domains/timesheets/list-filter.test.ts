import { describe, expect, it } from "vitest";
import {
  HOURS_FILTER_STATUSES,
  buildPersonOptions,
  filterTimeEntries,
  hoursEmptyStateMessage,
  isHoursFilterStatus,
  isPersonParam,
  parseHoursFilterParams,
  personDisplayName,
} from "./list-filter";
import type { TimeEntry } from "./types";

/**
 * Pure filter matrix for the /hours overview (#216): status + person over
 * the already-loaded approver queues, bounded to the viewed week so the
 * filters compose with ?week= navigation.
 */

function entry(
  id: string,
  over: Partial<TimeEntry> & Pick<TimeEntry, "userId" | "date" | "status">
): TimeEntry {
  return {
    id,
    userName: null,
    totalHours: 8,
    ordinaryHours: 8,
    overtimeHours: 0,
    allocations: [{ jobId: "j1", jobName: "Smith St", hours: 8 }],
    ...over,
  } as unknown as TimeEntry;
}

const WEEK = { fromDate: "2026-06-08", toDate: "2026-06-14" };

const ENTRIES: ReadonlyArray<TimeEntry> = [
  entry("e1", { userId: "u-ben", userName: "Ben", date: "2026-06-08", status: "submitted" }),
  entry("e2", { userId: "u-ben", userName: "Ben", date: "2026-06-10", status: "submitted" }),
  entry("e3", { userId: "u-sam", userName: "Sam", date: "2026-06-09", status: "submitted" }),
  entry("e4", { userId: "u-ben", userName: "Ben", date: "2026-06-01", status: "submitted" }), // prior week
  entry("e5", { userId: "u-ben", userName: "Ben", date: "2026-06-15", status: "submitted" }), // next week
];

describe("isHoursFilterStatus / parseHoursFilterParams", () => {
  it("accepts exactly the three loaded queue statuses", () => {
    expect(HOURS_FILTER_STATUSES).toEqual(["submitted", "approved", "rejected"]);
    for (const s of HOURS_FILTER_STATUSES) expect(isHoursFilterStatus(s)).toBe(true);
  });

  it("rejects draft — a real status, but not a loaded queue", () => {
    expect(isHoursFilterStatus("draft")).toBe(false);
    expect(parseHoursFilterParams({ status: "draft" }).status).toBeNull();
  });

  it("degrades unknown status and blank/absurd person to null", () => {
    expect(parseHoursFilterParams({ status: "bogus" }).status).toBeNull();
    expect(parseHoursFilterParams({ person: "   " }).person).toBeNull();
    expect(parseHoursFilterParams({ person: "x".repeat(201) }).person).toBeNull();
    expect(isPersonParam("")).toBe(false);
  });

  it("passes through valid values", () => {
    expect(parseHoursFilterParams({ status: "approved", person: "u-ben" })).toEqual({
      status: "approved",
      person: "u-ben",
    });
    expect(parseHoursFilterParams({})).toEqual({ status: null, person: null });
  });
});

describe("filterTimeEntries", () => {
  it("filters by person within the week, most recent first", () => {
    const out = filterTimeEntries(ENTRIES, { status: null, person: "u-ben" }, WEEK);
    expect(out.map((e) => e.id)).toEqual(["e2", "e1"]);
  });

  it("filters by status", () => {
    const mixed = [
      ...ENTRIES,
      entry("e6", { userId: "u-sam", date: "2026-06-11", status: "approved" }),
    ];
    const out = filterTimeEntries(mixed, { status: "approved", person: null }, WEEK);
    expect(out.map((e) => e.id)).toEqual(["e6"]);
  });

  it("bounds to the week inclusively on both edges", () => {
    const out = filterTimeEntries(ENTRIES, { status: null, person: null }, WEEK);
    expect(out.map((e) => e.id)).toEqual(["e2", "e3", "e1"]);
    const edge = filterTimeEntries(
      [entry("eA", { userId: "u", date: "2026-06-14", status: "submitted" })],
      { status: null, person: null },
      WEEK
    );
    expect(edge).toHaveLength(1);
  });

  it("returns everything matching when no range is given, without mutating input", () => {
    const input = [...ENTRIES];
    const out = filterTimeEntries(input, { status: null, person: "u-ben" });
    expect(out).toHaveLength(4);
    expect(input.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4", "e5"]);
  });
});

describe("buildPersonOptions", () => {
  it("unions sources, de-dupes by id, prefers the first non-empty name, sorts by name", () => {
    const options = buildPersonOptions([
      [{ userId: "u-sam", userName: "Sam" }],
      [
        { userId: "u-ben", userName: "" },
        { userId: "u-sam", userName: "Samuel" }, // already named — first wins
      ],
      [{ userId: "u-ben", userName: "Ben" }], // fills the empty name in
    ]);
    expect(options).toEqual([
      { id: "u-ben", name: "Ben" },
      { id: "u-sam", name: "Sam" },
    ]);
  });

  it("falls back to the id when no source carries a name", () => {
    expect(buildPersonOptions([[{ userId: "u-1", userName: null }]])).toEqual([
      { id: "u-1", name: "u-1" },
    ]);
  });

  it("skips rows without a userId", () => {
    expect(buildPersonOptions([[{ userId: "", userName: "Ghost" }]])).toEqual([]);
  });
});

describe("personDisplayName", () => {
  const options = [{ id: "u-ben", name: "Ben" }];
  it("resolves a known id", () => {
    expect(personDisplayName("u-ben", options)).toBe("Ben");
  });
  it("stays honest for an unknown id (disabled worker, foreign link)", () => {
    expect(personDisplayName("u-gone", options)).toBe("the selected person");
  });
});

describe("hoursEmptyStateMessage", () => {
  it("names status + person + week", () => {
    expect(
      hoursEmptyStateMessage({ status: "submitted", person: "u-ben" }, "Ben", "this week")
    ).toBe("No submitted entries for Ben this week.");
  });

  it("names the person alone", () => {
    expect(
      hoursEmptyStateMessage(
        { status: null, person: "u-ben" },
        "Ben",
        "in the week of Mon 1 Jun 2026"
      )
    ).toBe("No entries for Ben in the week of Mon 1 Jun 2026.");
  });

  it("names the status alone", () => {
    expect(
      hoursEmptyStateMessage({ status: "rejected", person: null }, null, "this week")
    ).toBe("No rejected entries this week.");
  });
});
