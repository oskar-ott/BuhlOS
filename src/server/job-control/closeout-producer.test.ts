import { describe, expect, it } from "vitest";
import {
  applyCloseoutOp,
  blobCloseoutDeps,
  writeCloseout,
  type CloseoutDeps,
} from "./closeout-producer";
import {
  PersistedJobControlSchema,
  computeJobControlRevision,
  jobControlRevisionOf,
  type PersistedJobControl,
} from "./compile-producer";
import type { CloseoutKnownIds } from "@/domains/job-control/closeout-matrix";

/** A spine carrying ONE closeout requirement plus non-empty work-package /
 *  claim-line / evidence-link / proof-review / compileMeta sections, so a write
 *  must be shown to preserve them. Built + revision-stamped via the real helpers. */
function spine(): PersistedJobControl {
  const parsed = PersistedJobControlSchema.parse({
    jobId: "job-1",
    workPackages: [{ id: "wp_1", jobId: "job-1", title: "East gym" }],
    claimLines: [
      { id: "cl_1", jobId: "job-1", description: "Claim 3", claimedAmount: 1000, status: "approved" },
    ],
    closeoutRequirements: [
      {
        id: "cr_1",
        jobId: "job-1",
        title: "Certificate of electrical safety issued",
        kind: "certificate",
        source: "manual",
        status: "outstanding",
        order: 0,
      },
    ],
    evidenceLinks: [
      { id: "el_1", jobId: "job-1", workPackageId: "wp_1", requiredEvidenceId: "re_1", evidenceId: "ev_1", role: "progress" },
    ],
    proofReviews: [],
    compileMeta: {
      generatedAt: "2026-06-20T00:00:00.000Z",
      compilerVersion: "1",
      sourceHash: "h",
      sourceReconciliationHash: "rh",
      sourceStructureHash: "sh",
      gaps: [],
      diff: { added: 1, updated: 0, removed: 0 },
    },
  });
  return { ...parsed, revision: computeJobControlRevision(parsed) };
}

const known: CloseoutKnownIds = {
  certificateIds: ["cert_real"],
  documentIds: [],
  evidenceIds: [],
  itpInstanceIds: [],
};

function depsFor(initial: PersistedJobControl, opts: { known?: CloseoutKnownIds } = {}): {
  deps: CloseoutDeps;
  saved: () => PersistedJobControl | null;
} {
  let store: PersistedJobControl = initial;
  let wrote: PersistedJobControl | null = null;
  return {
    deps: {
      loadRaw: async () => store,
      save: async (_jobId, artifact) => {
        wrote = artifact;
        store = artifact;
      },
      mintId: () => "cr_new",
      loadKnownIds: opts.known ? async () => opts.known! : undefined,
    },
    saved: () => wrote,
  };
}

