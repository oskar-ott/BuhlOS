import { describe, expect, it } from "vitest";

import {
  buildPhilGreeting,
  firstNameFrom,
  hourInTimeZone,
  partOfDayForHour,
  workerInitials,
} from "./greeting";

describe("partOfDayForHour", () => {
  it("buckets the day per the design mock (Morning <12, Arvo 12–16, Evening ≥17)", () => {
    expect(partOfDayForHour(0)).toBe("Morning");
    expect(partOfDayForHour(5)).toBe("Morning");
    expect(partOfDayForHour(11)).toBe("Morning");
    expect(partOfDayForHour(12)).toBe("Arvo");
    expect(partOfDayForHour(14)).toBe("Arvo"); // the mock's "Arvo, Sam" at 2:48 pm
    expect(partOfDayForHour(16)).toBe("Arvo");
    expect(partOfDayForHour(17)).toBe("Evening");
    expect(partOfDayForHour(23)).toBe("Evening");
  });

  it("falls back to Morning for non-finite hours", () => {
    expect(partOfDayForHour(Number.NaN)).toBe("Morning");
    expect(partOfDayForHour(Number.POSITIVE_INFINITY)).toBe("Morning");
  });
});

describe("firstNameFrom", () => {
  it("takes the first whitespace token, as stored", () => {
    expect(firstNameFrom("Sam Patel")).toBe("Sam");
    expect(firstNameFrom("  Sam   Patel  ")).toBe("Sam");
    expect(firstNameFrom("Sam")).toBe("Sam");
    // Never re-cased: a lowercase login handle renders as stored.
    expect(firstNameFrom("sam")).toBe("sam");
  });

  it("returns null for missing/blank names", () => {
    expect(firstNameFrom(null)).toBeNull();
    expect(firstNameFrom(undefined)).toBeNull();
    expect(firstNameFrom("")).toBeNull();
    expect(firstNameFrom("   ")).toBeNull();
  });
});

describe("workerInitials", () => {
  it("uses first + last token initials for multi-token names", () => {
    expect(workerInitials("Sam Patel")).toBe("SP");
    expect(workerInitials("Sam van der Berg")).toBe("SB");
  });

  it("uses the first two characters of a single-token name", () => {
    expect(workerInitials("Sam")).toBe("SA");
    expect(workerInitials("s")).toBe("S");
  });

  it("returns null for missing/blank names", () => {
    expect(workerInitials(null)).toBeNull();
    expect(workerInitials(undefined)).toBeNull();
    expect(workerInitials("   ")).toBeNull();
  });
});

describe("hourInTimeZone", () => {
  it("computes the hour in the requested timezone", () => {
    // 2026-06-12T04:48:00Z = 14:48 in Sydney (AEST, UTC+10, no DST in June).
    const date = new Date("2026-06-12T04:48:00Z");
    expect(hourInTimeZone(date, "Australia/Sydney")).toBe(14);
    expect(hourInTimeZone(date, "UTC")).toBe(4);
  });

  it("normalises midnight to 0 (never 24)", () => {
    // 2026-06-11T14:00:00Z = exactly midnight in Sydney.
    const midnight = new Date("2026-06-11T14:00:00Z");
    expect(hourInTimeZone(midnight, "Australia/Sydney")).toBe(0);
  });
});

describe("buildPhilGreeting", () => {
  it("composes the mock's header: greeting + date · job + initials", () => {
    expect(
      buildPhilGreeting({
        displayName: "Sam Patel",
        hour: 14,
        dateLabel: "Fri 12 Jun",
        soleJobName: "Birdwood Estate",
      })
    ).toEqual({
      heading: "Arvo, Sam",
      subtitle: "Fri 12 Jun · on Birdwood Estate",
      initials: "SP",
    });
  });

  it("degrades to the impersonal greeting when no name is known — never a placeholder", () => {
    expect(
      buildPhilGreeting({
        displayName: null,
        hour: 9,
        dateLabel: "Fri 12 Jun",
        soleJobName: null,
      })
    ).toEqual({
      heading: "Morning",
      subtitle: "Fri 12 Jun",
      initials: null,
    });
  });

  it('omits the "on {job}" tail unless there is exactly one assigned job', () => {
    const greeting = buildPhilGreeting({
      displayName: "Sam Patel",
      hour: 18,
      dateLabel: "Fri 12 Jun",
      soleJobName: null,
    });
    expect(greeting.heading).toBe("Evening, Sam");
    expect(greeting.subtitle).toBe("Fri 12 Jun");
  });
});
