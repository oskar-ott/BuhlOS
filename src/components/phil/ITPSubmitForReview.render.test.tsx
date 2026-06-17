import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ITPSubmitForReview } from "./ITPSubmitForReview";
import type { ITPInstance } from "@/domains/itp/types";

/**
 * SSR render tests (vitest `environment: node`, no jsdom). They pin the
 * INITIAL markup per lifecycle state — button label, the aria-disabled
 * attribute, and the honest helper copy. The click → submit success /
 * error dynamics are thin glue over the unit-tested client
 * (submitItpForReview) and the real-handler route test
 * (job-itps-submit-api.test.ts); the enable/disable DECISION is the pure,
 * exhaustively-tested canSubmitForReview (itp.test.ts).
 */

const viewer = { id: "u_field", role: "tradie" };
const noop = () => {};

function instance(over: Partial<ITPInstance> = {}): ITPInstance {
  return {
    id: "itp_1",
    templateId: "tpl_1",
    templateSnapshot: {
      name: "Rough-in QA",
      points: [
        { id: "p1", label: "Cables supported", type: "signoff", required: true },
        { id: "p2", label: "Penetrations sealed", type: "signoff", required: true },
      ],
    },
    scope: "job",
    status: "in-progress",
    results: {},
    createdAt: "2026-06-17T08:00:00.000Z",
    createdBy: "boss",
    updatedAt: "2026-06-17T08:30:00.000Z",
    ...over,
  };
}

const RESULT = { value: true, note: "", byUserId: "u_field", byUsername: "sparky", at: "2026-06-17T09:00:00.000Z" };

function render(inst: ITPInstance): string {
  return renderToString(
    createElement(ITPSubmitForReview, {
      jobId: "j1",
      instance: inst,
      viewer,
      onSaved: noop,
      onError: noop,
    }),
  );
}

describe("ITPSubmitForReview", () => {
  it("renders an ENABLED button once every required point is recorded", () => {
    const html = render(instance({ results: { p1: RESULT, p2: RESULT } }));
    expect(html).toContain("Submit for review");
    expect(html).toContain('aria-disabled="false"');
    expect(html).toContain("All required points done");
  });

  it("renders a DISABLED button + honest copy while points are open", () => {
    const html = render(instance({ results: { p1: RESULT } })); // p2 open
    expect(html).toContain("Submit for review");
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("Complete all required points before submitting.");
  });

  it("is disabled on a pending instance (nothing recorded yet)", () => {
    const html = render(instance({ status: "pending", results: {} }));
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("Complete all required points before submitting.");
  });

  it("shows a calm 'submitted' notice once witnessed — no button", () => {
    const html = render(
      instance({ status: "witnessed", results: { p1: RESULT, p2: RESULT } }),
    );
    expect(html).toContain("waiting on the office to sign off");
    expect(html).not.toContain('data-testid="itp-submit-for-review"');
  });

  it("renders nothing on a signed-off instance (screen is locked above)", () => {
    const html = render(
      instance({
        status: "signed-off",
        signedOffBy: "anna",
        signedOffAt: "2026-06-17T10:00:00.000Z",
        results: { p1: RESULT, p2: RESULT },
      }),
    );
    expect(html).toBe("");
  });

  it("renders nothing on an archived instance", () => {
    const html = render(
      instance({ archived: true, results: { p1: RESULT, p2: RESULT } }),
    );
    expect(html).toBe("");
  });
});