describe("applyCloseoutOp (pure)", () => {
  it("link + confirm against a resolving record → satisfied, other sections preserved", () => {
    const a = spine();
    const linked = applyCloseoutOp(
      a,
      { op: "link", requirementId: "cr_1", links: [{ type: "certificate", id: "cert_real" }] },
      { id: "x", at: "t1", known },
    );
    if (!linked.ok) throw new Error("link failed");
    // a link alone is in_progress (no confirmation yet)
    expect(linked.requirement?.status).toBe("in_progress");

    const confirmed = applyCloseoutOp(
      linked.artifact,
      { op: "confirm", requirementId: "cr_1", confirmed: true },
      { id: "x", at: "t2", actor: "boss", known },
    );
    if (!confirmed.ok) throw new Error("confirm failed");
    expect(confirmed.requirement?.status).toBe("satisfied");
    expect(confirmed.requirement?.confirmedBy).toBe("boss");

    // Other spine sections untouched.
    expect(confirmed.artifact.workPackages).toEqual(a.workPackages);
    expect(confirmed.artifact.claimLines).toEqual(a.claimLines);
    expect(confirmed.artifact.evidenceLinks).toEqual(a.evidenceLinks);
    expect(confirmed.artifact.compileMeta).toEqual(a.compileMeta);
    // Revision advanced.
    expect(jobControlRevisionOf(confirmed.artifact)).not.toBe(jobControlRevisionOf(a));
  });

  it("confirm WITHOUT a resolving link lands in_progress, never satisfied", () => {
    const res = applyCloseoutOp(
      spine(),
      { op: "confirm", requirementId: "cr_1", confirmed: true },
      { id: "x", at: "t", known },
    );
    if (!res.ok) throw new Error("confirm failed");
    expect(res.requirement?.status).toBe("in_progress");
  });

  it("changing the links clears a prior confirmation (re-confirm against new evidence)", () => {
    // link → confirm → satisfied
    const linked = applyCloseoutOp(
      spine(),
      { op: "link", requirementId: "cr_1", links: [{ type: "certificate", id: "cert_real" }] },
      { id: "x", at: "t1", known },
    );
    if (!linked.ok) throw new Error("link failed");
    const confirmed = applyCloseoutOp(
      linked.artifact,
      { op: "confirm", requirementId: "cr_1", confirmed: true },
      { id: "x", at: "t2", known },
    );
    if (!confirmed.ok) throw new Error("confirm failed");
    expect(confirmed.requirement?.status).toBe("satisfied");

    // re-link to a record that doesn't resolve → confirmation cleared, reverts
    const relinked = applyCloseoutOp(
      confirmed.artifact,
      { op: "link", requirementId: "cr_1", links: [{ type: "certificate", id: "cert_other" }] },
      { id: "x", at: "t3", known },
    );
    if (!relinked.ok) throw new Error("relink failed");
    expect(relinked.requirement?.confirmedAt).toBeFalsy();
    expect(relinked.requirement?.status).toBe("outstanding");
  });

  it("waive overrides derivation; un-waive re-derives", () => {
    const a = spine();
    const waived = applyCloseoutOp(a, { op: "waive", requirementId: "cr_1", waived: true }, { id: "x", at: "t", known });
    if (!waived.ok) throw new Error("waive failed");
    expect(waived.requirement?.status).toBe("waived");

    const unwaived = applyCloseoutOp(
      waived.artifact,
      { op: "waive", requirementId: "cr_1", waived: false },
      { id: "x", at: "t2", known },
    );
    if (!unwaived.ok) throw new Error("un-waive failed");
    expect(unwaived.requirement?.status).toBe("outstanding");
  });

  it("add appends a manual requirement; remove drops by id", () => {
    const a = spine();
    const added = applyCloseoutOp(
      a,
      { op: "add", title: "Smoke alarms commissioned", kind: "other" },
      { id: "cr_new", at: "t", known },
    );
    if (!added.ok) throw new Error("add failed");
    expect(added.artifact.closeoutRequirements).toHaveLength(2);
    expect(added.requirement?.source).toBe("manual");

    const removed = applyCloseoutOp(added.artifact, { op: "remove", requirementId: "cr_new" }, { id: "x", at: "t2", known });
    if (!removed.ok) throw new Error("remove failed");
    expect(removed.artifact.closeoutRequirements).toHaveLength(1);
  });

  it("remove of an unknown id reports not_found", () => {
    const res = applyCloseoutOp(spine(), { op: "remove", requirementId: "cr_nope" }, { id: "x", at: "t", known });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_found");
  });
});

describe("writeCloseout (orchestration)", () => {
  it("rejects a stale revision with 409 and writes nothing", async () => {
    const a = spine();
    const { deps, saved } = depsFor(a, { known });
    const res = await writeCloseout(deps, {
      jobId: "job-1",
      op: { op: "confirm", requirementId: "cr_1", confirmed: true },
      expectedRevision: "stale-revision",
      at: "t",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(409);
      expect(res.reason).toBe("stale_revision");
      expect(res.currentRevision).toBe(jobControlRevisionOf(a));
    }
    expect(saved()).toBeNull();
  });

  it("applies the op on a fresh revision and persists the advanced artifact", async () => {
    const a = spine();
    const { deps, saved } = depsFor(a, { known });
    const res = await writeCloseout(deps, {
      jobId: "job-1",
      op: { op: "link", requirementId: "cr_1", links: [{ type: "certificate", id: "cert_real" }] },
      expectedRevision: jobControlRevisionOf(a),
      at: "t",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.requirement?.status).toBe("in_progress");
    const written = saved();
    expect(written).not.toBeNull();
    expect(written!.workPackages).toEqual(a.workPackages);
  });

  it("404s a missing artifact (no spine to add closeout to)", async () => {
    const deps: CloseoutDeps = {
      loadRaw: async () => null,
      save: async () => {},
      mintId: () => "cr_new",
    };
    const res = await writeCloseout(deps, {
      jobId: "job-1",
      op: { op: "add", title: "x", kind: "other" },
      expectedRevision: "r",
      at: "t",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(404);
      expect(res.reason).toBe("missing");
    }
  });
});

describe("blobCloseoutDeps", () => {
  it("constructs real deps with a closeout id prefix and a known-id loader", () => {
    const deps = blobCloseoutDeps();
    expect(deps.mintId()).toMatch(/^cr_/);
    expect(typeof deps.loadKnownIds).toBe("function");
  });
});
