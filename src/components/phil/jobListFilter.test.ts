import { describe, expect, it } from "vitest";
import { filterJobList } from "./jobListFilter";

const JOBS = [
  { id: "a", name: "Birdwood Estate", code: "IV0041", siteAddress: "12 Birdwood Rd" },
  { id: "b", name: "Sansara Fitout", ref: "SAN-22", siteAddress: "4 King William St" },
  { id: "c", name: "DCA Warehouse" },
];

describe("filterJobList", () => {
  it("empty / whitespace query returns every job in the incoming order", () => {
    expect(filterJobList(JOBS, "").map((j) => j.id)).toEqual(["a", "b", "c"]);
    expect(filterJobList(JOBS, "   ").map((j) => j.id)).toEqual(["a", "b", "c"]);
  });

  it("matches name, code, legacy ref, and address — case-insensitive", () => {
    expect(filterJobList(JOBS, "birdwood").map((j) => j.id)).toEqual(["a"]);
    expect(filterJobList(JOBS, "iv0041").map((j) => j.id)).toEqual(["a"]);
    expect(filterJobList(JOBS, "san-22").map((j) => j.id)).toEqual(["b"]);
    expect(filterJobList(JOBS, "king william").map((j) => j.id)).toEqual(["b"]);
  });

  it("every token must match somewhere (AND), so a wrong token drops the job", () => {
    expect(filterJobList(JOBS, "birdwood 12").map((j) => j.id)).toEqual(["a"]);
    expect(filterJobList(JOBS, "birdwood king").map((j) => j.id)).toEqual([]);
  });

  it("preserves the incoming (recency) order among matches", () => {
    // Both Birdwood and Sansara contain an "a" — order stays as given.
    expect(filterJobList(JOBS, "a").map((j) => j.id)).toEqual(["a", "b", "c"]);
  });

  it("jobs missing optional fields never throw and simply don't match on them", () => {
    expect(filterJobList(JOBS, "warehouse").map((j) => j.id)).toEqual(["c"]);
    expect(filterJobList(JOBS, "zzz")).toEqual([]);
  });
});
