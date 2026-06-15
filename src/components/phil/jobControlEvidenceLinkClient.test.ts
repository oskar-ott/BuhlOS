import { describe, expect, it, vi } from "vitest";
import {
  applyProofLinkResult,
  linkAndApply,
  linkRequiredProof,
  proofStatusMessage,
  type LinkProofResult,
} from "./jobControlEvidenceLinkClient";

const INPUT = {
  jobId: "job_1",
  workPackageId: "wp_1",
  requiredEvidenceId: "re1",
  evidenceId: "ev_123",
  expectedJobControlRevision: "rev_A",
};

/** A fake fetch returning a Response-like with the given status + JSON body. */
function fakeFetch(status: number, body: unknown): typeof fetch {
  const ok = status >= 200 && status < 300;
  return vi.fn(async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;
}

describe("linkRequiredProof", () => {
  it("maps a 200 ok body to linked + revision, and sends the real evidenceId + revision", async () => {
    const fetchImpl = fakeFetch(200, { ok: true, created: true, revision: "rev_B", link: { id: "el_x" } });
    const r = await linkRequiredProof(INPUT, fetchImpl);
    expect(r).toEqual({ kind: "linked", revision: "rev_B" });

    // the request carried the REAL saved evidenceId + the precondition revision
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe("/api/job-control/evidence-link");
    const sent = JSON.parse((call[1] as RequestInit).body as string);
    expect(sent).toMatchObject({
      jobId: "job_1",
      workPackageId: "wp_1",
      requiredEvidenceId: "re1",
      evidenceId: "ev_123",
      expectedJobControlRevision: "rev_A",
    });
  });

  it("maps 409 stale_revision to stale with the current revision", async () => {
    const r = await linkRequiredProof(INPUT, fakeFetch(409, { ok: false, reason: "stale_revision", currentRevision: "rev_C" }));
    expect(r).toEqual({ kind: "stale", currentRevision: "rev_C" });
  });

  it("maps invalid target / missing artifact to invalid", async () => {
    expect((await linkRequiredProof(INPUT, fakeFetch(409, { ok: false, reason: "invalid_work_package" }))).kind).toBe("invalid");
    expect((await linkRequiredProof(INPUT, fakeFetch(409, { ok: false, reason: "invalid_requirement" }))).kind).toBe("invalid");
    expect((await linkRequiredProof(INPUT, fakeFetch(404, { ok: false, reason: "missing" }))).kind).toBe("invalid");
  });

  it("maps 401/403 to unauthorized", async () => {
    expect((await linkRequiredProof(INPUT, fakeFetch(401, {}))).kind).toBe("unauthorized");
    expect((await linkRequiredProof(INPUT, fakeFetch(403, {}))).kind).toBe("unauthorized");
  });

  it("maps a 500 / unknown failure to error", async () => {
    expect((await linkRequiredProof(INPUT, fakeFetch(500, { ok: false }))).kind).toBe("error");
  });

  it("maps a thrown fetch (network) to error", async () => {
    const throwingFetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect((await linkRequiredProof(INPUT, throwingFetch)).kind).toBe("error");
  });
});

describe("applyProofLinkResult", () => {
  const ctx = { jobId: "job_1", workPackageId: "wp_1", requiredEvidenceId: "re1", evidenceId: "ev_123" };

  it("linked → a real EvidenceLink (using the saved evidenceId, never fabricated) + new revision, no status", () => {
    const applied = applyProofLinkResult({ kind: "linked", revision: "rev_B" }, ctx);
    expect(applied.status).toBeUndefined();
    expect(applied.revision).toBe("rev_B");
    expect(applied.link).toMatchObject({
      jobId: "job_1",
      workPackageId: "wp_1",
      requiredEvidenceId: "re1",
      evidenceId: "ev_123", // the real saved id
      role: "progress",
    });
    expect(applied.link!.evidenceId).toBe(ctx.evidenceId);
  });

  it("stale → stale status, carries the server's current revision, no link (not met)", () => {
    const applied = applyProofLinkResult({ kind: "stale", currentRevision: "rev_C" }, ctx);
    expect(applied).toEqual({ status: "stale", revision: "rev_C" });
    expect(applied.link).toBeUndefined();
  });

  it("invalid / unauthorized → error status, no link", () => {
    expect(applyProofLinkResult({ kind: "invalid", message: "x" }, ctx)).toEqual({ status: "error" });
    expect(applyProofLinkResult({ kind: "unauthorized" }, ctx)).toEqual({ status: "error" });
  });

  it("error (link failed after a successful save) → saved_not_linked, no link", () => {
    const applied = applyProofLinkResult({ kind: "error", message: "x" }, ctx);
    expect(applied).toEqual({ status: "saved_not_linked" });
    expect(applied.link).toBeUndefined();
  });

  it("never marks met without a linked result", () => {
    const nonLinked: LinkProofResult[] = [
      { kind: "stale" },
      { kind: "invalid", message: "x" },
      { kind: "unauthorized" },
      { kind: "error", message: "x" },
    ];
    for (const r of nonLinked) expect(applyProofLinkResult(r, ctx).link).toBeUndefined();
  });
});

// The orchestration the component actually runs after a successful capture:
// saved EvidenceItem id (+ revision) → POST → local state change. `met` (a link)
// is produced ONLY when the route confirms.
describe("linkAndApply (capture → link → applied state)", () => {
  it("success → appends a real EvidenceLink (met) and sends the saved id + revision + target", async () => {
    const fetchImpl = fakeFetch(200, { ok: true, created: true, revision: "rev_B" });
    const applied = await linkAndApply(INPUT, fetchImpl);

    // met: a link built from the REAL saved evidenceId, advanced revision, no error status
    expect(applied.status).toBeUndefined();
    expect(applied.revision).toBe("rev_B");
    expect(applied.link?.evidenceId).toBe("ev_123");
    expect(applied.link).toMatchObject({ workPackageId: "wp_1", requiredEvidenceId: "re1", role: "progress" });

    // the POST carried exactly the saved id + precondition revision + target
    const sent = JSON.parse(
      ((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(sent).toMatchObject({
      evidenceId: "ev_123",
      expectedJobControlRevision: "rev_A",
      workPackageId: "wp_1",
      requiredEvidenceId: "re1",
    });
  });

  it("stale revision → NOT met (no link), shows stale status", async () => {
    const applied = await linkAndApply(INPUT, fakeFetch(409, { ok: false, reason: "stale_revision", currentRevision: "rev_C" }));
    expect(applied.link).toBeUndefined();
    expect(applied.status).toBe("stale");
  });

  it("link failure after a successful save → NOT met, 'saved but not linked'", async () => {
    const applied = await linkAndApply(INPUT, fakeFetch(500, { ok: false }));
    expect(applied.link).toBeUndefined();
    expect(applied.status).toBe("saved_not_linked");
  });
});

describe("proofStatusMessage", () => {
  it("is plain site language, no raw ids/jargon", () => {
    expect(proofStatusMessage("stale")).toMatch(/Refresh and try again/);
    expect(proofStatusMessage("saved_not_linked")).toMatch(/saved but not linked/i);
    expect(proofStatusMessage("error")).toMatch(/try again/i);
    expect(proofStatusMessage("saving")).toBe("Saving…");
  });
});
