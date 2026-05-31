import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MaterialRequestsInbox } from "./MaterialRequestsInbox";
import type { MaterialRequestItem } from "@/domains/material-requests/types";

// RefreshButton (rendered in the error banner) calls useRouter; stub it so the
// SSR smoke doesn't need a mounted app router.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

/**
 * Server-render smoke for the BuhlOS Material Requests Inbox. Mirrors the
 * project's renderToString approach (ObservationsInbox.render.test.tsx) — node
 * env, no browser. Catches SSR crashes, broken composition and missing copy.
 * Mutation behaviour (the approve / mark ordered / mark delivered / cancel
 * buttons) is covered by the API test (material-requests-api.test.ts) since
 * renderToString can't drive interaction.
 */

function mr(
  over: Partial<MaterialRequestItem> & { id: string }
): MaterialRequestItem {
  return {
    jobId: "job-1",
    jobName: "Birdwood IV",
    item: "25mm conduit",
    quantity: 20,
    unit: "m",
    description: null,
    status: "requested",
    urgency: "high",
    source: "observation",
    auditLogIds: [],
    requestedById: "u_field",
    requestedByName: "Sparky",
    requestedAt: "2026-05-20T00:00:00.000Z",
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
    ...over,
  } as MaterialRequestItem;
}

describe("MaterialRequestsInbox", () => {
  it("renders the empty state when there are no requests", () => {
    const html = renderToString(
      createElement(MaterialRequestsInbox, {
        initialRequests: [],
        fetchError: null,
      })
    );
    expect(html).toContain("No material requests yet");
    // Summary cards + filter chrome still render even when empty.
    expect(html).toContain("To approve / order");
    expect(html).toContain("On order");
    expect(html).toContain("Delivered");
    expect(html).toContain("Status");
    expect(html).toContain("Urgency");
  });

  it("renders request rows with item, qty + unit, job and status", () => {
    const html = renderToString(
      createElement(MaterialRequestsInbox, {
        initialRequests: [
          mr({ id: "mr1" }),
          mr({
            id: "mr2",
            item: "Cable tray 100mm",
            quantity: 6,
            unit: "ea",
            status: "ordered",
            urgency: "normal",
            supplier: "CMI Cabling",
            orderRef: "PO-4521",
            jobName: "Marriott St",
          }),
        ],
        fetchError: null,
      })
    );
    expect(html).toContain("25mm conduit");
    expect(html).toContain("20 m");
    expect(html).toContain("Cable tray 100mm");
    expect(html).toContain("6 ea");
    expect(html).toContain("Birdwood IV");
    expect(html).toContain("Marriott St");
    expect(html).toContain("Requested");
    expect(html).toContain("Ordered");
    // Supplier + PO chips on the ordered row.
    expect(html).toContain("CMI Cabling");
    expect(html).toContain("PO-4521");
  });

  it("renders the fetch-error banner", () => {
    const html = renderToString(
      createElement(MaterialRequestsInbox, {
        initialRequests: [],
        fetchError: "API returned 503",
      })
    );
    expect(html).toContain("Couldn");
    expect(html).toContain("API returned 503");
  });

  it("hides the Job filter when showJobFilter=false (per-job scoped view)", () => {
    const html = renderToString(
      createElement(MaterialRequestsInbox, {
        initialRequests: [mr({ id: "mr1" })],
        fetchError: null,
        showJobFilter: false,
      })
    );
    // The "Status" + "Urgency" labels still appear (cross-job + scoped both
    // need those); the "Job" label only renders when showJobFilter is true.
    expect(html).toContain("Status");
    expect(html).toContain("Urgency");
    // The "Job" filter label is the only literal 'Job' in the filter strip;
    // checking by uppercase-tracking style would be brittle so we assert
    // structurally — the rendered HTML must not contain the "Job" select
    // label *as the .uppercase span*. Simpler: there should be exactly one
    // <select> per filter, so on the scoped view we expect 2 selects in
    // the filter strip; on the full view we expect 3.
    const selectCount = (html.match(/<select/g) || []).length;
    expect(selectCount).toBe(2);
  });
});
