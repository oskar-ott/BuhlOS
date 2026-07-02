import { describe, it, expect } from "vitest";
import { runRfiScan, type RfiScanDeps } from "./overdue-rfis";
import type { Rfi, RfiStatus } from "@/domains/rfi/schema";

/**
 * #276 chase — the cross-job RFI scan feeding the Command Centre. Pins down:
 * the live-jobs boundary (active + on_hold only), the awaiting-answer filter
 * (open/sent kept, answered/closed dropped), the jobName join, and per-job
 * failure isolation (null register / thrown read → failedJobs, never a crash
 * and never a silently-missing job).
 */

function rfi(over: Partial<Rfi> & { id: string; jobId: string; status: RfiStatus }): Rfi {
  return {
    ref: "RFI-001",
    subject: "Panel location",
    question: "Where does the DB go?",
    askedOf: "builder@example.com",
    responseDue: "2026-06-20",
    sentAt: null,
    answer: "",
    answeredAt: null,
    answeredBy: null,
    closedReason: "",
    observationId: null,
    convertedFromObservationId: null,
    areaId: null,
    planId: null,
    raisedById: "u1",
    raisedByName: "Oskar",
    createdAt: "2026-06-15T00:00:00.000Z",
    updatedAt: "2026-06-15T00:00:00.000Z",
    auditLogIds: [],
    ...over,
  };
}

function deps(byJob: Record<string, Rfi[] | null | (() => never)>): RfiScanDeps {
  return {
    async loadRfis(jobId) {
      const v = byJob[jobId];
      if (typeof v === "function") return v();
      return v === undefined ? [] : v; // an explicit null stays null (unreadable)
    },
  };
}

describe("runRfiScan", () => {
  it("scans only LIVE jobs (active + on_hold) — draft/complete/archived cost nothing", async () => {
    const seen: string[] = [];
    const res = await runRfiScan(
      [
        { id: "j-active", name: "Alpha", status: "active" },
        { id: "j-hold", name: "Bravo", status: "on_hold" },
        { id: "j-draft", name: "Charlie", status: "draft" },
        { id: "j-done", name: "Delta", status: "complete" },
        { id: "j-arch", name: "Echo", status: "archived" },
        { id: "j-none", name: "Foxtrot" }, // no status → not live
      ],
      {
        async loadRfis(jobId) {
          seen.push(jobId);
          return [];
        },
      },
    );
    expect(seen.sort()).toEqual(["j-active", "j-hold"]);
    expect(res.scannedJobs).toBe(2);
    expect(res.failedJobs).toEqual([]);
  });

  it("keeps only RFIs awaiting an answer (open/sent) and joins the job name", async () => {
    const res = await runRfiScan(
      [{ id: "j1", name: "Marriott St", status: "active" }],
      deps({
        j1: [
          rfi({ id: "r-open", jobId: "j1", status: "open" }),
          rfi({ id: "r-sent", jobId: "j1", status: "sent" }),
          rfi({ id: "r-ans", jobId: "j1", status: "answered" }),
          rfi({ id: "r-closed", jobId: "j1", status: "closed" }),
        ],
      }),
    );
    expect(res.rfis.map((r) => r.id).sort()).toEqual(["r-open", "r-sent"]);
    expect(res.rfis.every((r) => r.jobName === "Marriott St")).toBe(true);
  });

  it("falls back to the job id as jobName when the job has no name", async () => {
    const res = await runRfiScan(
      [{ id: "j1", status: "active" }],
      deps({ j1: [rfi({ id: "r1", jobId: "j1", status: "sent" })] }),
    );
    expect(res.rfis[0]!.jobName).toBe("j1");
  });

  it("isolates a per-job failure (null register or thrown read) into failedJobs", async () => {
    const res = await runRfiScan(
      [
        { id: "j-ok", name: "Alpha", status: "active" },
        { id: "j-null", name: "Bravo", status: "active" },
        { id: "j-throw", name: "Charlie", status: "active" },
      ],
      deps({
        "j-ok": [rfi({ id: "r1", jobId: "j-ok", status: "sent" })],
        "j-null": null, // unreadable/malformed register
        "j-throw": () => {
          throw new Error("blob down");
        },
      }),
    );
    expect(res.rfis.map((r) => r.id)).toEqual(["r1"]);
    expect(res.failedJobs.sort()).toEqual(["j-null", "j-throw"]);
    expect(res.scannedJobs).toBe(3);
  });

  it("returns an empty result for an empty job list", async () => {
    const res = await runRfiScan([], deps({}));
    expect(res).toEqual({ rfis: [], scannedJobs: 0, failedJobs: [] });
  });
});
