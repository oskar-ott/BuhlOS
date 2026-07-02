import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ClaimsRegister } from "./ClaimsRegister";
import { JobClaimsCard } from "./JobClaimsCard";
import { computeClaimTotals, withComputedValues } from "@/domains/progress-claims/math";
import type { ClaimsViewWire } from "@/domains/progress-claims/client";
import type { ProgressClaim, ProgressClaimLine } from "@/domains/progress-claims/types";

/**
 * #372 — server-render pass over the claims register (renderToString skips
 * mount fetches). The money math is pinned by the domain/store tests; this
 * guards the register's honesty markers: unsupported-line badge, unpriced
 * flag, over-claim badge, seed copy and the empty/error states.
 */

function line(overrides: Partial<ProgressClaimLine> = {}): ProgressClaimLine {
  return withComputedValues({
    id: "cl_zip",
    sourceKey: "boq:q1/s1/l1",
    lineRef: "1.1",
    sectionLabel: "East Gym",
    description: "ZIP tap & dedicated 20A circuit",
    boqLineRef: { quoteId: "q1", sectionId: "s1", lineId: "l1" },
    workPackageId: "wp_zip",
    contractValueCents: 185_000,
    contractValueSource: "quote_line",
    previousPctBp: 0,
    previousValueCents: 0,
    thisPctBp: 2500,
    overClaimOverride: false,
    evidenceRefs: [],
    toDatePctBp: 0,
    toDateValueCents: null,
    thisValueCents: null,
    order: 0,
    ...overrides,
  });
}

function makeClaim(overrides: Partial<ProgressClaim> = {}): ProgressClaim {
  const lines = overrides.lines ?? [line()];
  const attachments = overrides.attachments ?? [];
  return {
    id: "pc_1",
    jobId: "job-1",
    number: 1,
    periodLabel: "July 2026",
    status: "draft",
    seedSource: "quote",
    quoteId: "q1",
    previousClaimId: null,
    lines,
    attachments,
    totals: computeClaimTotals(lines, attachments),
    evidenceManifest: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    createdBy: "karen",
    ...overrides,
  };
}

function makeView(overrides: Partial<ClaimsViewWire> = {}): ClaimsViewWire {
  return {
    ok: true,
    jobId: "job-1",
    jobName: "100 Arthur St",
    revision: "rev-1",
    claims: [makeClaim()],
    derived: {
      claimedToDateCents: 0,
      oldestUnpaidDays: null,
      scalarClaimedToDateCents: null,
      contractValueCents: 280_900,
      certifiedVarianceByClaimId: { pc_1: null },
    },
    seed: { source: "quote", quoteId: "q1" },
    references: [{ workPackageId: "wp_zip", tasksComplete: 1, tasksTotal: 2 }],
    linkable: [{ kind: "evidence", id: "ev1", label: "ZIP circuit at board" }],
    attachable: [
      {
        kind: "variation",
        id: "vc_1",
        ref: "VO-001",
        label: "Extra GPO run",
        valueCents: 25_000,
        attachedToClaimNumber: null,
      },
    ],
    ...overrides,
  };
}

describe("ClaimsRegister", () => {
  it("renders the position summary, the claim row and honest flags", () => {
    const html = renderToString(
      createElement(ClaimsRegister, { jobId: "job-1", initialView: makeView(), fetchError: null }),
    );
    expect(html).toContain("Position");
    expect(html).toContain(String.raw`data-testid="claim-1"`);
    expect(html).toContain("July 2026");
    expect(html).toContain("$2,809.00"); // contract value from cents
    // Open draft is expanded by default → lines + flags visible.
    expect(html).toContain("ZIP tap &amp; dedicated 20A circuit");
    expect(html).toContain("No evidence linked"); // unsupported, visible, not hidden
    expect(html).toContain("complete (reference)"); // reference alongside, not an auto-%
    expect(html).toContain("CSV for Payapps keying");
  });

  it("marks unpriced lines and excludes them from totals copy", () => {
    const view = makeView({
      claims: [
        makeClaim({
          lines: [line(), line({ id: "cl_m", sourceKey: "manual:cl_m", lineRef: "M1", contractValueCents: null, contractValueSource: "manual" })],
        }),
      ],
    });
    const html = renderToString(
      createElement(ClaimsRegister, { jobId: "job-1", initialView: view, fetchError: null }),
    );
    expect(html).toContain("Unpriced");
    expect(html).toContain("1 unpriced line excluded");
  });

  it("flags an over-claim in danger tone until overridden", () => {
    const view = makeView({
      claims: [makeClaim({ lines: [line({ previousPctBp: 9000, previousValueCents: 166_500, thisPctBp: 1500 })] })],
    });
    const html = renderToString(
      createElement(ClaimsRegister, { jobId: "job-1", initialView: view, fetchError: null }),
    );
    expect(html).toContain("Over 100%");
    expect(html).toContain("Allow over-claim");
  });

  it("a submitted claim renders read-only with status actions instead of Submit", () => {
    const view = makeView({
      claims: [
        makeClaim({
          status: "submitted",
          submittedAt: "2026-07-02T00:00:00.000Z",
          submittedBy: "karen",
        }),
      ],
    });
    const html = renderToString(
      createElement(ClaimsRegister, { jobId: "job-1", initialView: view, fetchError: null }),
    );
    expect(html).toContain("Submitted");
    expect(html).toContain("Mark certified");
    expect(html).toContain("Mark paid");
    expect(html).not.toContain("Submit claim");
    expect(html).not.toContain("Delete draft");
  });

  it("empty register explains the seed source honestly", () => {
    const html = renderToString(
      createElement(ClaimsRegister, {
        jobId: "job-1",
        initialView: makeView({ claims: [], seed: { source: "blank", quoteId: null } }),
        fetchError: null,
      }),
    );
    expect(html).toContain("no linked quote or work packages exist");
  });

  it("surfaces drift between the hand-set scalar and the derived figure", () => {
    const html = renderToString(
      createElement(ClaimsRegister, {
        jobId: "job-1",
        initialView: makeView({
          derived: {
            claimedToDateCents: 46_250,
            oldestUnpaidDays: 12,
            scalarClaimedToDateCents: 99_900,
            contractValueCents: 280_900,
            certifiedVarianceByClaimId: {},
          },
        }),
        fetchError: null,
      }),
    );
    expect(html).toContain("hand-set claimed-to-date differs from the claim records");
  });

  it("renders the error card when the view failed to load", () => {
    const html = renderToString(
      createElement(ClaimsRegister, { jobId: "job-1", initialView: null, fetchError: "Claims API 500" }),
    );
    expect(html).toContain("load the claims register");
    expect(html).toContain("Claims API 500");
  });
});

describe("JobClaimsCard", () => {
  it("renders a loading state before the mount fetch", () => {
    const html = renderToString(createElement(JobClaimsCard, { jobId: "job-1" }));
    expect(html).toContain("Progress claims");
    expect(html).toContain("Open register");
    expect(html).toContain("Loading");
  });
});
