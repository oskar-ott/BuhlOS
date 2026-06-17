import { describe, expect, it } from "vitest";
import { ageDays, buildJobQaRollup, buildQaDashboard } from "./qa-rollup";
import type { ITPInstance, ITPStatus } from "./types";

let seq = 0;
function inst(
  status: ITPStatus,
  over: Partial<ITPInstance> & { points?: Array<{ id: string; required?: boolean; archived?: boolean }>; recorded?: string[] } = {},
): ITPInstance {
  const { points = [], recorded = [], id, ...rest } = over;
  const snapPoints = points.map((p) => ({ label: p.id, type: "value", ...p }));
  const results: Record<string, unknown> = {};
  for (const pid of recorded) results[pid] = { byUserId: "u", byUsername: "u", at: "2026-06-02T00:00:00.000Z" };
  return {
    id: id ?? `i_${seq++}`,
    templateId: "t1",
    templateSnapshot: { templateId: "t1", name: "T", points: snapPoints },
    scope: "job",
    status,
    results,
    createdAt: "2026-06-01T00:00:00.000Z",
    createdBy: "u",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...(status === "signed-off" ? { signedOffBy: "boss", signedOffAt: "2026-06-03T00:00:00.000Z" } : {}),
    ...rest,
  } as unknown as ITPInstance;
}

const NOW = "2026-06-15T00:00:00.000Z";

describe("buildJobQaRollup", () => {
  it("counts by status, excludes archived, and sums active open points", () => {
    const r = buildJobQaRollup(
      [
        inst("pending", { points: [{ id: "p1" }, { id: "p2" }], recorded: [] }), // 2 open
        inst("in-progress", { points: [{ id: "p1" }, { id: "p2" }], recorded: ["p1"] }), // 1 open
        inst("witnessed"),
        inst("signed-off"),
        inst("pending", { archived: true, points: [{ id: "p1" }] }), // excluded entirely
      ],
      NOW,
    );
    expect(r.total).toBe(4); // archived excluded
    expect(r.statusCounts).toEqual({ pending: 1, "in-progress": 1, witnessed: 1, "signed-off": 1 });
    expect(r.activeCount).toBe(3); // pending + in-progress + witnessed
    expect(r.awaitingSignOff).toBe(1); // witnessed
    expect(r.openPoints).toBe(3); // 2 + 1 (witnessed has no points; signed-off not active; archived excluded)
  });

  it("oldest active age comes from the oldest ACTIVE instance's timestamp (not signed-off/archived)", () => {
    const r = buildJobQaRollup(
      [
        inst("in-progress", { updatedAt: "2026-06-10T00:00:00.000Z" }),
        inst("pending", { updatedAt: "2026-06-05T00:00:00.000Z" }), // oldest active → 10 days
        inst("signed-off", { updatedAt: "2026-01-01T00:00:00.000Z" }), // older but DONE — ignored
      ],
      NOW,
    );
    expect(r.oldestActiveAt).toBe("2026-06-05T00:00:00.000Z");
    expect(r.oldestActiveAgeDays).toBe(10);
  });

  it("an all-done / empty job reports zeros and a null age (no fabricated activity)", () => {
    expect(buildJobQaRollup([], NOW)).toMatchObject({
      total: 0,
      activeCount: 0,
      awaitingSignOff: 0,
      openPoints: 0,
      oldestActiveAt: null,
      oldestActiveAgeDays: null,
    });
    const allDone = buildJobQaRollup([inst("signed-off")], NOW);
    expect(allDone.total).toBe(1);
    expect(allDone.activeCount).toBe(0);
    expect(allDone.oldestActiveAgeDays).toBeNull();
  });

  it("an active instance with no usable timestamp yields a null age, never a fabricated one", () => {
    const r = buildJobQaRollup([inst("in-progress", { createdAt: "", updatedAt: "" })], NOW);
    expect(r.activeCount).toBe(1);
    expect(r.oldestActiveAt).toBeNull();
    expect(r.oldestActiveAgeDays).toBeNull();
  });

  it("ranks oldest active by parsed instant, not lexical string order (mixed ISO offsets)", () => {
    // The +10:00 stamp is chronologically EARLIER than the Zulu one, but lexically LATER.
    const r = buildJobQaRollup(
      [
        inst("in-progress", { updatedAt: "2026-06-10T00:00:00.000Z" }),
        inst("pending", { updatedAt: "2026-06-10T09:00:00.000+10:00" }), // = 2026-06-09T23:00Z (earlier)
      ],
      NOW,
    );
    expect(r.oldestActiveAt).toBe("2026-06-10T09:00:00.000+10:00");
  });

  it("excludes optional/archived points from open-point counting (matches formatProgress)", () => {
    const r = buildJobQaRollup(
      [inst("pending", { points: [{ id: "p1" }, { id: "p2", required: false }, { id: "p3", archived: true }], recorded: [] })],
      NOW,
    );
    expect(r.openPoints).toBe(1); // only p1 is required+live
  });
});

