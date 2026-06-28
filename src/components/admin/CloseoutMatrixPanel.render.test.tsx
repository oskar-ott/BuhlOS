import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { CloseoutMatrixPanel } from "./CloseoutMatrixPanel";
import type {
  CloseoutMatrixView,
  CloseoutRequirementView,
} from "@/server/job-control/closeout-read";

// The panel uses useRouter().refresh after a successful op; stub it so the SSR
// smoke doesn't need a mounted app router (mirrors JobAssignmentPanel.render.test).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

/**
 * Server-render smoke for the closeout matrix authoring panel (#374 follow-up).
 * Node env, no browser: renderToString runs useState initialisers (so the add
 * form + link picker render) but not clicks. The ops the controls emit are
 * covered by closeout-ops.test.ts (validated against the route schema).
 */

function req(over: Partial<CloseoutRequirementView> = {}): CloseoutRequirementView {
  return {
    id: "cr_coes",
    title: "Certificate of electrical safety issued",
    kind: "certificate",
    source: "manual",
    areaScope: "job_wide",
    scopeClauseIds: [],
    status: "outstanding",
    confirmedAt: null,
    confirmedBy: null,
    links: [],
    hasDanglingLink: false,
    ...over,
  };
}

function readyView(over: Partial<Extract<CloseoutMatrixView, { status: "ready" }>> = {}): CloseoutMatrixView {
  return {
    ok: true,
    jobId: "job-1",
    status: "ready",
    revision: "rev-1",
    counts: {
      total: 1,
      outstanding: 1,
      inProgress: 0,
      satisfied: 0,
      waived: 0,
      discharged: 0,
      fractionDischarged: 0,
    },
    requirements: [req()],
    outstanding: [req()],
    linkOptions: [
      { type: "certificate", id: "cert_real", label: "CoES — main board" },
      { type: "document", id: "doc_1", label: "As-built drawing A1" },
      { type: "as-built", id: "doc_1", label: "As-built drawing A1" },
    ],
    ...over,
  };
}

function render(view: CloseoutMatrixView): string {
  return renderToString(createElement(CloseoutMatrixPanel, { jobId: "job-1", view }));
}

describe("CloseoutMatrixPanel — authoring controls", () => {
  it("renders the Add requirement form (title input + kind select + button)", () => {
    const html = render(readyView());
    expect(html).toContain("Add a requirement");
    expect(html).toContain("Requirement title");
    expect(html).toContain("Requirement kind");
    expect(html).toContain("Add requirement");
    // The kind options come from the author kinds (a few representative labels).
    expect(html).toContain("Certificate");
    expect(html).toContain("Document");
  });

  it("renders the per-row link picker sourced from the job's records", () => {
    const html = render(readyView());
    // The picker default option + at least one real record label.
    expect(html).toContain("Link a record");
    expect(html).toContain("CoES — main board");
    expect(html).toContain("As-built drawing A1");
  });

  it("lists an attached link and offers an Unlink control", () => {
    const view = readyView({
      requirements: [
        req({ links: [{ type: "certificate", id: "cert_real", resolved: true }] }),
      ],
    });
    const html = render(view);
    expect(html).toContain("Unlink");
    // The attached link's label is surfaced (resolved from linkOptions).
    expect(html).toContain("CoES — main board");
  });

  it("keeps the Add form on a genuinely-empty matrix (authoring is reachable)", () => {
    const empty = readyView({
      counts: {
        total: 0,
        outstanding: 0,
        inProgress: 0,
        satisfied: 0,
        waived: 0,
        discharged: 0,
        fractionDischarged: null,
      },
      requirements: [],
      outstanding: [],
    });
    const html = render(empty);
    expect(html).toContain("Nothing to close out yet");
    // Honest-empty AND still authorable.
    expect(html).toContain("Add a requirement");
  });

  it("does not render a fake readiness pill when the matrix is empty (no 0 of 0 green)", () => {
    const empty = readyView({
      counts: {
        total: 0,
        outstanding: 0,
        inProgress: 0,
        satisfied: 0,
        waived: 0,
        discharged: 0,
        fractionDischarged: null,
      },
      requirements: [],
      outstanding: [],
    });
    const html = render(empty);
    expect(html).not.toContain("0 of 0 closed out");
  });
});
