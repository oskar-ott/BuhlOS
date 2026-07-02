import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { ApprovalModal, VariationsRegister } from "./VariationsRegister";
import type { VariationClaimRecord } from "@/domains/variations/claim-types";

/**
 * SSR render tests for the variation-claims register (#280): the raise form,
 * money formatted FROM integer cents (never floats in state), the rollup
 * tiles, the transition-driven action set, the recorded approval evidence,
 * and the approval modal's required-evidence gate.
 */

function claim(
  over: Partial<VariationClaimRecord> & Pick<VariationClaimRecord, "id" | "ref" | "scope">
): VariationClaimRecord {
  return {
    jobId: "job-1",
    description: null,
    status: "draft",
    valueCents: null,
    links: { observationId: null, evidenceIds: [], documentIds: [] },
    approval: null,
    decisionNote: null,
    invoiceRef: null,
    invoicedAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    createdById: "u",
    createdByName: "Karen",
    updatedAt: "2026-06-01T00:00:00.000Z",
    auditLogIds: [],
    ...over,
  };
}

const strip = (h: string) => h.replace(/<!-- -->/g, "");

describe("VariationsRegister — render", () => {
  const html = strip(
    renderToString(
      createElement(VariationsRegister, {
        jobId: "job-1",
        initialClaims: [
          claim({
            id: "vc1",
            ref: "VO-001",
            scope: "Extra downlights in lounge",
            status: "submitted",
            valueCents: 123450, // $1,234.50 — display only, state stays cents
          }),
          claim({
            id: "vc2",
            ref: "VO-002",
            scope: "Switchboard relocation",
            status: "approved",
            valueCents: 800000,
            approval: {
              approvedBy: "Steve M",
              approvedAt: "2026-06-10T00:00:00.000Z",
              method: "email",
              reference: "RE: VO-002 approved",
            },
          }),
          claim({
            id: "vc3",
            ref: "VO-003",
            scope: "Data points to office",
            status: "rejected",
            valueCents: 50000,
            decisionNote: "Builder says it's in the contract.",
          }),
          claim({
            id: "vc4",
            ref: "VO-004",
            scope: "Unpriced extra",
            status: "draft",
            valueCents: null,
            links: { observationId: "obs_9", evidenceIds: [], documentIds: [] },
          }),
        ],
        fetchError: null,
      })
    )
  );

  it("shows the raise form with scope + dollars value + description", () => {
    expect(html).toContain("Raise claim");
    expect(html).toContain("Scope");
    expect(html).toContain("Value ($, optional)");
  });

  it("lists claims with ref + scope and money formatted from integer cents", () => {
    expect(html).toContain("VO-001");
    expect(html).toContain("Extra downlights in lounge");
    expect(html).toContain("$1,234.50");
    expect(html).toContain("$8,000.00");
  });

  it("renders an honest dash (not $0.00) for an unpriced claim", () => {
    expect(html).toContain("VO-004");
    expect(html).toContain("—");
  });

  it("shows the rollup tiles with integer-cents sums", () => {
    expect(html).toContain("In flight (2)"); // submitted + draft
    expect(html).toContain("Approved (1)");
    expect(html).toContain("Lost (1)");
    expect(html).toContain("$500.00"); // lost = rejected VO-003
  });

  it("offers the status filters with counts", () => {
    expect(html).toContain("All (4)");
    expect(html).toContain("Submitted (1)");
    expect(html).toContain("Rejected (1)");
  });

  it("shows recorded approval evidence on an approved claim", () => {
    expect(html).toContain("Steve M");
    expect(html).toContain("RE: VO-002 approved");
    expect(html).toContain("Email");
  });

  it("shows the rejection note", () => {
    expect(html).toContain("Builder says it&#x27;s in the contract.");
  });

  it("drives actions from the transition table (approve only from submitted)", () => {
    // Submitted claim → approval entry point exists; a draft can't be approved
    // (exactly one submitted claim in the fixture → exactly one approve button).
    expect(html.match(/Record approval…/g)?.length).toBe(1);
    expect(html).toContain("Submit to builder"); // draft/quoted path
    expect(html).toContain("Back to draft"); // re-work path
  });

  it("links back to the source observation", () => {
    expect(html).toContain("observation obs_9");
    expect(html).toContain("/v2/jobs/job-1/observations");
  });
});

describe("VariationsRegister — empty + error states", () => {
  it("says so honestly when there are no claims", () => {
    const html = strip(
      renderToString(
        createElement(VariationsRegister, { jobId: "job-1", initialClaims: [], fetchError: null })
      )
    );
    expect(html).toContain("No variation claims yet.");
  });

  it("surfaces the server fetch error", () => {
    const html = strip(
      renderToString(
        createElement(VariationsRegister, {
          jobId: "job-1",
          initialClaims: [],
          fetchError: "Variations API 500",
        })
      )
    );
    expect(html).toContain("Variations API 500");
  });
});

describe("ApprovalModal — the evidence gate", () => {
  const html = strip(
    renderToString(
      createElement(ApprovalModal, {
        claim: claim({ id: "vc1", ref: "VO-001", scope: "Extra work", status: "submitted" }),
        busy: false,
        onCancel: () => {},
        onSave: () => {},
      })
    )
  );

  it("collects all four evidence fields", () => {
    expect(html).toContain("Approved by");
    expect(html).toContain("Approved on");
    expect(html).toContain("How");
    expect(html).toContain("Reference");
    // All four methods offered.
    for (const label of ["Email", "Verbal", "Signed", "Portal"]) {
      expect(html).toContain(label);
    }
  });

  it("disables Approve until the evidence is complete", () => {
    // Fresh modal has empty approvedBy/method/reference → the save button
    // renders disabled (mirror of isApprovalEvidenceComplete; the server's
    // 400 remains the authority).
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[^<]*Approve claim/);
  });
});
