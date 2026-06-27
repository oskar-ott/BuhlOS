import { describe, expect, it } from "vitest";
import {
  buildAreaOptions,
  DEFAULT_FILTER,
  matchesFilter,
  NO_AREA,
  type FilterState,
} from "./EvidenceFilterBar";
import type { EvidenceItem } from "@/domains/evidence/types";
import type { Job } from "@/domains/jobs/types";

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
    expect(DEFAULT_FILTER.areaId).toBeNull();
    expect(DEFAULT_FILTER.stage).toBeNull();
    expect(DEFAULT_FILTER.taskId).toBeNull();
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

describe("matchesFilter — area context (#260)", () => {
  it("matches any area when areaId is null", () => {
    expect(matchesFilter(attachedItem, DEFAULT_FILTER)).toBe(true);
    expect(matchesFilter(baseItem, DEFAULT_FILTER)).toBe(true);
  });

  it("matches only the chosen areaId when set", () => {
    const f: FilterState = { ...DEFAULT_FILTER, areaId: "ar_abc" };
    expect(matchesFilter(attachedItem, f)).toBe(true);
    expect(matchesFilter({ ...attachedItem, areaId: "ar_other" }, f)).toBe(false);
    // A capture with no area never matches a specific-area filter.
    expect(matchesFilter(baseItem, f)).toBe(false);
  });

  it("NO_AREA matches captures with no area, excludes attached ones", () => {
    const f: FilterState = { ...DEFAULT_FILTER, areaId: NO_AREA };
    expect(matchesFilter(baseItem, f)).toBe(true);
    expect(matchesFilter(attachedItem, f)).toBe(false);
    // A capture with stage+task but no area still counts as "no area".
    expect(
      matchesFilter({ ...baseItem, stage: "roughIn", taskId: "rt_x" }, f)
    ).toBe(true);
  });
});

describe("matchesFilter — stage context (#260)", () => {
  it("matches any stage when null", () => {
    expect(matchesFilter(attachedItem, DEFAULT_FILTER)).toBe(true);
  });

  it("matches only the chosen stage when set", () => {
    const f: FilterState = { ...DEFAULT_FILTER, stage: "roughIn" };
    expect(matchesFilter(attachedItem, f)).toBe(true);
    expect(matchesFilter({ ...attachedItem, stage: "fitOff" }, f)).toBe(false);
    // No stage at all never matches a specific-stage filter.
    expect(matchesFilter(baseItem, f)).toBe(false);
  });
});

describe("matchesFilter — task context (#260)", () => {
  it("matches only the chosen taskId when set", () => {
    const f: FilterState = { ...DEFAULT_FILTER, taskId: "rt_xyz" };
    expect(matchesFilter(attachedItem, f)).toBe(true);
    expect(matchesFilter({ ...attachedItem, taskId: "rt_other" }, f)).toBe(false);
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
      areaId: null,
      stage: null,
      taskId: null,
    };
    expect(matchesFilter(baseItem, f)).toBe(true);
    // Different captured-by fails.
    expect(
      matchesFilter({ ...baseItem, capturedById: "user-other" }, f)
    ).toBe(false);
    // Different status fails.
    expect(matchesFilter({ ...baseItem, status: "reviewed" }, f)).toBe(false);
  });

  it("AND-combines the new context axes with the existing ones", () => {
    const f: FilterState = {
      ...DEFAULT_FILTER,
      areaId: "ar_abc",
      stage: "roughIn",
    };
    // attachedItem is submitted + ar_abc + roughIn → passes both.
    expect(matchesFilter(attachedItem, f)).toBe(true);
    // Right area, wrong stage → fails.
    expect(matchesFilter({ ...attachedItem, stage: "fitOff" }, f)).toBe(false);
    // Right stage, wrong area → fails.
    expect(matchesFilter({ ...attachedItem, areaId: "ar_other" }, f)).toBe(false);
  });
});

describe("buildAreaOptions (#260)", () => {
  const job = {
    id: "j1",
    areaGroups: [
      {
        id: "g1",
        name: "Ground",
        areas: [
          { id: "a1", name: "Kitchen" },
          { id: "a2", name: "Garage" },
        ],
      },
      {
        id: "g_arch",
        name: "Old wing",
        archived: true,
        areas: [{ id: "a_arch", name: "Demolished" }],
      },
    ],
  } as unknown as Job;

  it("lists the visible areas sorted by name", () => {
    const opts = buildAreaOptions(job, []);
    expect(opts.map((o) => o.id)).toEqual(["a2", "a1"]); // Garage, Kitchen
    expect(opts.every((o) => !o.archived)).toBe(true);
  });

  it("adds a referenced-but-archived area, labelled archived", () => {
    const items = [{ areaId: "a_arch" }, { areaId: "a1" }];
    const opts = buildAreaOptions(job, items);
    const arch = opts.find((o) => o.id === "a_arch");
    expect(arch).toBeTruthy();
    expect(arch!.archived).toBe(true);
    // Name resolves from the raw structure even though the group is archived.
    expect(arch!.name).toBe("Demolished");
  });

  it("falls back to the raw id for an unknown referenced area", () => {
    const opts = buildAreaOptions(job, [{ areaId: "ghost" }]);
    const ghost = opts.find((o) => o.id === "ghost");
    expect(ghost).toBeTruthy();
    expect(ghost!.name).toBe("ghost");
    expect(ghost!.archived).toBe(true);
  });

  it("ignores rows with no area", () => {
    const opts = buildAreaOptions(job, [{ areaId: null }]);
    expect(opts.map((o) => o.id)).toEqual(["a2", "a1"]);
  });
});
