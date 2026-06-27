import { describe, expect, it } from "vitest";
import {
  EMPTY_OBSERVATION_FILTERS,
  matchesObservationFilter,
  type ObservationFilters,
} from "./observation-filter";
import type { ObservationItem } from "@/domains/observations/types";

/**
 * Vitest unit tests for the pure predicate behind the office Observations
 * Inbox (#260). Mirrors evidence-filter.test.ts — the inbox renders via
 * renderToString smoke; the AND-combine matrix is covered here.
 */

const baseObs: ObservationItem = {
  id: "ob_1",
  jobId: "birdwood-iv3232",
  jobName: "Birdwood IV",
  type: "blocker",
  title: "Cable path blocked",
  description: null,
  status: "new",
  priority: "high",
  source: "phil",
  requiresAction: true,
  photoUrls: [],
  createdById: "u_field",
  createdByName: "Sparky",
  createdAt: "2026-05-20T08:00:00.000Z",
  updatedAt: "2026-05-20T08:00:00.000Z",
} as ObservationItem;

describe("EMPTY_OBSERVATION_FILTERS", () => {
  it("has every axis empty", () => {
    expect(EMPTY_OBSERVATION_FILTERS.status).toBe("");
    expect(EMPTY_OBSERVATION_FILTERS.createdById).toBe("");
    expect(EMPTY_OBSERVATION_FILTERS.fromDate).toBe("");
    expect(EMPTY_OBSERVATION_FILTERS.toDate).toBe("");
  });
});

describe("matchesObservationFilter — existing axes", () => {
  it("matches everything with empty filters", () => {
    expect(matchesObservationFilter(baseObs, EMPTY_OBSERVATION_FILTERS)).toBe(true);
  });

  it("filters by status / type / priority / job / source", () => {
    expect(
      matchesObservationFilter(baseObs, { ...EMPTY_OBSERVATION_FILTERS, status: "needs_action" })
    ).toBe(false);
    expect(
      matchesObservationFilter(baseObs, { ...EMPTY_OBSERVATION_FILTERS, type: "defect" })
    ).toBe(false);
    expect(
      matchesObservationFilter(baseObs, { ...EMPTY_OBSERVATION_FILTERS, priority: "low" })
    ).toBe(false);
    expect(
      matchesObservationFilter(baseObs, { ...EMPTY_OBSERVATION_FILTERS, jobId: "other-job" })
    ).toBe(false);
    expect(
      matchesObservationFilter(baseObs, { ...EMPTY_OBSERVATION_FILTERS, source: "buhlos" })
    ).toBe(false);
  });
});

describe("matchesObservationFilter — createdById (#260)", () => {
  it("matches anyone when empty", () => {
    expect(matchesObservationFilter(baseObs, EMPTY_OBSERVATION_FILTERS)).toBe(true);
  });

  it("matches only the chosen raiser", () => {
    const f: ObservationFilters = { ...EMPTY_OBSERVATION_FILTERS, createdById: "u_field" };
    expect(matchesObservationFilter(baseObs, f)).toBe(true);
    expect(
      matchesObservationFilter({ ...baseObs, createdById: "u_other" }, f)
    ).toBe(false);
  });
});

describe("matchesObservationFilter — date range (#260)", () => {
  it("excludes rows created before fromDate", () => {
    const f: ObservationFilters = { ...EMPTY_OBSERVATION_FILTERS, fromDate: "2026-05-21" };
    expect(matchesObservationFilter(baseObs, f)).toBe(false);
  });

  it("includes rows on the fromDate boundary", () => {
    const f: ObservationFilters = { ...EMPTY_OBSERVATION_FILTERS, fromDate: "2026-05-20" };
    expect(matchesObservationFilter(baseObs, f)).toBe(true);
  });

  it("excludes rows created after toDate", () => {
    const f: ObservationFilters = { ...EMPTY_OBSERVATION_FILTERS, toDate: "2026-05-19" };
    expect(matchesObservationFilter(baseObs, f)).toBe(false);
  });

  it("includes rows on the toDate boundary", () => {
    const f: ObservationFilters = { ...EMPTY_OBSERVATION_FILTERS, toDate: "2026-05-20" };
    expect(matchesObservationFilter(baseObs, f)).toBe(true);
  });

  it("respects both bounds together", () => {
    const f: ObservationFilters = {
      ...EMPTY_OBSERVATION_FILTERS,
      fromDate: "2026-05-15",
      toDate: "2026-05-25",
    };
    expect(matchesObservationFilter(baseObs, f)).toBe(true);
    expect(
      matchesObservationFilter({ ...baseObs, createdAt: "2026-06-01T00:00:00Z" }, f)
    ).toBe(false);
  });
});

describe("matchesObservationFilter — combined", () => {
  it("AND-combines raised-by with date and the existing axes", () => {
    const f: ObservationFilters = {
      ...EMPTY_OBSERVATION_FILTERS,
      createdById: "u_field",
      fromDate: "2026-05-20",
      toDate: "2026-05-20",
      status: "new",
    };
    expect(matchesObservationFilter(baseObs, f)).toBe(true);
    // Wrong raiser fails even though date + status pass.
    expect(matchesObservationFilter({ ...baseObs, createdById: "u_x" }, f)).toBe(false);
  });
});
