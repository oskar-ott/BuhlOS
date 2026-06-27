import { describe, expect, it } from "vitest";
import type { PersistedJobControl } from "./compile-producer";
import {
  runProofQueue,
  shapeJobProofItems,
  type EvidenceById,
  type ProofQueueDeps,
} from "./proof-queue";

const TASK = { areaId: "a1", stage: "roughIn" as const, taskId: "t1" };

function artifact(over: Partial<PersistedJobControl> = {}): PersistedJobControl {
  return {
    jobId: "job-1",
    workPackages: [
      {
        id: "wp_1",
        title: "Switchboard terminations",
        taskRefs: [TASK],
        requiredEvidence: [{ id: "re_1", label: "Photo before close-up", kind: "photo" }],
      },
    ],
    claimLines: [],
    closeoutRequirements: [],
    evidenceLinks: [
      { workPackageId: "wp_1", requiredEvidenceId: "re_1", evidenceId: "ev_1" },
    ],
    proofReviews: [
      { id: "pr_1", jobId: "job-1", taskRef: TASK, status: "submitted", submittedBy: "u-josh", submittedAt: "2026-06-25T00:00:00Z" },
      { id: "pr_2", jobId: "job-1", taskRef: { areaId: "a2", stage: "fitOff", taskId: "t9" }, status: "approved", submittedBy: "u-x" },
    ],
    ...over,
  } as unknown as PersistedJobControl;
}

const evidence: EvidenceById = new Map([
  ["ev_1", { photoUrl: "https://blob/ev_1.jpg", capturedByName: "Josh Mason", capturedAt: "2026-06-25T01:00:00Z" }],
]);

describe("shapeJobProofItems (pure)", () => {
  it("includes only SUBMITTED reviews and joins the package + photo", () => {
    const items = shapeJobProofItems({ id: "job-1", name: "Glebe Town Hall" }, artifact(), evidence);
    expect(items).toHaveLength(1);
    const it0 = items[0]!;
    expect(it0.reviewId).toBe("pr_1");
    expect(it0.jobName).toBe("Glebe Town Hall");
    expect(it0.workPackageTitle).toBe("Switchboard terminations");
    expect(it0.requirements).toEqual([
      { id: "re_1", label: "Photo before close-up", kind: "photo", met: true },
    ]);
    expect(it0.photos).toEqual([
      { evidenceId: "ev_1", photoUrl: "https://blob/ev_1.jpg", capturedByName: "Josh Mason", capturedAt: "2026-06-25T01:00:00Z" },
    ]);
    expect(it0.submittedBy).toBe("u-josh");
    expect(typeof it0.jobControlRevision).toBe("string");
  });

  it("excludes approved/rejected reviews", () => {
    const items = shapeJobProofItems(
      { id: "job-1", name: "J" },
      artifact({
        proofReviews: [
          { id: "pr_a", jobId: "job-1", taskRef: TASK, status: "approved" },
          { id: "pr_r", jobId: "job-1", taskRef: TASK, status: "rejected", reason: "redo" },
        ],
      } as unknown as Partial<PersistedJobControl>),
      evidence,
    );
    expect(items).toHaveLength(0);
  });

  it("renders a submitted review with no joinable photo as an empty photo list (honest)", () => {
    const items = shapeJobProofItems({ id: "job-1", name: "J" }, artifact(), new Map());
    expect(items[0]!.photos).toEqual([]);
  });
});

describe("runProofQueue (orchestrator)", () => {
  function deps(over: Partial<ProofQueueDeps> = {}): ProofQueueDeps {
    return {
      listActiveJobs: async () => [
        { id: "job-1", name: "Glebe Town Hall" },
        { id: "job-2", name: "UTS Building 11" },
      ],
      loadArtifact: async (id) => (id === "job-1" ? artifact() : null),
      loadEvidence: async () => evidence,
      ...over,
    };
  }

  it("flattens submitted proof across active jobs, oldest first", async () => {
    const res = await runProofQueue(deps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.scannedJobs).toBe(2);
    expect(res.items.map((i) => i.reviewId)).toEqual(["pr_1"]);
    expect(res.failedJobs).toEqual([]);
  });

  it("isolates a single job read failure into failedJobs", async () => {
    const res = await runProofQueue(
      deps({
        loadArtifact: async (id) => {
          if (id === "job-2") throw new Error("blob down");
          return artifact();
        },
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.failedJobs).toEqual(["job-2"]);
    expect(res.items).toHaveLength(1);
  });

  it("returns ok:false when listing jobs fails", async () => {
    const res = await runProofQueue(
      deps({
        listActiveJobs: async () => {
          throw new Error("jobs.json down");
        },
      }),
    );
    expect(res.ok).toBe(false);
  });

  it("short-circuits the evidence read for a job with no SUBMITTED proof", async () => {
    let evidenceReads = 0;
    const onlyApproved = artifact({
      proofReviews: [
        { id: "pr_a", jobId: "job-1", taskRef: TASK, status: "approved" },
      ],
    } as unknown as Partial<PersistedJobControl>);
    const res = await runProofQueue(
      deps({
        listActiveJobs: async () => [{ id: "job-1", name: "J" }],
        loadArtifact: async () => onlyApproved,
        loadEvidence: async () => {
          evidenceReads += 1;
          return evidence;
        },
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.items).toHaveLength(0);
    // The wasted data.json read is skipped when nothing is submitted.
    expect(evidenceReads).toBe(0);
  });
});
