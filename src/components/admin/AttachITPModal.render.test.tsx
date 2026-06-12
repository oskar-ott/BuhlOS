import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AttachITPModal } from "./AttachITPModal";
import { ITPsQueue } from "./ITPsQueue";
import type { Job } from "@/domains/jobs/types";

/**
 * Static-render guards for the attach flow (#387). Interaction (template
 * fetch, scope switching, the POST) is covered by the attach API harness +
 * PR-preview verification; these pin the honest initial states and the
 * entry-point visibility rules the queue applies.
 */

const job = {
  id: "j1",
  name: "Riverside",
  areaGroups: [{ id: "g1", name: "Ground", areas: [{ id: "a1", name: "Unit 1" }] }],
} as unknown as Job;

const noop = () => undefined;

describe("AttachITPModal", () => {
  it("renders the picker shell with a loading state and all four scopes", () => {
    const html = renderToString(
      createElement(AttachITPModal, {
        open: true,
        job,
        busy: false,
        onClose: noop,
        onSubmit: noop,
      }),
    );
    expect(html).toContain("Attach a check");
    expect(html).toContain("Loading templates…");
    for (const label of ["Whole job", "A level / group", "One area", "A switchboard"]) {
      expect(html).toContain(label);
    }
    // submit disabled until a template is picked
    expect(html).toMatch(/disabled=""[^>]*data-testid="attach-itp-submit"/);
  });

  it("renders nothing when closed", () => {
    const html = renderToString(
      createElement(AttachITPModal, {
        open: false,
        job,
        busy: false,
        onClose: noop,
        onSubmit: noop,
      }),
    );
    expect(html).toBe("");
  });
});

describe("ITPsQueue attach entry point", () => {
  const base = {
    job,
    initialItps: [],
    fetchError: null,
  };

  it("admins see the Attach button", () => {
    const html = renderToString(
      createElement(ITPsQueue, {
        ...base,
        isAdmin: true,
        viewer: { id: "u1", role: "office" },
      }),
    );
    expect(html).toContain("attach-itp-open");
    expect(html).toContain("Attach a check");
  });

  it("leading hands see it too (canManageJob parity) with honest scope copy", () => {
    const html = renderToString(
      createElement(ITPsQueue, {
        ...base,
        isAdmin: false,
        viewer: { id: "u2", role: "lh" },
      }),
    );
    expect(html).toContain("attach-itp-open");
    expect(html).toContain("Sign-off &amp; archive are office-only");
    expect(html).not.toContain("Read-only — leading hand");
  });
});
