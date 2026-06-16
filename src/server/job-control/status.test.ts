import { describe, expect, it, vi } from "vitest";
import { PersistedJobControlSchema, type PersistedJobControl } from "./compile-producer";
import {
  blobProofStatusDeps,
  runProofStatus,
  shapeProofStatus,
  type LoadArtifactResult,
  type ProofStatusDeps,
} from "./status";

/** A compiled artifact: wp_1 has a MET proof (re_met) + a NEEDED proof (re_needed),
 *  wp_2 has no required proof. evidenceLinks include a non-matching link and a
 *  link with no proof id — neither must mark anything met. */
function artifact(): PersistedJobControl {
  return PersistedJobControlSchema.parse({
    jobId: "job_1",
    workPackages: [
      {
        id: "wp_1",
        jobId: "job_1",
        title: "East Gym",
        scopeClauseIds: ["sw_zip"],
        requiredEvidence: [
          { id: "re_met", label: "Photo of board", kind: "photo" },
          { id: "re_needed", label: "Test results", kind: "test_result", note: "before energising" },
        ],
      },
      { id: "wp_2", jobId: "job_1", title: "Reception", scopeClauseIds: ["sw_av"] },
    ],
    evidenceLinks: [
      {
        id: "el_1",
        jobId: "job_1",
        workPackageId: "wp_1",
        requiredEvidenceId: "re_met",
        evidenceId: "ev_123",
        role: "progress",
        createdAt: "2026-06-16T01:00:00.000Z",
        createdBy: "Sparky",
      },
      // matching ids but NO proof → must NOT mark re_needed met
      { id: "el_2", jobId: "job_1", workPackageId: "wp_1", requiredEvidenceId: "re_needed", role: "progress" },
      // a proof for a DIFFERENT requirement → must be ignored
      {
        id: "el_3",
        jobId: "job_1",
        workPackageId: "wp_1",
        requiredEvidenceId: "re_other",
        evidenceId: "ev_999",
        role: "progress",
      },
    ],
    compileMeta: {
      generatedAt: "2026-06-15T00:00:00.000Z",
      confirmedAt: "2026-06-16T00:00:00.000Z",
      confirmedBy: "Boss",
      compilerVersion: "1",
      sourceHash: "sh",
      sourceReconciliationHash: "srh",
      sourceStructureHash: "ssh",
      gaps: [{ kind: "unclassified_clause", message: "clause x unclassified" }],
      diff: { added: 1, updated: 0, removed: 0 },
    },
    revision: "rev_1",
  });
}

describe("shapeProofStatus — missing / unreadable", () => {
  it("maps an absent artifact to status:missing", () => {
    expect(shapeProofStatus({ status: "absent" }, "job_1")).toEqual({
      ok: true,
      jobId: "job_1",
      status: "missing",
    });
  });

  it("maps an unreadable artifact to status:unreadable (surfaced, not silently empty)", () => {
    expect(shapeProofStatus({ status: "unreadable" }, "job_1")).toEqual({
      ok: true,
      jobId: "job_1",
      status: "unreadable",
    });
  });
});

describe("shapeProofStatus — compiled needed/met derivation", () => {
  const r = shapeProofStatus({ status: "ok", value: artifact() }, "job_1");
  if (r.ok !== true || r.status !== "compiled") throw new Error("expected compiled");

  it("counts work packages, proofs, met/needed and links", () => {
    expect(r.workPackageCount).toBe(2);
    expect(r.requiredProofTotal).toBe(2);
    expect(r.metCount).toBe(1);
    expect(r.neededCount).toBe(1);
    expect(r.evidenceLinkCount).toBe(3);
  });

  it("marks a requirement MET only when a matching link carries a real proof, and attaches it", () => {
    const wp1 = r.workPackages.find((w) => w.id === "wp_1")!;
    const met = wp1.requiredEvidence.find((e) => e.id === "re_met")!;
    expect(met.status).toBe("met");
    expect(met.evidenceLinks).toEqual([
      { evidenceId: "ev_123", observationId: null, linkedAt: "2026-06-16T01:00:00.000Z", linkedBy: "Sparky" },
    ]);
  });

  it("leaves a requirement NEEDED when its only link has no proof id; ignores non-matching links", () => {
    const wp1 = r.workPackages.find((w) => w.id === "wp_1")!;
    const needed = wp1.requiredEvidence.find((e) => e.id === "re_needed")!;
    expect(needed.status).toBe("needed");
    expect(needed.evidenceLinks).toEqual([]); // el_2 has no proof; el_3 is a different requirement
  });

  it("carries admin provenance (revision, source hashes, gap count, confirmed-by)", () => {
    expect(r.revision).toBe("rev_1");
    expect(r.sourceHash).toBe("sh");
    expect(r.sourceReconciliationHash).toBe("srh");
    expect(r.sourceStructureHash).toBe("ssh");
    expect(r.confirmedBy).toBe("Boss");
    expect(r.gapCount).toBe(1);
  });

  it("does not leak office-internal compile fields or any secret/token", () => {
    const json = JSON.stringify(r);
    expect(json).not.toContain("compilerVersion");
    expect(json).not.toMatch(/token/i);
    // diff is office-only provenance — not in the field/admin status view
    expect(r).not.toHaveProperty("diff");
  });
});

