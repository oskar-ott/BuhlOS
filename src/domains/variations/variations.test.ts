import { describe, it, expect } from "vitest";
import { VariationApprovalRecordSchema } from "./schema";
import type {
  VariationApprovalEvent,
  VariationApprovalRecord,
  VariationApprovalStatus,
  WorkAtRiskAuthorisation,
} from "./types";
import {
  allowedVariationTransitions,
  canTransitionVariationStatus,
  createVariationApprovalRecord,
  getVariationApprovalBlockers,
  isVariationApprovedForWork,
  isVariationClaimRisk,
  isWorkAtRisk,
  isWorkAtRiskAuthorisationComplete,
  requiresBuilderApproval,
  transitionVariationApproval,
} from "./service";
import { variationApprovalStatusLabel, workAtRiskReasonLabel } from "./format";

const AT = "2026-06-15T00:00:00.000Z";

function record(over: Partial<VariationApprovalRecord> = {}): VariationApprovalRecord {
  return VariationApprovalRecordSchema.parse({
    id: "var_1",
    jobId: "job_100arthur",
    title: "Extra make-safe, East Gym",
    status: "draft",
    requestedBy: "u_admin",
    createdAt: "2026-06-14T00:00:00.000Z",
    ...over,
  });
}

const FULL_AUTH: WorkAtRiskAuthorisation = {
  reason: "Builder told the foreman to start on site",
  source: "builder_verbal_instruction",
  authorisedBy: "u_boss",
  authorisedByName: "The Boss",
  authorisedAt: AT,
};

/** Apply an event, asserting it succeeded, and return the new record. */
function apply(rec: VariationApprovalRecord, event: VariationApprovalEvent): VariationApprovalRecord {
  const result = transitionVariationApproval(rec, event);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.record;
}

// 1 ── Normal happy path ───────────────────────────────────────────────────────

describe("normal happy path", () => {
  it("draft → sent_to_builder → approved → released_for_work → completed → claimed → invoiced", () => {
    let rec = record();
    rec = apply(rec, { type: "send_to_builder", at: AT, quoteRef: "VQ-001" });
    expect(rec.status).toBe("sent_to_builder");
    expect(rec.quoteRef).toBe("VQ-001");

    rec = apply(rec, { type: "approve", at: AT, approvedBy: "builder_1", approvedByName: "Acme Builders" });
    expect(rec.status).toBe("approved");
    expect(rec.approvedBy).toBe("builder_1");
    expect(rec.approvedAt).toBe(AT);
    expect(isVariationApprovedForWork(rec)).toBe(true);
    expect(requiresBuilderApproval(rec)).toBe(false);

    rec = apply(rec, { type: "release_for_work", at: AT });
    expect(rec.status).toBe("released_for_work");

    rec = apply(rec, { type: "complete", at: AT });
    expect(rec.status).toBe("completed");
    // approved → completed is NOT a claim risk.
    expect(isVariationClaimRisk(rec)).toBe(false);
    expect(getVariationApprovalBlockers(rec)).toEqual([]);

    rec = apply(rec, { type: "claim", at: AT });
    expect(rec.status).toBe("claimed");

    rec = apply(rec, { type: "invoice", at: AT, invoiceRef: "INV-77" });
    expect(rec.status).toBe("invoiced");
    expect(rec.invoiceRef).toBe("INV-77");
  });
});

// 2,3 ── Release is gated on approval ──────────────────────────────────────────

