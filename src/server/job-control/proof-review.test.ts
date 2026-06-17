import { describe, expect, it, vi } from "vitest";
import {
  ProofReviewRequestSchema,
  applyProofReview,
  writeProofReview,
  type ProofReviewDeps,
} from "./proof-review";
import {
  PersistedJobControlSchema,
  jobControlRevisionOf,
  type PersistedJobControl,
} from "./compile-producer";

/**
 * Proof-review writer — the submit → approve/reject lifecycle on the compiled
 * artifact. Proves: submit is server-verified against captured proof (never the
 * client gate), submit never approves, approve/reject act only on a submitted
 * record, review is keyed by work package (cross-package isolation), and the
 * shared revision guard rejects a stale write.
 */

function artifactRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: "job_1",
    workPackages: [
      {
        id: "wp_1",
        jobId: "job_1",
        title: "East",
        scopeClauseIds: [],
        boqLineRefs: [],
        taskRefs: [{ areaId: "a1", stage: "roughIn", taskId: "t1" }],
        order: 0,
        requiredEvidence: [
          { id: "re1", label: "Test", kind: "test_result" },
          { id: "re2", label: "Photo", kind: "photo" },
        ],
      },
      {
        id: "wp_2",
        jobId: "job_1",
        title: "West",
        scopeClauseIds: [],
        boqLineRefs: [],
        taskRefs: [{ areaId: "a2", stage: "roughIn", taskId: "t1" }],
        order: 1,
        requiredEvidence: [{ id: "re1", label: "Test", kind: "test_result" }],
      },
    ],
    claimLines: [],
    closeoutRequirements: [],
    evidenceLinks: [],
    proofReviews: [],
    updatedAt: "2026-06-15T00:00:00.000Z",
    ...over,
  };
}
function artifact(over: Record<string, unknown> = {}): PersistedJobControl {
  return PersistedJobControlSchema.parse(artifactRaw(over));
}

/** Evidence links that mark wp_1 FULLY met (both requirements). */
const WP1_MET = [
  { id: "el_1", jobId: "job_1", evidenceId: "ev1", workPackageId: "wp_1", requiredEvidenceId: "re1", role: "progress" },
  { id: "el_2", jobId: "job_1", evidenceId: "ev2", workPackageId: "wp_1", requiredEvidenceId: "re2", role: "progress" },
];

const AT = "2026-06-15T12:00:00.000Z";
const CTX = { id: "pr_x", at: AT, actor: "u_actor" };

function revOf(raw: unknown): string {
  return jobControlRevisionOf(PersistedJobControlSchema.parse(raw));
}

function fakeDeps(over: { raw?: unknown } = {}): ProofReviewDeps & {
  saved: PersistedJobControl[];
  currentRevision: string | undefined;
} {
  const raw = "raw" in over ? over.raw : artifactRaw({ evidenceLinks: WP1_MET });
  const saved: PersistedJobControl[] = [];
  let n = 0;
  let currentRevision: string | undefined;
  try {
    currentRevision = raw == null ? undefined : revOf(raw);
  } catch {
    currentRevision = undefined;
  }
  return {
    saved,
    currentRevision,
    loadRaw: vi.fn(async () => raw),
    save: vi.fn(async (_jobId: string, a: PersistedJobControl) => {
      saved.push(a);
    }),
    mintId: () => `pr_test_${++n}`,
  };
}

describe("ProofReviewRequestSchema", () => {
  it("rejects an unknown action", () => {
    expect(ProofReviewRequestSchema.safeParse({ action: "nope", workPackageId: "wp_1" }).success).toBe(false);
  });
});

describe("applyProofReview — submit (server-verified against captured proof)", () => {
  it("blocks submit when required proof is still missing", () => {
    const r = applyProofReview(artifact(), { action: "submit", workPackageId: "wp_1" }, CTX);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("incomplete");
  });

  it("blocks submit when the work package has no required proof", () => {
    const a = artifact({
      workPackages: [
        { id: "wp_x", jobId: "job_1", title: "X", scopeClauseIds: [], boqLineRefs: [], taskRefs: [], order: 0, requiredEvidence: [] },
      ],
    });
    const r = applyProofReview(a, { action: "submit", workPackageId: "wp_x" }, CTX);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("no_required_proof");
  });

  it("blocks submit for a work package not in the artifact", () => {
    const r = applyProofReview(artifact({ evidenceLinks: WP1_MET }), { action: "submit", workPackageId: "wp_ghost" }, CTX);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("invalid_work_package");
  });

  it("submits when every required item is met — status 'submitted', NOT approved", () => {
    const r = applyProofReview(artifact({ evidenceLinks: WP1_MET }), { action: "submit", workPackageId: "wp_1" }, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.review.status).toBe("submitted");
    expect(r.review.workPackageId).toBe("wp_1");
    expect(r.review.submittedBy).toBe("u_actor");
    expect(r.review.reviewedAt ?? null).toBeNull();
    expect(r.artifact.proofReviews).toHaveLength(1);
    // Revision advanced from the new content.
    expect(jobControlRevisionOf(r.artifact)).not.toBe(jobControlRevisionOf(artifact({ evidenceLinks: WP1_MET })));
  });

  it("rejects a second submit while already submitted", () => {
    const submitted = applyProofReview(artifact({ evidenceLinks: WP1_MET }), { action: "submit", workPackageId: "wp_1" }, CTX);
    if (!submitted.ok) throw new Error("setup");
    const again = applyProofReview(submitted.artifact, { action: "submit", workPackageId: "wp_1" }, CTX);
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error("unreachable");
    expect(again.reason).toBe("already_submitted");
  });

  it("keeps review per work package — submitting wp_1 leaves wp_2 with no review", () => {
    const r = applyProofReview(artifact({ evidenceLinks: WP1_MET }), { action: "submit", workPackageId: "wp_1" }, CTX);
    if (!r.ok) throw new Error("unreachable");
    expect(r.artifact.proofReviews.map((p) => p.workPackageId)).toEqual(["wp_1"]);
    expect(r.artifact.proofReviews.some((p) => p.workPackageId === "wp_2")).toBe(false);
  });
});

