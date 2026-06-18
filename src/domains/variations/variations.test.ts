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

// ─────────────────────────────────────────────────────────────────────────────
// Variation CLAIM module (#280) — the billable claim (scope/value/evidence)
// that sits beside the approval-state workflow above.
// ─────────────────────────────────────────────────────────────────────────────

import { VariationClaimRecordSchema } from "./claim-schema";
import type {
  VariationApprovalEvidence,
  VariationClaimRecord,
} from "./claim-types";
import {
  canTransitionClaimStatus,
  createVariationClaim,
  isApprovalEvidenceComplete,
  nextClaimRef,
  summariseVariationClaims,
  transitionVariationClaim,
} from "./claim-service";
import { formatClaimValue, variationClaimStatusLabel } from "./claim-format";

const CLAIM_AT = "2026-06-19T00:00:00.000Z";

function claim(over: Partial<VariationClaimRecord> = {}): VariationClaimRecord {
  return VariationClaimRecordSchema.parse({
    id: "vc_1",
    jobId: "job_100arthur",
    ref: "VO-001",
    scope: "Extra GPOs, East Gym",
    status: "draft",
    valueCents: 123450,
    createdAt: "2026-06-18T00:00:00.000Z",
    ...over,
  });
}

const FULL_EVIDENCE: VariationApprovalEvidence = {
  approvedBy: "Jane Builder",
  approvedAt: "2026-06-19T01:00:00.000Z",
  method: "email",
  reference: "RE: VO-001 approved — see thread",
};

describe("claim factory + schema", () => {
  it("stamps a draft claim with the supplied ref + value + empty links", () => {
    const rec = createVariationClaim(
      {
        id: "vc_2",
        jobId: "job-1",
        ref: "VO-002",
        scope: "Move the board",
        valueCents: 50000,
        createdById: "u_admin",
        createdByName: "Admin",
      },
      CLAIM_AT,
    );
    expect(rec.status).toBe("draft");
    expect(rec.ref).toBe("VO-002");
    expect(rec.valueCents).toBe(50000);
    expect(rec.approval).toBeNull();
    expect(rec.links).toEqual({ observationId: null, evidenceIds: [], documentIds: [] });
    expect(rec.createdAt).toBe(CLAIM_AT);
    expect(rec.auditLogIds).toEqual([]);
  });

  it("defaults valueCents to null and the audit array to empty", () => {
    const rec = VariationClaimRecordSchema.parse({
      id: "vc_x",
      jobId: "j",
      ref: "VO-009",
      scope: "s",
      status: "draft",
      createdAt: CLAIM_AT,
    });
    expect(rec.valueCents).toBeNull();
    expect(rec.auditLogIds).toEqual([]);
    expect(rec.approval).toBeNull();
  });

  it("rejects an out-of-enum claim status", () => {
    expect(() =>
      VariationClaimRecordSchema.parse({ ...claim(), status: "shipped" }),
    ).toThrow();
  });

  it("rejects a non-integer valueCents", () => {
    expect(() =>
      VariationClaimRecordSchema.parse({ ...claim(), valueCents: 12.5 }),
    ).toThrow();
  });
});

describe("nextClaimRef — collision-safe, zero-padded", () => {
  it("starts at VO-001 with no existing claims", () => {
    expect(nextClaimRef([])).toBe("VO-001");
  });

  it("takes max+1, not count+1 (a removed claim never re-mints a live ref)", () => {
    // count is 2 but the live refs are VO-001 and VO-005 → next is VO-006.
    expect(nextClaimRef([{ ref: "VO-001" }, { ref: "VO-005" }])).toBe("VO-006");
  });

  it("ignores malformed refs", () => {
    expect(nextClaimRef([{ ref: "garbage" }, { ref: null }, { ref: "VO-003" }])).toBe("VO-004");
  });

  it("zero-pads to three digits and grows past them", () => {
    expect(nextClaimRef([{ ref: "VO-009" }])).toBe("VO-010");
    expect(nextClaimRef([{ ref: "VO-999" }])).toBe("VO-1000");
  });
});

describe("claim transition table", () => {
  it("allows the forward pipeline incl. the skip-quote shortcut", () => {
    expect(canTransitionClaimStatus("draft", "quoted")).toBe(true);
    expect(canTransitionClaimStatus("draft", "submitted")).toBe(true);
    expect(canTransitionClaimStatus("quoted", "submitted")).toBe(true);
    expect(canTransitionClaimStatus("submitted", "approved")).toBe(true);
    expect(canTransitionClaimStatus("submitted", "rejected")).toBe(true);
    expect(canTransitionClaimStatus("approved", "invoiced")).toBe(true);
  });

  it("allows re-work back to draft from quoted/submitted/rejected", () => {
    expect(canTransitionClaimStatus("quoted", "draft")).toBe(true);
    expect(canTransitionClaimStatus("submitted", "draft")).toBe(true);
    expect(canTransitionClaimStatus("rejected", "draft")).toBe(true);
  });

  it("forbids skipping the gate (draft → approved) and going backwards from invoiced", () => {
    expect(canTransitionClaimStatus("draft", "approved")).toBe(false);
    expect(canTransitionClaimStatus("draft", "invoiced")).toBe(false);
    expect(canTransitionClaimStatus("invoiced", "draft")).toBe(false);
    expect(canTransitionClaimStatus("approved", "rejected")).toBe(false);
  });
});

