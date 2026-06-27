import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobFieldView } from "./JobFieldView";
import type { PhilJobDataForCommand } from "@/domains/phil/job-command-input";
import type { Job } from "@/domains/jobs/types";

/**
 * Admin Field view — a read-only render of the Phil job command model. Pure
 * server component (no mocks). Pins: the read-only banner + capture, the
 * tri-color "what now" mapping (on_hold→danger, published→navy), the structural
 * stages, and the honest no-structure state — and that no PhilShell is imported.
 */

function job(over: Partial<Job> = {}): Job {
  return { id: "job-1", name: "Glebe Town Hall", status: "active", ...over } as unknown as Job;
}

const STRUCTURED: Partial<Job> = {
  roughInTasks: [{ id: "t1", name: "Rough in GPOs" }],
  areaGroups: [{ id: "g1", name: "Ground", areas: [{ id: "a1", name: "Switchroom" }] }],
  modules: { photos: true, snags: true, itps: true, plans: true },
} as Partial<Job>;

function render(data: PhilJobDataForCommand): string {
  return renderToString(createElement(JobFieldView, { data })).replace(/<!-- -->/g, "");
}

describe("JobFieldView (admin read-only Phil render)", () => {
  it("leads with the read-only crew banner and a read-only capture shutter", () => {
    const html = render({ job: job(STRUCTURED) });
    expect(html).toContain("Field view — what the crew sees");
    expect(html).toContain("read-only");
    // The capture affordance is present but disabled (not a working button).
    expect(html).toContain("Capture");
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("completing the ITP is the sign-off");
  });

  it("renders the real stages + areas from the saved structure (no fake state)", () => {
    const html = render({ job: job(STRUCTURED) });
    expect(html).toContain("Work · stages");
    expect(html).toContain("Switchroom");
    expect(html).toContain("Ground");
  });

  it("shows a danger 'on hold / safety hold' what-now when the job is on hold", () => {
    const html = render({ job: job({ ...STRUCTURED, status: "on_hold" }) });
    expect(html).toContain("bg-state-danger");
    expect(html.toLowerCase()).toContain("hold");
  });

  it("shows the navy next-on-this-job card for a published, ready job", () => {
    const html = render({ job: job({ ...STRUCTURED, status: "active" }) });
    expect(html).toContain("Next on this job");
    expect(html).toContain("bg-brand-navy");
  });

  it("honest minimal state when the job has no structure", () => {
    const html = render({ job: job() });
    // buildPhilPreview supplies the emptyReason; we surface it + the fallback.
    expect(html).toContain("capture photos, log hours and raise issues");
  });

  it("does not import the Phil shell (cross-shell ban)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "JobFieldView.tsx"),
      "utf8",
    );
    expect(src).not.toContain("@/components/phil/PhilShell");
    // Must not IMPORT or RENDER PhilJobDetail (useCaptureLauncher throws here).
    // The doc comment may name it; an actual import/JSX must not appear.
    expect(src).not.toMatch(/from\s+["'][^"']*PhilJobDetail/);
    expect(src).not.toContain("<PhilJobDetail");
  });
});
