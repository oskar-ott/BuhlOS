import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { WORK_PLACES, isWorkPlaceId, withWorkPlaces, workPlaceName } from "./work-places";
import { defaultJobId, entryTarget, receiptLine, soleJobId, type HoursJob } from "./hours-view";
import { buildWeeklyHoursCloseout } from "./weekly-closeout";
import type { TimeEntry } from "./types";

/**
 * Office and Workshop (owner pull 2026-11-06): two places hours can be logged
 * to that are not jobs, picked and split like a job. These pins hold the
 * client and server twins together and walk the id through every rule that
 * would otherwise refuse it, drop it from Postgres, or name it "place:office".
 */

const requireFromHere = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-require-imports */
const server = requireFromHere("../../../api/_lib/work-places.js") as {
  WORK_PLACES: ReadonlyArray<{ id: string; name: string }>;
  isWorkPlaceId: (id: unknown) => boolean;
  workPlaceName: (id: unknown) => string | null;
};
const entriesLib = requireFromHere("../../../api/_lib/time-entries.js") as {
  inactiveJobAllocationError: (
    allocations: Array<{ jobId: string | null; hours: number }>
  ) => Promise<string | null>;
};
const allocPg = requireFromHere("../../../api/_lib/alloc-pg.js") as {
  buildAllocationRows: (input: {
    records: Array<{ userId: string; date: string; entry: unknown }>;
    userMap: Map<string, string>;
    jobMap: Map<string, string>;
    timeEntryMap: Map<string, string>;
  }) => {
    byEntry: Array<{ rows: Array<{ job_id: string | null; hours: number }> }>;
    quarantine: Array<{ reason: string }>;
  };
};
const myRecord = requireFromHere("../../../api/_lib/my-record.js") as {
  buildMyRecord: (
    entries: unknown[],
    opts: { todayIso: string; jobNameById?: Record<string, string> }
  ) => { jobs: Array<{ jobId: string; jobName: string; hours: number }> };
};
/* eslint-enable @typescript-eslint/no-require-imports */

const OFFICE = "place:office";
const WORKSHOP = "place:workshop";

describe("the two places", () => {
  it("are Office and Workshop, identical on client and server", () => {
    expect(WORK_PLACES.map((p) => [p.id, p.name])).toEqual([
      [OFFICE, "Office"],
      [WORKSHOP, "Workshop"],
    ]);
    expect(server.WORK_PLACES.map((p) => [p.id, p.name])).toEqual(
      WORK_PLACES.map((p) => [p.id, p.name])
    );
  });

  it("names a place id and nothing else", () => {
    for (const fn of [workPlaceName, server.workPlaceName]) {
      expect(fn(OFFICE)).toBe("Office");
      expect(fn(WORKSHOP)).toBe("Workshop");
      expect(fn("smith-st")).toBeNull();
      expect(fn(null)).toBeNull();
      expect(fn("toString")).toBeNull();
    }
    expect(isWorkPlaceId("office")).toBe(false);
    expect(server.isWorkPlaceId("place:office")).toBe(true);
  });

  it("follows the worker's jobs, never doubled", () => {
    const jobs: HoursJob[] = [{ id: "smith-st", name: "Smith St" }];
    expect(withWorkPlaces(jobs).map((j) => j.id)).toEqual(["smith-st", OFFICE, WORKSHOP]);
    expect(withWorkPlaces(withWorkPlaces(jobs)).map((j) => j.id)).toEqual([
      "smith-st",
      OFFICE,
      WORKSHOP,
    ]);
    expect(withWorkPlaces([]).map((j) => j.id)).toEqual([OFFICE, WORKSHOP]);
  });
});

describe("the worker's Hours screen", () => {
  const jobs = withWorkPlaces([{ id: "smith-st", name: "Smith St" }]);

  it("still picks a worker's only job by itself — the places don't count", () => {
    expect(soleJobId(jobs)).toBe("smith-st");
    expect(defaultJobId({ picked: null, lastJobId: null, jobs })).toBe("smith-st");
    expect(soleJobId(withWorkPlaces([]))).toBeNull();
  });

  it("remembers Workshop as the last pick like any job", () => {
    expect(defaultJobId({ picked: null, lastJobId: WORKSHOP, jobs })).toBe(WORKSHOP);
  });

  it("names a place day and a split day in the worker's words", () => {
    const whole = { dayType: null, allocations: [{ jobId: OFFICE, hours: 7.6 }] };
    expect(entryTarget(whole, [])).toBe("Office");
    const split = {
      date: "2026-11-05",
      dayType: null,
      totalHours: 7.6,
      ordinaryHours: 7.6,
      overtimeHours: 0,
      allocations: [
        { jobId: WORKSHOP, hours: 4 },
        { jobId: "smith-st", hours: 3.6 },
      ],
    };
    expect(receiptLine(split, jobs)).toBe("Thu 5 Nov · Workshop 4h + Smith St 3h 36m · 7h 36m total");
  });
});

describe("the server", () => {
  it("lets Office / Workshop through the live-job check without reading jobs", async () => {
    await expect(
      entriesLib.inactiveJobAllocationError([
        { jobId: OFFICE, hours: 4 },
        { jobId: WORKSHOP, hours: 3.6 },
      ])
    ).resolves.toBeNull();
  });

  it("mirrors a place to Postgres as no job instead of quarantining the day", () => {
    const out = allocPg.buildAllocationRows({
      records: [
        {
          userId: "u1",
          date: "2026-11-05",
          entry: {
            totalHours: 7.6,
            allocations: [
              { jobId: WORKSHOP, hours: 4 },
              { jobId: "smith-st", hours: 3.6 },
            ],
          },
        },
      ],
      userMap: new Map([["u1", "uu1"]]),
      jobMap: new Map([["smith-st", "jj1"]]),
      timeEntryMap: new Map([["uu1|2026-11-05", "te1"]]),
    });
    expect(out.quarantine).toEqual([]);
    expect(out.byEntry[0]!.rows.map((r) => [r.job_id, r.hours])).toEqual([
      [null, 4],
      ["jj1", 3.6],
    ]);
  });

  it("names Workshop on the worker's record", () => {
    const rec = myRecord.buildMyRecord(
      [
        {
          date: "2026-11-05",
          status: "submitted",
          totalHours: 7.6,
          allocations: [{ jobId: WORKSHOP, hours: 7.6 }],
        },
      ],
      { todayIso: "2026-11-06" }
    );
    expect(rec.jobs).toEqual([expect.objectContaining({ jobId: WORKSHOP, jobName: "Workshop" })]);
  });
});

describe("the office's weekly closeout", () => {
  it("names a place day even when the entry wasn't enriched", () => {
    const entry = {
      id: "e1",
      userId: "u1",
      userName: "Sam",
      userRole: "field",
      date: "2026-11-05",
      totalHours: 7.6,
      ordinaryHours: 7.6,
      overtimeHours: 0,
      status: "submitted",
      allocations: [{ jobId: OFFICE, hours: 7.6 }],
      createdAt: "2026-11-05T08:00:00Z",
      updatedAt: "2026-11-05T08:00:00Z",
    } as TimeEntry;
    const out = buildWeeklyHoursCloseout({
      entries: [entry],
      missing: [],
      weekStart: "2026-11-02",
      todayISO: "2026-11-06",
    });
    const day = out.workers[0]!.days.find((d) => d.date === "2026-11-05")!;
    expect(day.jobLabel).toBe("Office");
  });
});
