import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ITPDrawer } from "./ITPDrawer";
import type { ITPInstance } from "@/domains/itp/types";
import type { Job } from "@/domains/jobs/types";

/**
 * SSR render tests for the admin ITP drawer footer (vitest node env).
 * Pins WHEN the "Submit for review" office action surfaces: only on an
 * in-progress instance with every required point recorded, and admin-tier
 * only. The click → POST is wired through ITPsQueue.runSubmit
 * (submitItpForReview), unit-tested in itp.test.ts + the route test.
 */

const job = { id: "j1", name: "Riverside", status: "active" } as unknown as Job;
const viewer = { id: "u_admin", role: "office" };
const noop = () => {};

const RESULT = { value: true, note: "", byUserId: "u_field", byUsername: "sparky", at: "2026-06-17T09:00:00.000Z" };

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

function render(inst: ITPInstance, isAdmin = true): string {
  return renderToString(
    createElement(ITPDrawer, {
      job,
      instance: inst,
      open: true,
      isAdmin,
      viewer,
      busy: false,
      onClose: noop,
      onSubmit: noop,
      onSignOff: noop,
      onReopen: noop,
      onArchive: noop,
    }),
  );
}

describe("ITPDrawer — Submit for review action", () => {
  it("offers Submit for review on a complete in-progress instance (admin)", () => {
    const html = render(instance({ results: { p1: RESULT, p2: RESULT } }));
    expect(html).toContain("Submit for review");
  });

  it("does NOT offer submit while required points are still open", () => {
    const html = render(instance({ results: { p1: RESULT } })); // p2 open
    expect(html).not.toContain("Submit for review");
  });

  it("does NOT offer submit once witnessed — Sign off takes over", () => {
    const html = render(
      instance({ status: "witnessed", results: { p1: RESULT, p2: RESULT } }),
    );
    expect(html).not.toContain("Submit for review");
    expect(html).toContain("Sign off");
  });

  it("hides submit from a leading hand (read-only footer)", () => {
    const html = render(instance({ results: { p1: RESULT, p2: RESULT } }), false);
    expect(html).not.toContain("Submit for review");
    expect(html).toContain("Read-only");
  });
});
