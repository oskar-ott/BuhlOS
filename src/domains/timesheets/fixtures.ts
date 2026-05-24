import type { TimeEntry } from "./types";

/**
 * Typed fixtures for Storybook / preview / Vitest. NOT used in production —
 * the timesheets domain wires real `/api/time-entries*` responses through
 * `client.ts`. Per ADR-015, fixtures must never silently replace live data;
 * any UI that consumes these intentionally lives behind a DemoModeBanner.
 */

export const SAMPLE_ENTRIES: ReadonlyArray<TimeEntry> = [
  {
    id: "fx-001",
    userId: "u-sam",
    userName: "Sam Tradie",
    userRole: "tradie",
    date: "2026-05-22",
    startTime: null,
    endTime: null,
    breakMinutes: 30,
    totalHours: 7.6,
    ordinaryHours: 7.6,
    overtimeHours: 0,
    otOverridden: false,
    notes: null,
    status: "submitted",
    submittedAt: "2026-05-22T08:00:00.000Z",
    approvedBy: null,
    approvedAt: null,
    rejectedReason: null,
    rejectedAt: null,
    rejectedBy: null,
    allocations: [{ jobId: "job-iv3232", hours: 7.6, notes: null, sortOrder: 0 }],
    createdAt: "2026-05-22T08:00:00.000Z",
    updatedAt: "2026-05-22T08:00:00.000Z",
    enteredByUserId: "u-sam",
    enteredByName: "Sam Tradie",
    source: "self",
  },
];

/**
 * Phase B flips `isDemoMode` to false because the hours surfaces wire real
 * data. The shared `fixtures.isDemoMode()` in src/lib/flags.ts still returns
 * true at the shell level until all surfaces are wired; this per-domain flag
 * lets the hours pages drop the banner on their own routes.
 */
export const timesheetsFixtures = {
  isDemoMode(): boolean {
    return false;
  },
  sample(): ReadonlyArray<TimeEntry> {
    return SAMPLE_ENTRIES;
  },
} as const;
