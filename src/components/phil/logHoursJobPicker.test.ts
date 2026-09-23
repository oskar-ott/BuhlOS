import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

import { jobDialRows, savedEntryTarget } from "./LogHoursSheet";

/**
 * The log sheet's job picker rows + the saved-entry receipt target
 * (2026-09-23 usability audit). A job search used to leave the pinned
 * "Sick day" row in the dial's band — a tap there logged sick leave instead of
 * the job. And the receipt named neither day nor job, so a wrong pick was
 * only caught by the office.
 */
const jobs = [
  { id: "bw", name: "Birdwood Park Clubhouse", ref: "IV2041", address: "12 Birdwood Rd, Kellyville" },
  { id: "sr", name: "Smith Residence Rewire", ref: "IV2055", address: "4 Oak St, Baulkham Hills" },
  { id: "ss", name: "Smith St Shopfit", ref: "IV2060", address: "88 Smith St, Parramatta" },
];
const dayTypes = [
  { id: "daytype:sick", label: "Sick day" },
  { id: "daytype:holiday", label: "Holiday" },
];

describe("jobDialRows", () => {
  it("unsearched: day types on top (easy to find), then every job", () => {
    const { rows, jobMatches } = jobDialRows(jobs, dayTypes, "");
    expect(rows.map((r) => r.id)).toEqual(["daytype:sick", "daytype:holiday", "bw", "sr", "ss"]);
    expect(jobMatches).toBe(3);
  });

  it("a job search shows ONLY matching jobs — no day type left in the band", () => {
    const { rows } = jobDialRows(jobs, dayTypes, "castle");
    expect(rows).toEqual([]);
    const smith = jobDialRows(jobs, dayTypes, "smith");
    expect(smith.rows.map((r) => r.id)).toEqual(["sr", "ss"]);
    expect(smith.rows[0]!.id.startsWith("daytype:")).toBe(false);
  });

  it("matches the IV number and the street, not just the name", () => {
    expect(jobDialRows(jobs, dayTypes, "iv2060").rows.map((r) => r.id)).toEqual(["ss"]);
    expect(jobDialRows(jobs, dayTypes, "oak st").rows.map((r) => r.id)).toEqual(["sr"]);
  });

  it("a day type still shows when the worker searches for it — after any job", () => {
    expect(jobDialRows(jobs, dayTypes, "sick").rows.map((r) => r.id)).toEqual(["daytype:sick"]);
  });
});

describe("savedEntryTarget", () => {
  it("names the job(s) the hours landed on", () => {
    expect(savedEntryTarget({ dayType: null, allocations: [{ jobId: "sr", hours: 7.6 }] } as never, jobs)).toBe(
      "Smith Residence Rewire"
    );
    expect(
      savedEntryTarget(
        { dayType: null, allocations: [{ jobId: "sr", hours: 4 }, { jobId: "ss", hours: 3.6 }] } as never,
        jobs
      )
    ).toBe("Smith Residence Rewire + Smith St Shopfit");
  });

  it("names a day type in the worker's words", () => {
    expect(savedEntryTarget({ dayType: "sick", allocations: [] } as never, jobs)).toBe("Sick day");
  });

  it("never guesses a name for an unknown job", () => {
    expect(savedEntryTarget({ dayType: null, allocations: [{ jobId: "gone", hours: 7.6 }] } as never, jobs)).toBeNull();
  });
});
