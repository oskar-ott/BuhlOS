import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

/**
 * SSR render assertions for the #235 admin surface:
 *   - the 'Post-handover' chip on a snag raised in the defect period
 *     (SnagsQueue row + SnagDrawer header), driven by snag.origin
 *   - the closed-snag "Re-open" admin action is offered (the locked
 *     reopen-via closed→verified decision — no new transition)
 *   - the JobDlpCard status line ('In defect period — N days left' /
 *     'Defect period ended <date>'), driven by dlpStatus(job, today)
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/v2/jobs/job-1",
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
}));

// The drawer fetches audit history in a client effect — never fires in SSR,
// but stub the module so importing the drawer doesn't pull a real network dep.
vi.mock("@/domains/audit-log/client", () => ({
  listAuditForTarget: async () => ({ ok: true, data: { entries: [] } }),
}));

import { SnagsQueue } from "./SnagsQueue";
import { SnagDrawer } from "./SnagDrawer";
import { JobDlpCard } from "./JobDlpCard";
import type { SnagItem } from "@/domains/snags/types";
import type { Job } from "@/domains/jobs/types";

function snag(over: Partial<SnagItem> = {}): SnagItem {
  return {
    id: "sn_1",
    jobId: "job-1",
    title: "Cracked GPO faceplate",
    description: null,
    summary: null,
    stage: null,
    areaId: null,
    areaName: null,
    taskId: null,
    taskName: null,
    evidenceIds: [],
    status: "open",
    priority: "normal",
    source: "admin",
    origin: null,
    createdById: "u_admin",
    createdByName: "Boss",
    createdByRole: "admin",
    assignedToId: null,
    assignedToName: null,
    auditLogIds: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  } as SnagItem;
}

const VIEWER = { id: "u_admin", role: "admin" };

function job(over: Partial<Job> = {}): Job {
  return { id: "job-1", name: "Riley House", ...over } as unknown as Job;
}

describe("#235 Post-handover chip", () => {
  it("SnagsQueue renders the chip on a post_handover snag and not otherwise", () => {
    const withChip = renderToString(
      createElement(SnagsQueue, {
        job: job(),
        initialSnags: [snag({ origin: "post_handover" })],
        fetchError: null,
        isAdmin: true,
        viewer: VIEWER,
      }),
    );
    expect(withChip).toContain("Post-handover");

    const without = renderToString(
      createElement(SnagsQueue, {
        job: job(),
        initialSnags: [snag({ origin: null })],
        fetchError: null,
        isAdmin: true,
        viewer: VIEWER,
      }),
    );
    expect(without).not.toContain("Post-handover");
  });

  it("SnagDrawer header shows the chip for a post_handover snag", () => {
    const html = renderToString(
      createElement(SnagDrawer, {
        snag: snag({ origin: "post_handover" }),
        open: true,
        isAdmin: true,
        viewer: VIEWER,
        busy: false,
        onClose: () => {},
        onTransition: () => {},
        onOpenReject: () => {},
      }),
    );
    expect(html).toContain("Post-handover");
  });
});

describe("#235 closed snag is re-openable (closed→verified)", () => {
  it("SnagDrawer offers the Re-open action for a closed snag to an admin", () => {
    const html = renderToString(
      createElement(SnagDrawer, {
        snag: snag({ status: "closed" }),
        open: true,
        isAdmin: true,
        viewer: VIEWER,
        busy: false,
        onClose: () => {},
        onTransition: () => {},
        onOpenReject: () => {},
      }),
    );
    expect(html).toContain("Re-open");
  });
});

describe("#235 JobDlpCard status line", () => {
  it("shows in-DLP days remaining when today is inside the window", () => {
    const html = renderToString(
      createElement(JobDlpCard, {
        job: job({ handoverDate: "2026-06-01", defectPeriodEndsAt: "2026-08-30" }),
        today: "2026-08-29",
      }),
    );
    // React SSR inserts <!-- --> text-boundary markers between the literal
    // copy and the interpolated day count; strip them before asserting.
    const text = html.replace(/<!--.*?-->/g, "");
    expect(text).toContain("In defect period");
    expect(text).toContain("2 days left");
  });

  it("shows the ended date when the period has expired", () => {
    const html = renderToString(
      createElement(JobDlpCard, {
        job: job({ handoverDate: "2026-06-01", defectPeriodEndsAt: "2026-08-30" }),
        today: "2026-09-15",
      }),
    );
    expect(html).toContain("Defect period ended");
  });

  it("renders no status line when the job has no DLP set", () => {
    const html = renderToString(
      createElement(JobDlpCard, { job: job(), today: "2026-08-29" }),
    );
    expect(html).not.toContain("In defect period");
    expect(html).not.toContain("Defect period ended");
    // ...but the admin edit affordance is still present so it can be set.
    expect(html).toContain("Save defect period");
  });
});
