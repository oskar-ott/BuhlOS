import { describe, expect, it, vi } from "vitest";
import {
  ProofReviewRequestSchema,
  applyProofReview,
  writeProofReview,
  writeProofReviewAuthorized,
  type ProofReviewDeps,
} from "./proof-review";
import {
  PersistedJobControlSchema,
  jobControlRevisionOf,
  type PersistedJobControl,
} from "./compile-producer";

/**
 * #503 — task-instance proof review/approval. Proves: submit is server-verified
 * against the TASK's captured proof (never the client gate), submit never
 * approves, approve/reject act only on a submitted record and not by the
 * submitter (independence), review is keyed per task (cross-task isolation), and
 * the shared revision guard rejects a stale write.
 */

const T1 = { areaId: "a1", stage: "roughIn", taskId: "t1" } as const;
const T2 = { areaId: "a1", stage: "roughIn", taskId: "t2" } as const;

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
        taskRefs: [
          { areaId: "a1", stage: "roughIn", taskId: "t1" },
          { areaId: "a1", stage: "roughIn", taskId: "t2" },
        ],
        order: 0,
        requiredEvidence: [{ id: "re1", label: "Circuit test", kind: "test_result" }],
      },
    ],
    claimLines: [],
    closeoutRequirements: [],
    evidenceLinks: [],
    proofReviews: [],
    updatedAt: "2026-06-18T00:00:00.000Z",
    ...over,
  };
}
function artifact(over: Record<string, unknown> = {}): PersistedJobControl {
  return PersistedJobControlSchema.parse(artifactRaw(over));
}

/** A package-level link that marks wp_1's re1 met (covers every task in wp_1). */
const MET = [
  { id: "el_1", jobId: "job_1", evidenceId: "ev1", workPackageId: "wp_1", requiredEvidenceId: "re1", role: "progress" },
];

const AT = "2026-06-18T12:00:00.000Z";
const CTX = { id: "pr_new", at: AT, actor: "u_worker" };

describe("ProofReviewRequestSchema", () => {
  it("rejects an unknown action", () => {
    expect(ProofReviewRequestSchema.safeParse({ action: "nope", taskRef: T1 }).success).toBe(false);
  });
});

describe("applyProofReview — submit (server-verified against the task's proof)", () => {
  it("blocks submit when the task's required proof is still missing", () => {
    const r = applyProofReview(artifact(), { action: "submit", taskRef: T1 }, CTX);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("incomplete");
  });

  it("blocks submit when the task has no required proof", () => {
    const a = artifact({
      workPackages: [
        { id: "wp_x", jobId: "job_1", title: "X", scopeClauseIds: [], boqLineRefs: [], taskRefs: [{ areaId: "a1", stage: "roughIn", taskId: "t1" }], order: 0, requiredEvidence: [] },
      ],
    });
    const r = applyProofReview(a, { action: "submit", taskRef: T1 }, CTX);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("no_required_proof");
  });

  it("submits when every required item is met — status 'submitted', NOT approved", () => {
    const r = applyProofReview(artifact({ evidenceLinks: MET }), { action: "submit", taskRef: T1 }, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.review.status).toBe("submitted");
    expect(r.review.submittedBy).toBe("u_worker");
    expect(r.review.reviewedAt ?? null).toBeNull();
    expect(r.artifact.proofReviews).toHaveLength(1);
    expect(jobControlRevisionOf(r.artifact)).not.toBe(jobControlRevisionOf(artifact({ evidenceLinks: MET })));
  });

  it("rejects a second submit while already submitted", () => {
    const first = applyProofReview(artifact({ evidenceLinks: MET }), { action: "submit", taskRef: T1 }, CTX);
    if (!first.ok) throw new Error("setup");
    const again = applyProofReview(first.artifact, { action: "submit", taskRef: T1 }, CTX);
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error("unreachable");
    expect(again.reason).toBe("already_submitted");
  });

  it("keeps review per task — submitting t1 leaves t2 with no review (cross-task isolation)", () => {
    const r = applyProofReview(artifact({ evidenceLinks: MET }), { action: "submit", taskRef: T1 }, CTX);
    if (!r.ok) throw new Error("unreachable");
    expect(r.artifact.proofReviews.map((p) => p.taskRef.taskId)).toEqual(["t1"]);
  });
});

