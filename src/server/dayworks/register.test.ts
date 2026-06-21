import { describe, expect, it } from "vitest";
import {
  loadJobDayworkRegister,
  loadDayworkRollup,
  type DayworkRegisterDeps,
} from "./register";
import type { Daywork } from "@/domains/dayworks/types";

const NOW = Date.parse("2026-06-21T00:00:00.000Z");
const dayAgo = (d: number) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();

function docket(over: Partial<Daywork>): Daywork {
  return {
    id: "dw",
    jobId: "job-1",
    ref: "DW-001",
    seq: 1,
    date: "2026-06-20",
    description: "x",
    labourLines: [],
    materialLines: [],
    photoIds: [],
    status: "unsigned",
    signature: null,
    linkedTimeEntryIds: [],
    createdById: "u1",
    createdByName: "U",
    createdAt: dayAgo(0),
    auditLogIds: [],
    ...over,
  } as Daywork;
}

function depsFrom(map: Record<string, Daywork[]>): DayworkRegisterDeps {
  return { readDockets: async (jobId: string) => map[jobId] ?? [] };
}

describe("loadJobDayworkRegister", () => {
  it("orders aging-unsigned first and computes the payment-risk summary", async () => {
    const deps = depsFrom({
      "job-1": [
        docket({ id: "fresh", ref: "DW-002", seq: 2, status: "unsigned", createdAt: dayAgo(0) }),
        docket({ id: "old", ref: "DW-001", seq: 1, status: "unsigned", createdAt: dayAgo(3) }),
        docket({ id: "signed", ref: "DW-003", seq: 3, status: "signed", createdAt: dayAgo(5) }),
      ],
    });
    const reg = await loadJobDayworkRegister(deps, "job-1", NOW);
    expect(reg.dockets[0]!.id).toBe("old"); // aging unsigned sits on top
    expect(reg.summary.total).toBe(3);
    expect(reg.summary.unsigned).toBe(2);
    expect(reg.summary.signed).toBe(1);
    expect(reg.summary.unsignedAging).toBe(1);
  });

  it("is empty when a job has no dockets", async () => {
    const reg = await loadJobDayworkRegister(depsFrom({}), "job-x", NOW);
    expect(reg.dockets).toHaveLength(0);
    expect(reg.summary.total).toBe(0);
  });
});

describe("loadDayworkRollup", () => {
  it("aggregates non-archived jobs, orders byJob payment-risk-first, skips empty + archived", async () => {
    const deps = depsFrom({
      "job-1": [docket({ id: "a", jobId: "job-1", status: "invoiced", createdAt: dayAgo(10) })],
      "job-2": [
        docket({ id: "b", jobId: "job-2", status: "unsigned", createdAt: dayAgo(3) }), // aging
        docket({ id: "c", jobId: "job-2", status: "signed", createdAt: dayAgo(3) }),
      ],
      "job-3": [docket({ id: "z", jobId: "job-3" })], // archived → skipped
      "job-4": [], // empty → skipped
    });
    const jobs = [
      { id: "job-1", name: "One" },
      { id: "job-2", name: "Two" },
      { id: "job-3", name: "Archived", archived: true },
      { id: "job-4", name: "Empty" },
    ];
    const rollup = await loadDayworkRollup(deps, jobs, NOW);
    expect(rollup.summary.total).toBe(3); // job-1 (1) + job-2 (2); job-3/4 excluded
    expect(rollup.summary.unsignedAging).toBe(1);
    expect(rollup.byJob.map((r) => r.jobId)).toEqual(["job-2", "job-1"]); // aging first
    expect(rollup.byJob.find((r) => r.jobId === "job-3")).toBeUndefined();
    expect(rollup.byJob.find((r) => r.jobId === "job-4")).toBeUndefined();
  });
});
