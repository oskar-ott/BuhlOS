import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILTER,
  matchesFilter,
  type FilterState,
} from "./EvidenceFilterBar";
import type { EvidenceItem } from "@/domains/evidence/types";

/**
 * Vitest unit tests for the pure filter predicate behind the D4
 * evidence queue. The filter bar component itself is exercised via
 * Playwright (no jsdom/RTL setup in this repo); matchesFilter is a
 * straight function so we cover the matrix here.
 *
 * Tests run in node env (vitest.config.ts default), so we import the
 * pure helper from the component file directly — Tailwind / JSX
 * isn't evaluated for these named exports.
 */

const baseItem: EvidenceItem = {
  id: "ev_1",
  jobId: "birdwood-iv3232",
  areaId: null,
  stage: null,
  taskId: null,
  kind: "note",
  photoId: null,
  photoUrl: null,
  thumbnailUrl: null,
  note: "Cabling looks good",
  capturedById: "user-tradie-1",
  capturedByName: "Sam",
  capturedByRole: "tradie",
  capturedAt: "2026-05-25T14:30:00.000Z",
  clientCapturedAt: null,
  exifLocation: null,
  status: "submitted",
  source: "phil",
  reviewedById: null,
  reviewedByName: null,
  reviewedAt: null,
  rejectionReason: null,
  auditLogIds: [],
  createdAt: "2026-05-25T14:30:00.000Z",
  updatedAt: "2026-05-25T14:30:00.000Z",
};

const attachedItem: EvidenceItem = {
  ...baseItem,
  id: "ev_2",
  areaId: "ar_abc",
  stage: "roughIn",
  taskId: "rt_xyz",
};

describe("DEFAULT_FILTER", () => {
  it("defaults to status=submitted with no other filters", () => {
    expect(DEFAULT_FILTER.status).toBe("submitted");
    expect(DEFAULT_FILTER.capturedById).toBeNull();
    expect(DEFAULT_FILTER.unattachedOnly).toBe(false);
    expect(DEFAULT_FILTER.fromDate).toBeNull();
    expect(DEFAULT_FILTER.toDate).toBeNull();
  });
});

describe("matchesFilter — status", () => {
  it("matches when status=all", () => {
    const f: FilterState = { ...DEFAULT_FILTER, status: "all" };
    expect(matchesFilter(baseItem, f)).toBe(true);
    expect(matchesFilter({ ...baseItem, status: "reviewed" }, f)).toBe(true);
    expect(matchesFilter({ ...baseItem, status: "rejected" }, f)).toBe(true);
  });

  it("matches only the chosen status when not all", () => {
    expect(matchesFilter(baseItem, DEFAULT_FILTER)).toBe(true);
    expect(matchesFilter({ ...baseItem, status: "reviewed" }, DEFAULT_FILTER)).toBe(false);
    expect(matchesFilter({ ...baseItem, status: "rejected" }, DEFAULT_FILTER)).toBe(false);
  });
});

describe("matchesFilter — capturedById", () => {
  it("matches when no capturedBy filter set", () => {
    expect(matchesFilter(baseItem, DEFAULT_FILTER)).toBe(true);
  });

  it("matches only when capturedById equals", () => {
    const f: FilterState = { ...DEFAULT_FILTER, capturedById: "user-tradie-1" };
    expect(matchesFilter(baseItem, f)).toBe(true);
    expect(
      matchesFilter({ ...baseItem, capturedById: "user-tradie-2" }, f)
    ).toBe(false);
  });
});

describe("matchesFilter — unattachedOnly", () => {
  it("includes unattached items (no stage/area/task) when unattachedOnly=true", () => {
    const f: FilterState = { ...DEFAULT_FILTER, unattachedOnly: true };
    expect(matchesFilter(baseItem, f)).toBe(true);
  });

  it("excludes attached items when unattachedOnly=true", () => {
    const f: FilterState = { ...DEFAULT_FILTER, unattachedOnly: true };
    expect(matchesFilter(attachedItem, f)).toBe(false);
  });

  it("excludes when only area is set (no stage/task)", () => {
    const f: FilterState = { ...DEFAULT_FILTER, unattachedOnly: true };
    expect(matchesFilter({ ...baseItem, areaId: "ar_only" }, f)).toBe(false);
  });
});

describe("matchesFilter — date range", () => {
  it("matches when no date filter set", () => {
    expect(matchesFilter(baseItem, DEFAULT_FILTER)).toBe(true);
  });

  it("excludes items captured before fromDate", () => {
    const f: FilterState = { ...DEFAULT_FILTER, fromDate: "2026-05-26" };
    expect(matchesFilter(baseItem, f)).toBe(false);
  });

  it("includes items captured on the fromDate boundary", () => {
    const f: FilterState = { ...DEFAULT_FILTER, fromDate: "2026-05-25" };
    expect(matchesFilter(baseItem, f)).toBe(true);
  });

  it("excludes items captured after toDate", () => {
    const f: FilterState = { ...DEFAULT_FILTER, toDate: "2026-05-24" };
    expect(matchesFilter(baseItem, f)).toBe(false);
  });

  it("includes items captured on the toDate boundary", () => {
    const f: FilterState = { ...DEFAULT_FILTER, toDate: "2026-05-25" };
    expect(matchesFilter(baseItem, f)).toBe(true);
  });

  it("respects both bounds simultaneously", () => {
    const f: FilterState = {
      ...DEFAULT_FILTER,
      fromDate: "2026-05-20",
      toDate: "2026-05-26",
    };
    expect(matchesFilter(baseItem, f)).toBe(true);
    expect(
      matchesFilter({ ...baseItem, capturedAt: "2026-05-15T00:00:00Z" }, f)
    ).toBe(false);
    expect(
      matchesFilter({ ...baseItem, capturedAt: "2026-05-30T00:00:00Z" }, f)
    ).toBe(false);
  });
});

describe("matchesFilter — combined", () => {
  it("requires all active filters to pass", () => {
    const f: FilterState = {
      status: "submitted",
      capturedById: "user-tradie-1",
      unattachedOnly: false,
      fromDate: "2026-05-25",
      toDate: "2026-05-25",
    };
    expect(matchesFilter(baseItem, f)).toBe(true);
    // Different captured-by fails.
    expect(
      matchesFilter({ ...baseItem, capturedById: "user-other" }, f)
    ).toBe(false);
    // Different status fails.
    expect(matchesFilter({ ...baseItem, status: "reviewed" }, f)).toBe(false);
  });
});