describe("applyProofReview — approve / reject (separate admin action)", () => {
  function submitted(): PersistedJobControl {
    const r = applyProofReview(artifact({ evidenceLinks: WP1_MET }), { action: "submit", workPackageId: "wp_1" }, CTX);
    if (!r.ok) throw new Error("setup");
    return r.artifact;
  }

  it("cannot approve/reject before submit (no review record)", () => {
    const a = artifact({ evidenceLinks: WP1_MET });
    expect(applyProofReview(a, { action: "approve", workPackageId: "wp_1" }, CTX).ok).toBe(false);
    const r = applyProofReview(a, { action: "reject", workPackageId: "wp_1", reason: "x" }, CTX);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("no_review");
  });

  it("approves a submitted review", () => {
    const r = applyProofReview(submitted(), { action: "approve", workPackageId: "wp_1" }, { ...CTX, actor: "u_admin" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.review.status).toBe("approved");
    expect(r.review.reviewedBy).toBe("u_admin");
    expect(r.review.reason ?? null).toBeNull();
  });

  it("rejects a submitted review and preserves the reason", () => {
    const r = applyProofReview(
      submitted(),
      { action: "reject", workPackageId: "wp_1", reason: "Missing label photo" },
      { ...CTX, actor: "u_admin" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.review.status).toBe("rejected");
    expect(r.review.reason).toBe("Missing label photo");
  });

  it("cannot approve a non-submitted (already approved) review", () => {
    const approved = applyProofReview(submitted(), { action: "approve", workPackageId: "wp_1" }, CTX);
    if (!approved.ok) throw new Error("setup");
    const again = applyProofReview(approved.artifact, { action: "approve", workPackageId: "wp_1" }, CTX);
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error("unreachable");
    expect(again.reason).toBe("not_submitted");
  });

  it("allows resubmit after a rejection", () => {
    const rejected = applyProofReview(submitted(), { action: "reject", workPackageId: "wp_1", reason: "x" }, CTX);
    if (!rejected.ok) throw new Error("setup");
    const resubmit = applyProofReview(rejected.artifact, { action: "submit", workPackageId: "wp_1" }, CTX);
    expect(resubmit.ok).toBe(true);
    if (!resubmit.ok) throw new Error("unreachable");
    expect(resubmit.review.status).toBe("submitted");
    expect(resubmit.review.reason ?? null).toBeNull(); // cleared on resubmit
  });
});

describe("writeProofReview — revision guard + I/O", () => {
  it("persists a submit and advances the revision", async () => {
    const deps = fakeDeps();
    const res = await writeProofReview(deps, {
      jobId: "job_1",
      request: { action: "submit", workPackageId: "wp_1" },
      expectedRevision: deps.currentRevision!,
      at: AT,
      actor: "u_worker",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.status).toBe(200);
    expect(res.review.status).toBe("submitted");
    expect(deps.saved).toHaveLength(1);
    expect(res.revision).toBe(jobControlRevisionOf(deps.saved[0]!));
  });

  it("rejects a stale write (revision moved since read) without saving", async () => {
    const deps = fakeDeps();
    const res = await writeProofReview(deps, {
      jobId: "job_1",
      request: { action: "submit", workPackageId: "wp_1" },
      expectedRevision: "stale-revision",
      at: AT,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.status).toBe(409);
    expect(res.reason).toBe("stale_revision");
    expect(deps.saved).toHaveLength(0);
  });

  it("a missing artifact is failed-soft (404 missing, no save)", async () => {
    const deps = fakeDeps({ raw: null });
    const res = await writeProofReview(deps, {
      jobId: "job_1",
      request: { action: "submit", workPackageId: "wp_1" },
      expectedRevision: "anything",
      at: AT,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.status).toBe(404);
    expect(res.reason).toBe("missing");
    expect(deps.saved).toHaveLength(0);
  });

  it("an incomplete submit is rejected and nothing is saved", async () => {
    const deps = fakeDeps({ raw: artifactRaw() }); // no evidence links → not met
    const res = await writeProofReview(deps, {
      jobId: "job_1",
      request: { action: "submit", workPackageId: "wp_1" },
      expectedRevision: deps.currentRevision!,
      at: AT,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("incomplete");
    expect(deps.saved).toHaveLength(0);
  });
});