describe("shapeProofStatus — edge cases (provenance, observation, zero-proof, cross-WP)", () => {
  function oneReq(links: Array<Record<string, unknown>>, reqs = [{ id: "re_1", label: "Proof", kind: "photo" }]) {
    return PersistedJobControlSchema.parse({
      jobId: "job_1",
      workPackages: [
        { id: "wp_1", jobId: "job_1", title: "Area 1", scopeClauseIds: ["sw_1"], requiredEvidence: reqs },
        { id: "wp_2", jobId: "job_1", title: "Area 2", scopeClauseIds: ["sw_2"] },
      ],
      evidenceLinks: links,
      revision: "rev_1",
    });
  }

  it("MET via a link with NO createdAt/createdBy → met, provenance nulls preserved (no 'by null')", () => {
    const r = shapeProofStatus(
      { status: "ok", value: oneReq([{ id: "el", jobId: "job_1", workPackageId: "wp_1", requiredEvidenceId: "re_1", evidenceId: "ev_x", role: "progress" }]) },
      "job_1",
    );
    if (r.ok !== true || r.status !== "compiled") throw new Error("compiled");
    const req = r.workPackages[0]!.requiredEvidence[0]!;
    expect(req.status).toBe("met");
    expect(req.evidenceLinks).toEqual([{ evidenceId: "ev_x", observationId: null, linkedAt: null, linkedBy: null }]);
  });

  it("MET via an OBSERVATION (no evidenceId) — observationId is first-class proof", () => {
    const r = shapeProofStatus(
      { status: "ok", value: oneReq([{ id: "el", jobId: "job_1", workPackageId: "wp_1", requiredEvidenceId: "re_1", observationId: "ob_y", role: "progress" }]) },
      "job_1",
    );
    if (r.ok !== true || r.status !== "compiled") throw new Error("compiled");
    const req = r.workPackages[0]!.requiredEvidence[0]!;
    expect(req.status).toBe("met");
    expect(req.evidenceLinks).toEqual([{ evidenceId: null, observationId: "ob_y", linkedAt: null, linkedBy: null }]);
  });

  it("does NOT attach a same-requirement link that names a DIFFERENT work package (wp.id filter)", () => {
    const r = shapeProofStatus(
      {
        status: "ok",
        value: oneReq([
          { id: "el_ok", jobId: "job_1", workPackageId: "wp_1", requiredEvidenceId: "re_1", evidenceId: "ev_a", role: "progress" },
          // same requiredEvidenceId, but on wp_2 — must not attach to wp_1's re_1
          { id: "el_cross", jobId: "job_1", workPackageId: "wp_2", requiredEvidenceId: "re_1", evidenceId: "ev_b", role: "progress" },
        ]),
      },
      "job_1",
    );
    if (r.ok !== true || r.status !== "compiled") throw new Error("compiled");
    const req = r.workPackages[0]!.requiredEvidence[0]!;
    expect(req.status).toBe("met");
    expect(req.evidenceLinks.map((l) => l.evidenceId)).toEqual(["ev_a"]); // ev_b not mis-attached
  });

  it("a compiled artifact whose work packages carry NO required proof → compiled, all counts zero", () => {
    const r = shapeProofStatus(
      { status: "ok", value: oneReq([], []) }, // wp_1 with empty requiredEvidence, wp_2 none
      "job_1",
    );
    expect(r).toMatchObject({
      ok: true,
      status: "compiled",
      requiredProofTotal: 0,
      neededCount: 0,
      metCount: 0,
      workPackageCount: 2,
    });
  });
});

describe("runProofStatus (deps orchestration)", () => {
  it("shapes a loaded artifact", async () => {
    const deps: ProofStatusDeps = { loadArtifact: async () => ({ status: "ok", value: artifact() }) };
    const r = await runProofStatus(deps, "job_1");
    expect(r.ok).toBe(true);
    if (r.ok !== true || r.status !== "compiled") return;
    expect(r.metCount).toBe(1);
  });

  it("is total — a Blob read error becomes ok:false (distinct from missing)", async () => {
    const deps: ProofStatusDeps = {
      loadArtifact: async () => {
        throw new Error("blob down");
      },
    };
    expect(await runProofStatus(deps, "job_1")).toEqual({
      ok: false,
      error: "Could not read job-control status.",
    });
  });

  it("passes an absent load through as missing", async () => {
    const deps: ProofStatusDeps = { loadArtifact: async () => ({ status: "absent" }) as LoadArtifactResult };
    const r = await runProofStatus(deps, "job_1");
    expect(r).toMatchObject({ ok: true, status: "missing" });
  });
});

describe("blobProofStatusDeps", () => {
  it("exposes a read-only loader", () => {
    const deps = blobProofStatusDeps();
    expect(typeof deps.loadArtifact).toBe("function");
    // there is no writer on the deps surface — this reader never writes
    expect(Object.keys(deps)).toEqual(["loadArtifact"]);
    expect(vi.isMockFunction(deps.loadArtifact)).toBe(false);
  });
});