describe("ageDays", () => {
  it("is whole days, floored, never negative, 0 on unparseable", () => {
    expect(ageDays("2026-06-01T00:00:00.000Z", "2026-06-15T00:00:00.000Z")).toBe(14);
    expect(ageDays("2026-06-20T00:00:00.000Z", NOW)).toBe(0); // future → 0
    expect(ageDays("not-a-date", NOW)).toBe(0);
  });
});

describe("buildQaDashboard", () => {
  function row(jobId: string, jobName: string, instances: ITPInstance[]) {
    return { jobId, jobName, instances };
  }

  it("sorts worst-first (awaiting sign-off, then oldest active age, then name) and totals correctly", () => {
    const d = buildQaDashboard(
      [
        row("j_clear", "Clear job", [inst("signed-off")]),
        row("j_old", "Old job", [inst("in-progress", { updatedAt: "2026-06-01T00:00:00.000Z" })]), // 14d, 0 awaiting
        row("j_await", "Awaiting job", [inst("witnessed", { updatedAt: "2026-06-12T00:00:00.000Z" })]), // 1 awaiting
        row("j_empty", "Empty job", []),
      ],
      NOW,
    );
    // awaiting-sign-off job first; then oldest-active; clear + empty last
    expect(d.rows.map((r) => r.jobId)).toEqual(["j_await", "j_old", "j_clear", "j_empty"]);
    expect(d.totals).toEqual({
      jobs: 4,
      jobsWithItps: 3, // j_empty has none
      instances: 3,
      activeInstances: 2, // in-progress + witnessed
      awaitingSignOff: 1,
      openPoints: 0,
    });
    expect(d.oldestActiveAgeDays).toBe(14); // max active age across jobs
  });

  it("a dashboard of only empty jobs is honest zeros (jobsWithItps 0), not all-clear", () => {
    const d = buildQaDashboard([{ jobId: "j", jobName: "J", instances: [] }], NOW);
    expect(d.totals.jobsWithItps).toBe(0);
    expect(d.rows[0]!.rollup.total).toBe(0);
    expect(d.oldestActiveAgeDays).toBeNull();
  });
});

/* ----------------------------------------------------------------------
 * Submit-for-review lifecycle effect on /qa
 *
 * The explicit submit (in-progress → witnessed) is the moment a job
 * shows up in the office's awaiting-sign-off column. These pin that the
 * rollup reflects the transition: a COMPLETE-but-not-yet-submitted ITP is
 * active with 0 open points yet NOT awaiting sign-off; submitting flips
 * it to awaiting sign-off without re-opening any points.
 * -------------------------------------------------------------------- */

describe("buildJobQaRollup — submit lifecycle", () => {
  const POINTS = [{ id: "p1" }, { id: "p2" }];

  it("a complete in-progress ITP is active + 0 open points but NOT yet awaiting sign-off", () => {
    const r = buildJobQaRollup(
      [inst("in-progress", { points: POINTS, recorded: ["p1", "p2"] })],
      NOW,
    );
    expect(r.activeCount).toBe(1);
    expect(r.openPoints).toBe(0); // all required recorded
    expect(r.awaitingSignOff).toBe(0); // not submitted yet
  });

  it("after submit (now witnessed) it counts as awaiting sign-off with 0 open points", () => {
    const r = buildJobQaRollup(
      [inst("witnessed", { points: POINTS, recorded: ["p1", "p2"] })],
      NOW,
    );
    expect(r.activeCount).toBe(1); // still needs QA attention
    expect(r.awaitingSignOff).toBe(1); // ← the submit moved it here
    expect(r.openPoints).toBe(0);
  });

  it("dashboard totals bump awaiting sign-off by exactly 1 when an ITP is submitted", () => {
    const before = buildQaDashboard(
      [{ jobId: "j1", jobName: "J", instances: [inst("in-progress", { points: POINTS, recorded: ["p1", "p2"] })] }],
      NOW,
    );
    const after = buildQaDashboard(
      [{ jobId: "j1", jobName: "J", instances: [inst("witnessed", { points: POINTS, recorded: ["p1", "p2"] })] }],
      NOW,
    );
    expect(before.totals.awaitingSignOff).toBe(0);
    expect(after.totals.awaitingSignOff).toBe(1);
    expect(after.totals.openPoints).toBe(0);
  });
});
