import { describe, expect, it } from "vitest";
import { deriveJobHealth, AT_RISK_SOFT_TOTAL, type JobHealth } from "./job-health";

/** #226 — pure job health from real stats. No oracle: deterministic rules. */

describe("deriveJobHealth", () => {
  it("unknown when NO stat is loaded (never a fabricated 'good')", () => {
    expect(deriveJobHealth({}).level).toBe("unknown");
    expect(deriveJobHealth({}).reasons).toEqual([]);
  });

  it("good when every loaded stat is zero", () => {
    const h = deriveJobHealth({
      statsEvidenceV2Pending: 0,
      statsExpiredTags: 0,
    });
    expect(h.level).toBe("good");
    expect(h.total).toBe(0);
    expect(h.reasons).toEqual([]);
  });

  it("watch on a small soft backlog (below the at-risk threshold)", () => {
    const h = deriveJobHealth({ statsEvidenceV2Pending: 3 });
    expect(h.level).toBe("watch");
    expect(h.total).toBe(3);
    expect(h.reasons.map((r) => r.key)).toEqual(["evidence"]); // soft, in order
  });

  it("at-risk on ANY expired gear tag (hard compliance breach), hard reason first", () => {
    const h = deriveJobHealth({ statsExpiredTags: 1, statsEvidenceV2Pending: 1 });
    expect(h.level).toBe("at-risk");
    expect(h.reasons[0]).toMatchObject({ key: "tags", severity: "hard", count: 1 });
  });

  it("at-risk when the soft backlog reaches the documented threshold", () => {
    const atThreshold = deriveJobHealth({ statsEvidenceV2Pending: AT_RISK_SOFT_TOTAL });
    expect(atThreshold.level).toBe("at-risk");
    const justBelow = deriveJobHealth({ statsEvidenceV2Pending: AT_RISK_SOFT_TOTAL - 1 });
    expect(justBelow.level).toBe("watch");
  });

  it("ignores missing/negative/non-finite stats; only real positives count", () => {
    const h: JobHealth = deriveJobHealth({
      statsExpiredTags: -3,
      statsEvidenceV2Pending: 4,
    });
    expect(h.reasons.map((r) => r.key)).toEqual(["evidence"]);
    expect(h.total).toBe(4);
    expect(h.level).toBe("watch");
  });

  it("photos to review only count while the job is running — a finished / closed job stops nagging (owner pull 2026-10-06)", () => {
    const recent = new Date(Date.now() - 3 * 86_400_000).toISOString(); // finished 3 days ago (in the callback window)
    const longAgo = "2026-01-10T00:00:00.000Z"; // closed
    for (const job of [
      { status: "complete" as const, completedAt: recent },
      { status: "complete" as const, completedAt: longAgo },
      { status: "archived" as const },
    ]) {
      const h = deriveJobHealth({ ...job, statsEvidenceV2Pending: 12, statsExpiredTags: 0 });
      expect(h.level, JSON.stringify(job)).toBe("good");
      expect(h.reasons, JSON.stringify(job)).toEqual([]);
    }
    // still counts on running work
    expect(deriveJobHealth({ status: "active", statsEvidenceV2Pending: 3 }).level).toBe("watch");
    expect(deriveJobHealth({ status: "on_hold", statsEvidenceV2Pending: 3 }).level).toBe("watch");
    // a job with no status reads as active (callers without lifecycle fields keep today's rule)
    expect(deriveJobHealth({ statsEvidenceV2Pending: 3 }).level).toBe("watch");
  });

  it("expired gear tags still count on a finished job — out-of-test kit is a hard breach in any phase", () => {
    const h = deriveJobHealth({ status: "complete", completedAt: "2026-01-10T00:00:00.000Z", statsExpiredTags: 1, statsEvidenceV2Pending: 5 });
    expect(h.level).toBe("at-risk");
    expect(h.reasons.map((r) => r.key)).toEqual(["tags"]);
  });

  it("a zero stat still counts as 'loaded' → good, not unknown", () => {
    expect(deriveJobHealth({ statsEvidenceV2Pending: 0 }).level).toBe("good");
  });
});
