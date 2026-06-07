import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilJobCommandPanel } from "./PhilJobCommandPanel";
import {
  buildPhilJobCommandModel,
  type PhilJobCommandModel,
} from "@/domains/phil/job-command-model";
import { philJobCommandInputFromJobData } from "@/domains/phil/job-command-input";
import type { Job } from "@/domains/jobs/types";
import type { SnagItem } from "@/domains/snags/types";
import type { Document } from "@/domains/documents/types";

/**
 * The panel renders ONLY from a PhilJobCommandModel. These tests build models
 * two ways: hand-built fixtures (to pin the panel's rendering of each state)
 * and the real bridge (to prove the page → model → panel contract end to end).
 * No JSX / Testing Library — renderToString + substring assertions, matching
 * the repo's other Phil render tests.
 */
function render(model: PhilJobCommandModel): string {
  return renderToString(createElement(PhilJobCommandPanel, { model })).replace(
    /<!-- -->/g,
    "",
  );
}

const BASE: PhilJobCommandModel = {
  jobId: "job-1",
  jobName: "Birdwood Rd",
  state: "ready",
  primaryAction: null,
  actions: [],
  attention: [],
  limitations: [],
};

describe("PhilJobCommandPanel — rendering each state", () => {
  it("renders the primary action prominently and maps in-page actions to anchors", () => {
    const html = render({
      ...BASE,
      primaryAction: {
        id: "capture",
        label: "Take a photo or add a note",
        status: "ready",
        reason: "Capture evidence against this job.",
      },
      actions: [
        {
          id: "log_hours",
          label: "Log hours",
          href: "/phil/my-day",
          status: "ready",
        },
        { id: "view_plans", label: "View plans & docs (2)", status: "ready" },
        { id: "report_issue", label: "Report an issue", status: "ready" },
      ],
    });
    expect(html).toContain("Next on this job");
    // primary
    expect(html).toContain("Take a photo or add a note");
    // in-page action → anchor on the job page itself (model leaves href unset)
    expect(html).toContain('href="#phil-job-capture"');
    expect(html).toContain('href="#phil-job-documents"');
    expect(html).toContain('href="#phil-job-snags"');
    // cross-surface action → its real route
    expect(html).toContain('href="/phil/my-day"');
    expect(html).toContain("View plans"); // label is "View plans & docs (2)" (& is entity-encoded)
    expect(html).toContain("(2)");
    expect(html).toContain("Report an issue");
  });

  it("renders limitations as honest notes", () => {
    const html = render({
      ...BASE,
      primaryAction: { id: "capture", label: "Take a photo or add a note", status: "ready" },
      limitations: [
        {
          id: "rejected-hours-unknown",
          label: "Rejected hours aren’t shown on the job screen",
          reason: "Check your Hours tab for anything sent back.",
        },
      ],
    });
    expect(html).toContain("Rejected hours aren’t shown on the job screen");
    expect(html).toContain("Check your Hours tab for anything sent back.");
  });

  it("surfaces a hard blocker and leads with no work action", () => {
    const html = render({
      ...BASE,
      state: "blocked",
      primaryAction: null,
      actions: [{ id: "report_issue", label: "Report an issue", status: "ready" }],
      attention: [
        {
          id: "on-hold",
          severity: "blocked",
          label: "This job is on hold",
          reason: "Check with your supervisor before doing any work here.",
        },
      ],
    });
    expect(html).toContain("This job is on hold");
    expect(html).toContain("Check with your supervisor");
    // the ambient action is still offered
    expect(html).toContain("Report an issue");
  });

  it("does NOT render info/warning attention (the attention strip owns that)", () => {
    const html = render({
      ...BASE,
      primaryAction: { id: "capture", label: "Take a photo or add a note", status: "ready" },
      attention: [
        { id: "open-snags", severity: "info", label: "2 open snags on this job", actionId: "report_issue" },
        { id: "induction-required", severity: "warning", label: "Site induction required" },
      ],
    });
    // these belong to PhilJobAttentionStrip, not the command panel
    expect(html).not.toContain("2 open snags on this job");
    expect(html).not.toContain("Site induction required");
  });

  it("renders an honest empty state when there's nothing flagged", () => {
    const html = render({
      ...BASE,
      state: "empty",
      actions: [{ id: "report_issue", label: "Report an issue", status: "ready" }],
    });
    expect(html).toContain("Nothing flagged to do on this job right now");
    expect(html).toContain("Report an issue");
  });

  it("renders nothing at all when the model carries no content", () => {
    const html = render({ ...BASE, state: "empty" });
    expect(html).toBe("");
  });

  it("never shows admin / payroll / Xero / dashboard language", () => {
    const html = render({
      ...BASE,
      primaryAction: {
        id: "fix_rejected_hours",
        label: "Fix 1 rejected hour entry",
        href: "/phil/hours",
        status: "attention",
        reason: "Your office sent these back — fix and resubmit.",
      },
      actions: [
        { id: "capture", label: "Take a photo or add a note", status: "ready" },
        { id: "log_hours", label: "Log hours", href: "/phil/my-day", status: "ready" },
      ],
      limitations: [{ id: "materials-off-app", label: "Material requests aren’t in the app yet" }],
    }).toLowerCase();
    for (const banned of ["payroll", "xero", "dashboard", "command centre", "workflow", "registry", "artifact"]) {
      expect(html).not.toContain(banned);
    }
  });

  it("invents no fake completion / upload / sign-off copy", () => {
    const html = render({
      ...BASE,
      primaryAction: { id: "continue_tasks", label: "View your tasks", status: "ready" },
      actions: [{ id: "complete_checks", label: "Complete 2 checks", status: "attention" }],
    }).toLowerCase();
    for (const fake of ["signed off", "uploaded", "completed", "all done", "synced"]) {
      expect(html).not.toContain(fake);
    }
  });
});