describe("approval-evidence gate", () => {
  it("isApprovalEvidenceComplete requires all four fields + a valid method", () => {
    expect(isApprovalEvidenceComplete(FULL_EVIDENCE)).toBe(true);
    expect(isApprovalEvidenceComplete(null)).toBe(false);
    expect(isApprovalEvidenceComplete({ ...FULL_EVIDENCE, approvedBy: "" })).toBe(false);
    expect(isApprovalEvidenceComplete({ ...FULL_EVIDENCE, approvedAt: "  " })).toBe(false);
    expect(isApprovalEvidenceComplete({ ...FULL_EVIDENCE, reference: "" })).toBe(false);
    expect(
      isApprovalEvidenceComplete({
        ...FULL_EVIDENCE,
        method: "carrier-pigeon" as VariationApprovalEvidence["method"],
      }),
    ).toBe(false);
  });

  it("approve WITHOUT evidence is rejected and leaves the record untouched", () => {
    const submitted = claim({ status: "submitted" });
    const r = transitionVariationClaim(submitted, {
      type: "approve",
      at: CLAIM_AT,
      approval: { ...FULL_EVIDENCE, reference: "" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("missing_approval_evidence");
    expect(r.record.status).toBe("submitted");
    expect(r.record.approval).toBeNull();
  });

  it("approve WITH evidence stamps the evidence and moves to approved", () => {
    const submitted = claim({ status: "submitted" });
    const r = transitionVariationClaim(submitted, {
      type: "approve",
      at: CLAIM_AT,
      approval: FULL_EVIDENCE,
    });
    expect(r.ok).toBe(true);
    expect(r.record.status).toBe("approved");
    expect(r.record.approval).toEqual(FULL_EVIDENCE);
    expect(r.record.updatedAt).toBe(CLAIM_AT);
  });

  it("does not mutate the input record", () => {
    const submitted = claim({ status: "submitted" });
    transitionVariationClaim(submitted, { type: "approve", at: CLAIM_AT, approval: FULL_EVIDENCE });
    expect(submitted.status).toBe("submitted");
    expect(submitted.approval).toBeNull();
  });
});

describe("invoice transition", () => {
  it("rejects marking invoiced without a reference", () => {
    const approved = claim({ status: "approved", approval: FULL_EVIDENCE });
    const r = transitionVariationClaim(approved, { type: "invoice", at: CLAIM_AT, invoiceRef: "  " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("missing_invoice_ref");
    expect(r.record.status).toBe("approved");
  });

  it("stores a trimmed manual invoice reference", () => {
    const approved = claim({ status: "approved", approval: FULL_EVIDENCE });
    const r = transitionVariationClaim(approved, {
      type: "invoice",
      at: CLAIM_AT,
      invoiceRef: "  INV-2026-0042  ",
    });
    expect(r.ok).toBe(true);
    expect(r.record.status).toBe("invoiced");
    expect(r.record.invoiceRef).toBe("INV-2026-0042");
    expect(r.record.invoicedAt).toBe(CLAIM_AT);
  });

  it("rejects an invalid structural transition (draft → invoiced)", () => {
    const r = transitionVariationClaim(claim({ status: "draft" }), {
      type: "invoice",
      at: CLAIM_AT,
      invoiceRef: "INV-1",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_transition");
  });
});

describe("summariseVariationClaims — integer-cents rollup, no float drift", () => {
  it("buckets value by status and never floats", () => {
    const list = [
      claim({ id: "a", status: "draft", valueCents: 10000 }),
      claim({ id: "b", status: "quoted", valueCents: 20000 }),
      claim({ id: "c", status: "submitted", valueCents: 30000 }),
      claim({ id: "d", status: "approved", valueCents: 40000, approval: FULL_EVIDENCE }),
      claim({ id: "e", status: "invoiced", valueCents: 50000, invoiceRef: "INV-1" }),
      claim({ id: "f", status: "rejected", valueCents: 60000 }),
    ];
    const r = summariseVariationClaims(list);
    expect(r.openCents).toBe(60000); // draft + quoted + submitted
    expect(r.approvedCents).toBe(40000);
    expect(r.invoicedCents).toBe(50000);
    expect(r.lostCents).toBe(60000);
    expect(r.totalCents).toBe(150000); // open + approved + invoiced (not lost)
    expect(r.total).toBe(6);
    expect(r.counts.draft).toBe(1);
    expect(r.counts.rejected).toBe(1);
    // The hazard a float convention would hit: 0.1 + 0.2 ≠ 0.3 in dollars.
    const cents = summariseVariationClaims([
      claim({ id: "g", status: "draft", valueCents: 10 }),
      claim({ id: "h", status: "draft", valueCents: 20 }),
    ]);
    expect(cents.openCents).toBe(30);
  });

  it("treats a null value as 0 and counts an empty list cleanly", () => {
    const r = summariseVariationClaims([claim({ status: "draft", valueCents: null })]);
    expect(r.openCents).toBe(0);
    const empty = summariseVariationClaims([]);
    expect(empty.total).toBe(0);
    expect(empty.totalCents).toBe(0);
    expect(empty.counts.approved).toBe(0);
  });
});

describe("claim format helpers", () => {
  it("labels every status in site language", () => {
    expect(variationClaimStatusLabel("draft")).toBe("Draft");
    expect(variationClaimStatusLabel("invoiced")).toBe("Invoiced");
  });

  it("formats integer cents as a dollar string", () => {
    expect(formatClaimValue(123450)).toBe("$1,234.50");
    expect(formatClaimValue(0)).toBe("$0.00");
    expect(formatClaimValue(5)).toBe("$0.05");
    expect(formatClaimValue(null)).toBe("—");
  });
});