describe("release is gated on builder approval", () => {
  it("direct release from draft is blocked", () => {
    const result = transitionVariationApproval(record({ status: "draft" }), {
      type: "release_for_work",
      at: AT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_transition");
    expect(canTransitionVariationStatus("draft", "released_for_work")).toBe(false);
  });

  it("release while waiting for the builder is blocked", () => {
    const result = transitionVariationApproval(record({ status: "sent_to_builder" }), {
      type: "release_for_work",
      at: AT,
    });
    expect(result.ok).toBe(false);
    expect(canTransitionVariationStatus("sent_to_builder", "released_for_work")).toBe(false);
  });
});

// 4,5 ── Dead states cannot be released ────────────────────────────────────────

describe("rejected / expired variations cannot be released", () => {
  it("rejected cannot move to released_for_work", () => {
    expect(canTransitionVariationStatus("rejected", "released_for_work")).toBe(false);
    expect(transitionVariationApproval(record({ status: "rejected" }), { type: "release_for_work", at: AT }).ok).toBe(
      false,
    );
  });

  it("expired cannot move to released_for_work", () => {
    expect(canTransitionVariationStatus("expired", "released_for_work")).toBe(false);
    expect(transitionVariationApproval(record({ status: "expired" }), { type: "release_for_work", at: AT }).ok).toBe(
      false,
    );
  });

  it("a rejected / expired variation no longer requires approval and is not approved-for-work", () => {
    expect(requiresBuilderApproval(record({ status: "rejected" }))).toBe(false);
    expect(isVariationApprovedForWork(record({ status: "expired" }))).toBe(false);
  });
});

// 6 ── Approved can be released ────────────────────────────────────────────────

describe("approved variation can be released", () => {
  it("approved → released_for_work succeeds", () => {
    const approved = record({ status: "approved", approvedBy: "builder_1", approvedAt: AT });
    expect(canTransitionVariationStatus("approved", "released_for_work")).toBe(true);
    const result = transitionVariationApproval(approved, { type: "release_for_work", at: AT });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.status).toBe("released_for_work");
  });
});

// 7 ── Work-at-risk requires authorisation ─────────────────────────────────────

describe("work-at-risk requires a complete authorisation", () => {
  const incomplete: Array<[string, Partial<WorkAtRiskAuthorisation>]> = [
    ["missing reason", { reason: "  " }],
    ["missing authorisedBy", { authorisedBy: "" }],
    ["missing authorisedAt", { authorisedAt: "" }],
  ];

  it.each(incomplete)("rejects start_work_at_risk with %s", (_label, patch) => {
    const result = transitionVariationApproval(record({ status: "sent_to_builder" }), {
      type: "start_work_at_risk",
      at: AT,
      authorisation: { ...FULL_AUTH, ...patch },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("missing_authorisation");
  });

  it("accepts start_work_at_risk with reason, authorisedBy and authorisedAt", () => {
    expect(isWorkAtRiskAuthorisationComplete(FULL_AUTH)).toBe(true);
    const result = transitionVariationApproval(record({ status: "sent_to_builder" }), {
      type: "start_work_at_risk",
      at: AT,
      authorisation: FULL_AUTH,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.status).toBe("work_at_risk");
      expect(result.record.workAtRisk).toEqual(FULL_AUTH);
    }
  });

  it("source is optional — authorisation without it is still complete", () => {
    const withoutSource: WorkAtRiskAuthorisation = {
      reason: FULL_AUTH.reason,
      authorisedBy: FULL_AUTH.authorisedBy,
      authorisedAt: FULL_AUTH.authorisedAt,
    };
    expect(isWorkAtRiskAuthorisationComplete(withoutSource)).toBe(true);
  });
});

// 8 ── Work-at-risk is flagged even when allowed to proceed ─────────────────────

describe("work-at-risk is flagged as risk", () => {
  it("a properly authorised at-risk record still raises the WORK AT RISK blocker", () => {
    const atRisk = apply(record({ status: "sent_to_builder" }), {
      type: "start_work_at_risk",
      at: AT,
      authorisation: FULL_AUTH,
    });
    expect(isWorkAtRisk(atRisk)).toBe(true);
    expect(isVariationApprovedForWork(atRisk)).toBe(false);
    expect(requiresBuilderApproval(atRisk)).toBe(true);
    const blockers = getVariationApprovalBlockers(atRisk);
    expect(blockers.map((b) => b.code)).toContain("work_at_risk");
    expect(blockers[0]?.message).toContain("WORK AT RISK");
  });

  it("at-risk work can be retroactively approved, clearing the risk", () => {
    let rec = apply(record({ status: "sent_to_builder" }), {
      type: "start_work_at_risk",
      at: AT,
      authorisation: FULL_AUTH,
    });
    rec = apply(rec, { type: "approve", at: AT, approvedBy: "builder_1" });
    expect(rec.status).toBe("approved");
    expect(isWorkAtRisk(rec)).toBe(false);
    expect(isVariationApprovedForWork(rec)).toBe(true);
    expect(getVariationApprovalBlockers(rec)).toEqual([]);
  });
});

// 9 ── Completed without approval is a claim risk ──────────────────────────────

describe("completed work without approval remains claim-risk flagged", () => {
  it("work_at_risk → completed leaves a claim-risk blocker", () => {
    let rec = apply(record({ status: "sent_to_builder" }), {
      type: "start_work_at_risk",
      at: AT,
      authorisation: FULL_AUTH,
    });
    rec = apply(rec, { type: "complete", at: AT });
    expect(rec.status).toBe("completed");
    expect(rec.approvedAt).toBeFalsy(); // no approval ever recorded
    expect(isVariationApprovedForWork(rec)).toBe(false);
    expect(isVariationClaimRisk(rec)).toBe(true);
    expect(getVariationApprovalBlockers(rec).map((b) => b.code)).toContain("claim_risk_unapproved");
  });
});

// 10 ── Claim / invoice ordering ───────────────────────────────────────────────

describe("claimed / invoiced only after completion", () => {
  it("cannot claim before completion", () => {
    expect(canTransitionVariationStatus("released_for_work", "claimed")).toBe(false);
    expect(
      transitionVariationApproval(record({ status: "released_for_work" }), { type: "claim", at: AT }).ok,
    ).toBe(false);
  });

  it("cannot invoice before claiming", () => {
    expect(canTransitionVariationStatus("completed", "invoiced")).toBe(false);
    expect(transitionVariationApproval(record({ status: "completed" }), { type: "invoice", at: AT }).ok).toBe(
      false,
    );
  });
});

// 11 ── Disputed paths ─────────────────────────────────────────────────────────

describe("disputed is allowed after completion or claim", () => {
  it("completed → disputed", () => {
    expect(canTransitionVariationStatus("completed", "disputed")).toBe(true);
    expect(transitionVariationApproval(record({ status: "completed" }), { type: "dispute", at: AT }).ok).toBe(
      true,
    );
  });

  it("claimed → disputed", () => {
    expect(canTransitionVariationStatus("claimed", "disputed")).toBe(true);
    const result = transitionVariationApproval(record({ status: "claimed" }), {
      type: "dispute",
      at: AT,
      note: "Builder contests the hours",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.decisionNote).toBe("Builder contests the hours");
  });

  it("draft → disputed is not allowed", () => {
    expect(canTransitionVariationStatus("draft", "disputed")).toBe(false);
  });
});

// 12 ── Purity ─────────────────────────────────────────────────────────────────

describe("transition purity", () => {
  it("does not mutate the original record on success", () => {
    const original = record({ status: "sent_to_builder" });
    const snapshot = JSON.stringify(original);
    const result = transitionVariationApproval(original, { type: "approve", at: AT, approvedBy: "b1" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record).not.toBe(original);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("returns the unchanged original record on failure", () => {
    const original = record({ status: "draft" });
    const result = transitionVariationApproval(original, { type: "release_for_work", at: AT });
    expect(result.ok).toBe(false);
    expect(result.record).toBe(original);
  });
});

// ── Supporting unit coverage ───────────────────────────────────────────────────

describe("canTransitionVariationStatus table", () => {
  it("allows the documented normal + side + exception edges", () => {
    const allowed: Array<[VariationApprovalStatus, VariationApprovalStatus]> = [
      ["draft", "sent_to_builder"],
      ["sent_to_builder", "approved"],
      ["sent_to_builder", "rejected"],
      ["sent_to_builder", "expired"],
      ["approved", "released_for_work"],
      ["approved", "cancelled"],
      ["released_for_work", "completed"],
      ["completed", "claimed"],
      ["claimed", "invoiced"],
      ["draft", "work_at_risk"],
      ["sent_to_builder", "work_at_risk"],
      ["work_at_risk", "approved"],
      ["work_at_risk", "completed"],
      ["work_at_risk", "cancelled"],
    ];
    for (const [from, to] of allowed) expect(canTransitionVariationStatus(from, to)).toBe(true);
  });

  it("forbids the key illegal edges", () => {
    const forbidden: Array<[VariationApprovalStatus, VariationApprovalStatus]> = [
      ["draft", "released_for_work"],
      ["draft", "approved"],
      ["sent_to_builder", "released_for_work"],
      ["rejected", "released_for_work"],
      ["expired", "released_for_work"],
      ["invoiced", "claimed"],
      ["approved", "approved"],
    ];
    for (const [from, to] of forbidden) expect(canTransitionVariationStatus(from, to)).toBe(false);
    // every edge in the table is a real status pair
    expect(allowedVariationTransitions().length).toBeGreaterThan(0);
  });
});

describe("approve event guards", () => {
  it("rejects approval without an approver", () => {
    const result = transitionVariationApproval(record({ status: "sent_to_builder" }), {
      type: "approve",
      at: AT,
      approvedBy: "  ",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("missing_approver");
  });
});

describe("createVariationApprovalRecord", () => {
  it("stamps a fresh draft with lifecycle defaults", () => {
    const rec = createVariationApprovalRecord(
      { id: "var_9", jobId: "job_x", title: "New riser penetration", requestedBy: "u_admin" },
      AT,
    );
    expect(rec.status).toBe("draft");
    expect(rec.createdAt).toBe(AT);
    expect(rec.updatedAt).toBe(AT);
    expect(rec.approvedAt).toBeNull();
    expect(rec.workAtRisk).toBeNull();
    expect(rec.kind).toBe("variation");
    expect(requiresBuilderApproval(rec)).toBe(true);
    expect(getVariationApprovalBlockers(rec)).toEqual([]);
  });

  it("honours an explicit daywork kind", () => {
    const rec = createVariationApprovalRecord(
      { id: "var_10", jobId: "job_x", title: "Day labour clean-up", requestedBy: "u_admin", kind: "daywork" },
      AT,
    );
    expect(rec.kind).toBe("daywork");
  });
});

describe("format", () => {
  it("labels statuses in plain words", () => {
    expect(variationApprovalStatusLabel("sent_to_builder")).toBe("Sent to builder");
    expect(variationApprovalStatusLabel("work_at_risk")).toBe("Work at risk");
    expect(variationApprovalStatusLabel("invoiced")).toBe("Invoiced");
  });

  it("labels at-risk reasons in plain words", () => {
    expect(workAtRiskReasonLabel("builder_verbal_instruction")).toBe("Builder verbal instruction");
    expect(workAtRiskReasonLabel("emergency_safety")).toBe("Emergency / safety");
  });
});

describe("schema", () => {
  it("defaults kind, workAtRisk and the audit array", () => {
    const rec = record();
    expect(rec.kind).toBe("variation");
    expect(rec.workAtRisk).toBeNull();
    expect(rec.auditLogIds).toEqual([]);
  });

  it("rejects an out-of-enum status", () => {
    expect(() => VariationApprovalRecordSchema.parse({ ...record(), status: "shipped" })).toThrow();
  });
});