/* ---- bridge → model → panel (the real wiring contract) ---- */

function jobFixture(over: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    name: "Birdwood Rd",
    status: "active",
    modules: { photos: true, plans: true, snags: true, itps: true },
    roughInTasks: [{ id: "t1", name: "Rough in GPOs" }],
    areaGroups: [{ id: "g1", name: "Ground", areas: [{ id: "a1", name: "Kitchen" }] }],
    ...over,
  } as unknown as Job;
}

const openSnag = { id: "s1", status: "open" } as unknown as SnagItem;
const currentDoc = { id: "d1", status: "current" } as unknown as Document;

describe("PhilJobCommandPanel — from the real bridge", () => {
  it("renders the panel from a released job's real signals", () => {
    const model = buildPhilJobCommandModel(
      philJobCommandInputFromJobData({
        job: jobFixture(),
        snags: [openSnag],
        documents: [currentDoc, currentDoc],
        itps: [],
        // no taskState → tasks stay list_only ("View your tasks"), never a faked count
      }),
    );
    const html = render(model);
    expect(html).toContain("Next on this job");
    expect(html).toContain("View your tasks"); // list_only, honest
    expect(html).toContain("Report an issue");
    expect(html).toContain("View plans"); // "View plans & docs (N)" — & is entity-encoded
    // rejected hours isn't fetched on the job page → honest limitation, not a fake card
    expect(html).toContain("Rejected hours aren’t shown on the job screen");
  });

  it("renders tracked task progress only when real task state is supplied", () => {
    const model = buildPhilJobCommandModel(
      philJobCommandInputFromJobData({
        job: jobFixture(),
        taskState: {
          a1: { roughIn: { t1: "complete" }, fitOff: {} },
        },
      }),
    );
    const html = render(model);
    expect(html).not.toContain("View your tasks");
    expect(html).not.toContain("Task progress isn’t loaded in this section yet");
    // There is one visible area task and it is complete, so no invented
    // remaining-task action appears.
    expect(html).not.toContain("task left");
  });

  it("renders an honest office-only notice for a draft job", () => {
    const model = buildPhilJobCommandModel(
      philJobCommandInputFromJobData({ job: jobFixture({ status: "draft" }) }),
    );
    const html = render(model);
    expect(html).toContain("isn’t released to the field yet");
  });
});
