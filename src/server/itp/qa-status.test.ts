import { describe, expect, it } from "vitest";
import type { ITPInstance, ITPStatus } from "@/domains/itp/types";
import { blobQaStatusDeps, runQaStatus, type QaStatusDeps } from "./qa-status";

function inst(status: ITPStatus, id = "i1"): ITPInstance {
  return {
    id,
    templateId: "t1",
    templateSnapshot: { templateId: "t1", name: "T", points: [] },
    scope: "job",
    status,
    results: {},
    createdAt: "2026-06-01T00:00:00.000Z",
    createdBy: "u",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...(status === "signed-off" ? { signedOffBy: "b", signedOffAt: "2026-06-02T00:00:00.000Z" } : {}),
  } as unknown as ITPInstance;
}

const NOW = "2026-06-15T00:00:00.000Z";

describe("runQaStatus", () => {
  it("scans active jobs and aggregates into a dashboard", async () => {
    const deps: QaStatusDeps = {
      listActiveJobs: async () => [
        { id: "j1", name: "Job One" },
        { id: "j2", name: "Job Two" },
      ],
      loadInstances: async (jobId) =>
        jobId === "j1" ? [inst("witnessed"), inst("pending", "i2")] : [inst("signed-off")],
    };
    const r = await runQaStatus(deps, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scannedJobs).toBe(2);
    expect(r.failedJobs).toEqual([]);
    expect(r.dashboard.totals).toMatchObject({ jobs: 2, jobsWithItps: 2, instances: 3, awaitingSignOff: 1 });
    // worst-first: the job awaiting sign-off leads
    expect(r.dashboard.rows[0]!.jobId).toBe("j1");
  });

  it("isolates a single job whose blob read fails into failedJobs (never crashes the board)", async () => {
    const deps: QaStatusDeps = {
      listActiveJobs: async () => [
        { id: "ok", name: "OK" },
        { id: "bad", name: "Bad" },
      ],
      loadInstances: async (jobId) => {
        if (jobId === "bad") throw new Error("blob down");
        return [inst("pending")];
      },
    };
    const r = await runQaStatus(deps, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.failedJobs).toEqual(["bad"]);
    expect(r.scannedJobs).toBe(2);
    expect(r.dashboard.rows.map((x) => x.jobId)).toEqual(["ok"]); // bad excluded, not crashed
  });

  it("returns ok:false when listing jobs fails (distinct from an empty board)", async () => {
    const deps: QaStatusDeps = {
      listActiveJobs: async () => {
        throw new Error("jobs.json down");
      },
      loadInstances: async () => [],
    };
    expect(await runQaStatus(deps, NOW)).toEqual({
      ok: false,
      error: "Could not load jobs for the QA dashboard.",
    });
  });

  it("handles zero active jobs as an honest empty board", async () => {
    const deps: QaStatusDeps = { listActiveJobs: async () => [], loadInstances: async () => [] };
    const r = await runQaStatus(deps, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dashboard.rows).toEqual([]);
    expect(r.scannedJobs).toBe(0);
  });
});

describe("blobQaStatusDeps", () => {
  it("exposes a read-only surface (list + load, no writer)", () => {
    const deps = blobQaStatusDeps();
    expect(typeof deps.listActiveJobs).toBe("function");
    expect(typeof deps.loadInstances).toBe("function");
    expect(Object.keys(deps).sort()).toEqual(["listActiveJobs", "loadInstances"]);
  });
});
