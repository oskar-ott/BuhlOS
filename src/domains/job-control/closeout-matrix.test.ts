import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLOSEOUT_REQUIREMENTS,
  deriveCloseoutStatus,
  resolveCloseoutLinks,
  seedCloseoutRequirements,
} from "./closeout-matrix";
import type { CloseoutRequirement } from "./types";
import type { ScopeClauseClassification } from "./reconciliation";

function clause(
  clauseId: string,
  classification: ScopeClauseClassification["classification"],
  extra: Partial<ScopeClauseClassification> = {},
): ScopeClauseClassification {
  return {
    clauseId,
    classification,
    boqLineRefs: [],
    documentIds: [],
    deliveredBy: [],
    requiredEvidence: [],
    ...extra,
  };
}

describe("seedCloseoutRequirements", () => {
  it("seeds the standing electrical defaults, tagged source:manual, all outstanding", () => {
    const reqs = seedCloseoutRequirements({ jobId: "job-1", clauseClassifications: [] });
    expect(reqs).toHaveLength(DEFAULT_CLOSEOUT_REQUIREMENTS.length);
    expect(reqs.every((r) => r.source === "manual")).toBe(true);
    expect(reqs.every((r) => r.status === "outstanding")).toBe(true);
    expect(reqs.every((r) => r.fulfilmentLinks.length === 0)).toBe(true);
    expect(reqs.map((r) => r.title)).toContain("Certificate of electrical safety issued");
  });

  it("adds one requirement per 'closeout' clause (and only those), tagged source:clause", () => {
    const reqs = seedCloseoutRequirements({
      jobId: "job-1",
      clauseClassifications: [
        clause("c1", "priced"),
        clause("c2", "closeout", { warningText: "Issue as-builts for the main board" }),
        clause("c3", "excluded"),
        clause("c4", "closeout", { note: "O&M manual to the builder" }),
      ],
      defaults: [], // isolate the clause-seeded set
    });
    expect(reqs).toHaveLength(2);
    expect(reqs.every((r) => r.source === "clause")).toBe(true);
    expect(reqs.map((r) => r.scopeClauseIds[0])).toEqual(["c2", "c4"]);
    // The clause's own warning/note is the honest title, not invented prose.
    expect(reqs[0]!.title).toBe("Issue as-builts for the main board");
    expect(reqs[1]!.title).toBe("O&M manual to the builder");
  });

  it("is idempotent on id: re-seeding the same clause yields the same id", () => {
    const input = {
      jobId: "job-1",
      clauseClassifications: [clause("c2", "closeout")],
      defaults: [],
    };
    const a = seedCloseoutRequirements(input);
    const b = seedCloseoutRequirements(input);
    expect(a[0]!.id).toBe(b[0]!.id);
    // and a default's id is stable too
    const d1 = seedCloseoutRequirements({ jobId: "x", clauseClassifications: [] });
    const d2 = seedCloseoutRequirements({ jobId: "y", clauseClassifications: [] });
    expect(d1.map((r) => r.id)).toEqual(d2.map((r) => r.id));
  });
});

describe("deriveCloseoutStatus", () => {
  const base: Pick<CloseoutRequirement, "fulfilmentLinks" | "confirmedAt" | "status"> = {
    fulfilmentLinks: [],
    confirmedAt: null,
    status: "outstanding",
  };

  it("is 'outstanding' with no links and no confirmation", () => {
    expect(deriveCloseoutStatus(base, {})).toBe("outstanding");
  });

  it("is 'in_progress' when a link resolves but no admin has confirmed", () => {
    const req = { ...base, fulfilmentLinks: [{ type: "certificate" as const, id: "cert_1" }] };
    expect(deriveCloseoutStatus(req, { certificateIds: ["cert_1"] })).toBe("in_progress");
  });

  it("is 'satisfied' ONLY when a link resolves AND an admin confirmed", () => {
    const req = {
      ...base,
      fulfilmentLinks: [{ type: "document" as const, id: "doc_1" }],
      confirmedAt: "2026-06-28T00:00:00.000Z",
    };
    expect(deriveCloseoutStatus(req, { documentIds: ["doc_1"] })).toBe("satisfied");
  });

  it("REVERTS a confirmed-but-dangling requirement to in_progress (never trusts the stored flag)", () => {
    // Stored as satisfied + confirmed, but the linked record is gone from the
    // live id set → must NOT stay green.
    const req = {
      fulfilmentLinks: [{ type: "evidence" as const, id: "ev_deleted" }],
      confirmedAt: "2026-06-28T00:00:00.000Z",
      status: "satisfied" as const,
    };
    expect(deriveCloseoutStatus(req, { evidenceIds: [] })).toBe("in_progress");
  });

  it("treats a link as unresolved when no id set was supplied for its type (fail-closed)", () => {
    const req = {
      ...base,
      fulfilmentLinks: [{ type: "itp-instance" as const, id: "itp_1" }],
      confirmedAt: "2026-06-28T00:00:00.000Z",
    };
    // No itpInstanceIds supplied → link can't resolve → not satisfied.
    expect(deriveCloseoutStatus(req, { documentIds: ["itp_1"] })).toBe("in_progress");
  });

  it("resolves an as-built link against the documents id set", () => {
    const req = {
      ...base,
      fulfilmentLinks: [{ type: "as-built" as const, id: "doc_ab" }],
      confirmedAt: "2026-06-28T00:00:00.000Z",
    };
    expect(deriveCloseoutStatus(req, { documentIds: ["doc_ab"] })).toBe("satisfied");
  });

  it("keeps a 'waived' requirement waived regardless of links", () => {
    expect(deriveCloseoutStatus({ ...base, status: "waived" }, {})).toBe("waived");
    expect(
      deriveCloseoutStatus(
        {
          fulfilmentLinks: [{ type: "certificate" as const, id: "cert_1" }],
          confirmedAt: "2026-06-28T00:00:00.000Z",
          status: "waived" as const,
        },
        { certificateIds: ["cert_1"] },
      ),
    ).toBe("waived");
  });
});

describe("resolveCloseoutLinks", () => {
  it("partitions links into resolved vs dangling", () => {
    const { resolved, dangling } = resolveCloseoutLinks(
      {
        fulfilmentLinks: [
          { type: "certificate", id: "cert_ok" },
          { type: "certificate", id: "cert_gone" },
        ],
      },
      { certificateIds: ["cert_ok"] },
    );
    expect(resolved.map((l) => l.id)).toEqual(["cert_ok"]);
    expect(dangling.map((l) => l.id)).toEqual(["cert_gone"]);
  });
});