describe("applyProofReview — approve / reject (separate admin action + independence)", () => {
  function submitted(): PersistedJobControl {
    const r = applyProofReview(artifact({ evidenceLinks: MET }), { action: "submit", taskRef: T1 }, CTX);
    if (!r.ok) throw new Error("setup");
    return r.artifact;
  }

  it("cannot approve/reject before submit", () => {
    const a = artifact({ evidenceLinks: MET });
    expect(applyProofReview(a, { action: "approve", taskRef: T1 }, CTX).ok).toBe(false);
    const r = applyProofReview(a, { action: "reject", taskRef: T1, reason: "x" }, CTX);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("no_review");
  });

  it("the submitter cannot approve their own submission (independence)", () => {
    const r = applyProofReview(submitted(), { action: "approve", taskRef: T1 }, { ...CTX, actor: "u_worker" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("self_review");
  });

  it("a different admin approves a submitted review", () => {
    const r = applyProofReview(submitted(), { action: "approve", taskRef: T1 }, { ...CTX, actor: "u_admin" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.review.status).toBe("approved");
    expect(r.review.reviewedBy).toBe("u_admin");
  });

  it("reject requires a reason and preserves it", () => {
    const noReason = applyProofReview(submitted(), { action: "reject", taskRef: T1 }, { ...CTX, actor: "u_admin" });
    expect(noReason.ok).toBe(false);
    if (noReason.ok) throw new Error("unreachable");
    expect(noReason.reason).toBe("reason_required");

    const r = applyProofReview(submitted(), { action: "reject", taskRef: T1, reason: "Missing label photo" }, { ...CTX, actor: "u_admin" });
    if (!r.ok) throw new Error("unreachable");
    expect(r.review.status).toBe("rejected");
    expect(r.review.reason).toBe("Missing label photo");
  });

  it("cannot approve a non-submitted (already approved) review", () => {
    const approved = applyProofReview(submitted(), { action: "approve", taskRef: T1 }, { ...CTX, actor: "u_admin" });
    if (!approved.ok) throw new Error("setup");
    const again = applyProofReview(approved.artifact, { action: "approve", taskRef: T1 }, { ...CTX, actor: "u_admin2" });
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error("unreachable");
    expect(again.reason).toBe("not_submitted");
  });

  it("allows resubmit after a rejection, clearing the reason", () => {
    const rejected = applyProofReview(submitted(), { action: "reject", taskRef: T1, reason: "x" }, { ...CTX, actor: "u_admin" });
    if (!rejected.ok) throw new Error("setup");
    const resubmit = applyProofReview(rejected.artifact, { action: "submit", taskRef: T1 }, CTX);
    expect(resubmit.ok).toBe(true);
    if (!resubmit.ok) throw new Error("unreachable");
    expect(resubmit.review.status).toBe("submitted");
    expect(resubmit.review.reason ?? null).toBeNull();
  });
});

describe("writeProofReview — revision guard + I/O", () => {
  function fakeDeps(over: { raw?: unknown } = {}): ProofReviewDeps & { saved: PersistedJobControl[]; currentRevision?: string } {
    const raw = "raw" in over ? over.raw : artifactRaw({ evidenceLinks: MET });
    const saved: PersistedJobControl[] = [];
    let n = 0;
    let currentRevision: string | undefined;
    try {
      currentRevision = raw == null ? undefined : jobControlRevisionOf(PersistedJobControlSchema.parse(raw));
    } catch {
      currentRevision = undefined;
    }
    return {
      saved,
      currentRevision,
      loadRaw: vi.fn(async () => raw),
      save: vi.fn(async (_j: string, a: PersistedJobControl) => { saved.push(a); }),
      mintId: () => `pr_test_${++n}`,
    };
  }

  it("persists a submit and advances the revision", async () => {
    const deps = fakeDeps();
    const res = await writeProofReview(deps, { jobId: "job_1", request: { action: "submit", taskRef: T1 }, expectedRevision: deps.currentRevision!, at: AT, actor: "u_worker" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.status).toBe(200);
    expect(res.review.status).toBe("submitted");
    expect(deps.saved).toHaveLength(1);
    expect(res.revision).toBe(jobControlRevisionOf(deps.saved[0]!));
  });

  it("rejects a stale write (revision moved) without saving", async () => {
    const deps = fakeDeps();
    const res = await writeProofReview(deps, { jobId: "job_1", request: { action: "submit", taskRef: T1 }, expectedRevision: "stale", at: AT });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.status).toBe(409);
    expect(res.reason).toBe("stale_revision");
    expect(deps.saved).toHaveLength(0);
  });

  it("a missing artifact is failed-soft (404, no save)", async () => {
    const deps = fakeDeps({ raw: null });
    const res = await writeProofReview(deps, { jobId: "job_1", request: { action: "submit", taskRef: T1 }, expectedRevision: "anything", at: AT });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.status).toBe(404);
    expect(res.reason).toBe("missing");
    expect(deps.saved).toHaveLength(0);
  });

  it("an incomplete submit is rejected and nothing is saved", async () => {
    const deps = fakeDeps({ raw: artifactRaw() }); // no evidence links → not met
    const res = await writeProofReview(deps, { jobId: "job_1", request: { action: "submit", taskRef: T1 }, expectedRevision: deps.currentRevision!, at: AT });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("incomplete");
    expect(deps.saved).toHaveLength(0);
  });
});

describe("writeProofReviewAuthorized — authoritative admin gate (#544 auth-bypass fix)", () => {
  const APPROVE_INPUT = {
    jobId: "job_1",
    request: { action: "approve" as const, taskRef: T1, reason: null },
    expectedRevision: "rev_x",
    at: AT,
    actor: "u_admin",
  };
  function depsTracking() {
    let loadCalled = false;
    const deps: ProofReviewDeps = {
      loadRaw: async () => {
        loadCalled = true;
        return null;
      },
      save: async () => {},
      mintId: () => "pr_x",
    };
    return { deps, loadCalled: () => loadCalled };
  }

  it("rejects a forged/unsigned cookie (verify → null) with 401 and never reaches the writer", async () => {
    const { deps, loadCalled } = depsTracking();
    const res = await writeProofReviewAuthorized(
      deps,
      { cookieHeader: "buhl_session=forged.badsig", baseUrl: "https://x", verify: async () => null },
      APPROVE_INPUT,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.status).toBe(401);
    expect(loadCalled()).toBe(false); // gate blocked before any I/O — the bug was reaching here on a forged cookie
  });

  it("rejects a verified NON-admin with 403", async () => {
    const { deps, loadCalled } = depsTracking();
    const res = await writeProofReviewAuthorized(
      deps,
      { cookieHeader: "c", baseUrl: "https://x", verify: async () => ({ role: "electrician" }) },
      APPROVE_INPUT,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.status).toBe(403);
    expect(loadCalled()).toBe(false);
  });

  it("a VERIFIED admin passes the gate and delegates to writeProofReview", async () => {
    const { deps, loadCalled } = depsTracking(); // loadRaw → null → writer returns 404 missing
    const res = await writeProofReviewAuthorized(
      deps,
      { cookieHeader: "c", baseUrl: "https://x", verify: async () => ({ role: "admin" }) },
      APPROVE_INPUT,
    );
    expect(loadCalled()).toBe(true); // reached the writer
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.status).toBe(404); // writer ran; artifact missing in this stub
  });
});
