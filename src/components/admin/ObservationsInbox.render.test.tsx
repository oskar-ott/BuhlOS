import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ObservationsInbox } from "./ObservationsInbox";
import type { ObservationItem } from "@/domains/observations/types";

// RefreshButton (rendered in the error banner) calls useRouter; stub it so the
// SSR smoke doesn't need a mounted app router.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

/**
 * Server-render smoke for the BuhlOS Observations Inbox. Mirrors the project's
 * renderToString approach (employee-onboarding.render.test.tsx) — node env, no
 * browser. Catches SSR crashes, broken composition and missing copy. Mutation
 * behaviour (the triage/resolve/convert buttons) is covered by the API test
 * (observations-api.test.ts) since renderToString can't drive interaction.
 */

const VIEWER = { id: "u_boss", name: "Boss", role: "boss" };

function obs(over: Partial<ObservationItem> & { id: string }): ObservationItem {
  return {
    jobId: "job-1",
    jobName: "Birdwood IV",
    type: "blocker",
    title: "Cable path blocked at riser",
    description: null,
    status: "new",
    priority: "high",
    source: "phil",
    requiresAction: true,
    photoUrls: [],
    createdById: "u_field",
    createdByName: "Sparky",
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
    ...over,
  } as ObservationItem;
}

describe("ObservationsInbox", () => {
  it("renders the empty state when there are no observations", () => {
    const html = renderToString(
      createElement(ObservationsInbox, {
        initialObservations: [],
        fetchError: null,
        viewer: VIEWER,
      })
    );
    expect(html).toContain("No observations yet");
    // Summary cards + filter chrome still render.
    expect(html).toContain("New / needs action");
    expect(html).toContain("Blockers");
    expect(html).toContain("Status");
    expect(html).toContain("Source");
  });

  it("renders observation rows with title, job, type and status", () => {
    const html = renderToString(
      createElement(ObservationsInbox, {
        initialObservations: [
          obs({ id: "o1" }),
          obs({
            id: "o2",
            type: "material_request",
            title: "Need 20m more tray",
            status: "needs_action",
            priority: "normal",
            jobName: "Marriott St",
          }),
        ],
        fetchError: null,
        viewer: VIEWER,
      })
    );
    expect(html).toContain("Cable path blocked at riser");
    expect(html).toContain("Need 20m more tray");
    expect(html).toContain("Birdwood IV");
    expect(html).toContain("Marriott St");
    expect(html).toContain("Blocker");
    expect(html).toContain("Material request");
    expect(html).toContain("Needs action");
  });

  it("renders the fetch-error banner", () => {
    const html = renderToString(
      createElement(ObservationsInbox, {
        initialObservations: [],
        fetchError: "API returned 503",
        viewer: VIEWER,
      })
    );
    expect(html).toContain("Couldn");
    expect(html).toContain("API returned 503");
  });
});
