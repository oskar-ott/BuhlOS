import { describe, expect, it } from "vitest";
import {
  runCloseoutMatrixView,
  shapeCloseoutMatrix,
  type CloseoutReadDeps,
  type LoadCloseoutResult,
} from "./closeout-read";
import { PersistedJobControlSchema, type PersistedJobControl } from "./compile-producer";
import type { CloseoutKnownIds } from "@/domains/job-control/closeout-matrix";

/** A spine with four closeout requirements covering every status path:
 *   cr_sat   — resolving link + confirmed → satisfied
 *   cr_prog  — resolving link, NOT confirmed → in_progress
 *   cr_dang  — confirmed but its link is gone → reverts to in_progress
 *   cr_out   — nothing → outstanding
 *  plus a waived one. */
function spine(): PersistedJobControl {
  return PersistedJobControlSchema.parse({
    jobId: "job-1",
    workPackages: [],
    claimLines: [],
    closeoutRequirements: [
      {
        id: "cr_sat",
        jobId: "job-1",
        title: "Certificate of electrical safety issued",
        kind: "certificate",
        source: "manual",
        fulfilmentLinks: [{ type: "certificate", id: "cert_real" }],
        confirmedAt: "2026-06-28T00:00:00.000Z",
        confirmedBy: "boss",
        status: "satisfied",
        order: 0,
      },
      {
        id: "cr_prog",
        jobId: "job-1",
        title: "Test results recorded",
        kind: "evidence",
        source: "manual",
        fulfilmentLinks: [{ type: "evidence", id: "ev_real" }],
        status: "in_progress",
        order: 1,
      },
      {
        id: "cr_dang",
        jobId: "job-1",
        title: "As-builts issued",
        kind: "document",
        source: "clause",
        scopeClauseIds: ["c9"],
        fulfilmentLinks: [{ type: "as-built", id: "doc_deleted" }],
        confirmedAt: "2026-06-28T00:00:00.000Z",
        confirmedBy: "boss",
        // stored as satisfied — but the doc is gone; the read must REVERT it.
        status: "satisfied",
        order: 2,
      },
      {
        id: "cr_out",
        jobId: "job-1",
        title: "O&M manuals handed over",
        kind: "document",
        source: "manual",
        status: "outstanding",
        order: 3,
      },
      {
        id: "cr_waived",
        jobId: "job-1",
        title: "Site-specific deviation",
        kind: "other",
        source: "clause",
        status: "waived",
        order: 4,
      },
    ],
    evidenceLinks: [],
    proofReviews: [],
  });
}

// Live ids: the cert + evidence exist; the as-built document was deleted.
const known: CloseoutKnownIds = {
  certificateIds: ["cert_real"],
  documentIds: [],
  evidenceIds: ["ev_real"],
  itpInstanceIds: [],
};

function loaded(value: PersistedJobControl): LoadCloseoutResult {
  return { status: "ok", value };
}

describe("shapeCloseoutMatrix", () => {
  it("returns 'missing' when no spine exists", () => {
    const v = shapeCloseoutMatrix({ status: "absent" }, "job-1");
    expect(v.status).toBe("missing");
  });

  it("returns 'unreadable' when the spine fails to parse", () => {
    const v = shapeCloseoutMatrix({ status: "unreadable" }, "job-1");
    expect(v.status).toBe("unreadable");
  });

  it("re-derives status (dangling reverts) and tallies honest N-of-M", () => {
    const v = shapeCloseoutMatrix(loaded(spine()), "job-1", known);
    if (v.status !== "ready") throw new Error("expected ready");

    const byId = Object.fromEntries(v.requirements.map((r) => [r.id, r]));
    expect(byId.cr_sat!.status).toBe("satisfied");
    expect(byId.cr_prog!.status).toBe("in_progress");
    // confirmed-but-dangling REVERTS — never trusts the stored 'satisfied'.
    expect(byId.cr_dang!.status).toBe("in_progress");
    expect(byId.cr_dang!.hasDanglingLink).toBe(true);
    expect(byId.cr_out!.status).toBe("outstanding");
    expect(byId.cr_waived!.status).toBe("waived");

    // Discharged = satisfied + waived = cr_sat + cr_waived = 2 of 5.
    expect(v.counts).toMatchObject({
      total: 5,
      satisfied: 1,
      inProgress: 2,
      outstanding: 1,
      waived: 1,
      discharged: 2,
    });
    expect(v.counts.fractionDischarged).toBeCloseTo(2 / 5);

    // Outstanding list = the not-yet-discharged (outstanding + in_progress).
    expect(v.outstanding.map((r) => r.id).sort()).toEqual(["cr_dang", "cr_out", "cr_prog"]);
  });

  it("marks a link resolved/dangling per the live id set", () => {
    const v = shapeCloseoutMatrix(loaded(spine()), "job-1", known);
    if (v.status !== "ready") throw new Error("expected ready");
    const sat = v.requirements.find((r) => r.id === "cr_sat")!;
    expect(sat.links[0]).toMatchObject({ type: "certificate", id: "cert_real", resolved: true });
    const dang = v.requirements.find((r) => r.id === "cr_dang")!;
    expect(dang.links[0]!.resolved).toBe(false);
  });

  it("fractionDischarged is null for an empty matrix (no fake 0%)", () => {
    const empty = PersistedJobControlSchema.parse({ jobId: "job-1", closeoutRequirements: [] });
    const v = shapeCloseoutMatrix(loaded(empty), "job-1", {});
    if (v.status !== "ready") throw new Error("expected ready");
    expect(v.counts.total).toBe(0);
    expect(v.counts.fractionDischarged).toBeNull();
  });
});

describe("runCloseoutMatrixView", () => {
  it("falls back to no-check when the known-id loader throws (never crashes the page)", async () => {
    const deps: CloseoutReadDeps = {
      loadArtifact: async () => loaded(spine()),
      loadKnownIds: async () => {
        throw new Error("blob down");
      },
    };
    const v = await runCloseoutMatrixView(deps, "job-1");
    if (!v.ok || v.status !== "ready") throw new Error("expected ready");
    // With no known ids, NOTHING resolves → satisfied count is 0 (fail-closed).
    expect(v.counts.satisfied).toBe(0);
  });

  it("returns ok:false when the artifact read itself throws", async () => {
    const deps: CloseoutReadDeps = {
      loadArtifact: async () => {
        throw new Error("blob down");
      },
    };
    const v = await runCloseoutMatrixView(deps, "job-1");
    expect(v.ok).toBe(false);
  });

  it("threads the loaded link options into the ready view (the picker's source)", async () => {
    const deps: CloseoutReadDeps = {
      loadArtifact: async () => loaded(spine()),
      loadLinkOptions: async () => [
        { type: "certificate", id: "cert_real", label: "CoES — main board" },
        { type: "document", id: "doc_1", label: "As-built A1" },
      ],
    };
    const v = await runCloseoutMatrixView(deps, "job-1");
    if (!v.ok || v.status !== "ready") throw new Error("expected ready");
    expect(v.linkOptions.map((o) => o.id)).toEqual(["cert_real", "doc_1"]);
  });

  it("falls back to no options when the link-options loader throws (never crashes)", async () => {
    const deps: CloseoutReadDeps = {
      loadArtifact: async () => loaded(spine()),
      loadLinkOptions: async () => {
        throw new Error("blob down");
      },
    };
    const v = await runCloseoutMatrixView(deps, "job-1");
    if (!v.ok || v.status !== "ready") throw new Error("expected ready");
    expect(v.linkOptions).toEqual([]);
  });
});
