import { describe, expect, it, vi } from "vitest";
import {
  postProofReview,
  proofReviewStatusLabel,
  submitProofForReview,
} from "./jobControlProofReviewClient";

const T1 = { areaId: "a1", stage: "roughIn", taskId: "t1" } as const;
const INPUT = { jobId: "job_1", taskRef: T1, expectedJobControlRevision: "rev_A" };

function fakeFetch(status: number, body: unknown): typeof fetch {
  const ok = status >= 200 && status < 300;
  return vi.fn(async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;
}

describe("submitProofForReview / postProofReview", () => {
  it("maps a 200 ok body to ok(review, revision) and sends the submit action + taskRef", async () => {
    const review = { id: "pr_1", jobId: "job_1", taskRef: T1, status: "submitted" };
    const fetchImpl = fakeFetch(200, { ok: true, status: 200, review, revision: "rev_B" });
    const r = await submitProofForReview(INPUT, fetchImpl);
    expect(r).toEqual({ kind: "ok", review, revision: "rev_B" });

    const sent = JSON.parse(
      ((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(sent).toMatchObject({
      jobId: "job_1",
      action: "submit",
      taskRef: T1,
      expectedJobControlRevision: "rev_A",
    });
    expect("reason" in sent).toBe(false); // no reason on submit
  });

  it("maps 409 stale_revision to stale with the current revision", async () => {
    const r = await submitProofForReview(INPUT, fakeFetch(409, { ok: false, reason: "stale_revision", currentRevision: "rev_C" }));
    expect(r).toEqual({ kind: "stale", currentRevision: "rev_C" });
  });

  it("maps an incomplete submit to incomplete", async () => {
    expect((await submitProofForReview(INPUT, fakeFetch(409, { ok: false, reason: "incomplete" }))).kind).toBe("incomplete");
  });

  it("maps not-actionable reasons to invalid", async () => {
    for (const reason of ["missing", "no_review", "not_submitted", "already_submitted", "self_review", "reason_required"]) {
      expect((await submitProofForReview(INPUT, fakeFetch(409, { ok: false, reason }))).kind).toBe("invalid");
    }
    expect((await submitProofForReview(INPUT, fakeFetch(404, { ok: false, reason: "missing" }))).kind).toBe("invalid");
  });

  it("maps 401/403 to unauthorized and other failures to error", async () => {
    expect((await submitProofForReview(INPUT, fakeFetch(401, {}))).kind).toBe("unauthorized");
    expect((await submitProofForReview(INPUT, fakeFetch(403, {}))).kind).toBe("unauthorized");
    expect((await submitProofForReview(INPUT, fakeFetch(500, { ok: false }))).kind).toBe("error");
  });

  it("a reject action sends its reason", async () => {
    const fetchImpl = fakeFetch(200, { ok: true, status: 200, review: { id: "pr_1" }, revision: "rev_B" });
    await postProofReview({ jobId: "job_1", action: "reject", taskRef: T1, reason: "Missing photo", expectedJobControlRevision: "rev_A" }, fetchImpl);
    const sent = JSON.parse(
      ((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(sent).toMatchObject({ action: "reject", reason: "Missing photo" });
  });
});

describe("proofReviewStatusLabel", () => {
  it("renders worker-facing status, with the reason on a sent-back review", () => {
    expect(proofReviewStatusLabel(null)).toBeNull();
    expect(proofReviewStatusLabel({ status: "submitted", reason: null })).toBe("Submitted for review");
    expect(proofReviewStatusLabel({ status: "approved", reason: null })).toBe("Approved");
    expect(proofReviewStatusLabel({ status: "rejected", reason: "Missing label photo" })).toBe(
      "Sent back — Missing label photo",
    );
    expect(proofReviewStatusLabel({ status: "rejected", reason: null })).toBe("Sent back");
  });
});
