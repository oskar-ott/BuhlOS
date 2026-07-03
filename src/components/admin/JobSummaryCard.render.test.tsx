import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobSummaryCard } from "./JobSummaryCard";
import { factNumbers, citations } from "@/domains/jobs/summary-client";
import { formatHoursLabel } from "@/domains/timesheets/format";
import type { JobSummaryResponse } from "@/domains/jobs/summary-client";

/**
 * #173 — the AI job-summary card. The vitest env is `node`, so renderToString
 * gives us the card's initial (idle) render — which is exactly the "flag-on"
 * affordance: the Summarise button before any fetch. The interactive states
 * (success prose + verbatim numbers, the honest error strings) are driven by
 * the pure helpers pinned in summary-client.test.ts and re-asserted here as the
 * data this card renders.
 *
 * Flag gating: the CARD assumes the flag is on. "Flag off ⇒ nothing renders" is
 * the page's conditional (`{aiAssistantEnabled ? <JobSummaryCard/> : null}`) —
 * when off, the component is never mounted, so there is no button. This test
 * proves the mounted card ALWAYS offers the button (the on-branch), which is the
 * behaviour the page gates.
 */

function ready(): JobSummaryResponse {
  return {
    summary: "Riverside Units is active with one open snag.",
    generatedAt: "2026-07-04T02:00:00.000Z",
    model: "claude-sonnet-4-6",
    toolData: {
      overview: {
        job: { id: "job-1", name: "Riverside Units", type: null, status: "active", address: null, createdAt: null },
        areas: { count: 3 },
        tasks: { roughIn: { total: 8, complete: 3 }, fitOff: { total: 8, complete: 0 } },
        openSnagCount: 1,
        evidenceCount: 12,
        sources: [{ store: "jobs.json", id: "job-1" }, { store: "jobs/job-1/data.json", id: null }],
      },
      hours: {
        jobId: "job-1",
        approved: { entryCount: 1, hours: 6 },
        submitted: { entryCount: 2, hours: 14.5 },
        sources: [{ store: "users/u_field/time-entries/2026-06-30.json", id: "te1" }],
      },
      openItems: {
        jobId: "job-1",
        openSnags: [{ id: "s1", description: "Missing GPO", priority: "High", area: null, raisedBy: null, createdAt: null }],
        openObservations: [],
        sources: [{ store: "jobs/job-1/data.json", id: null }, { store: "observations.json", id: null }],
      },
    },
  };
}

describe("JobSummaryCard — flag-on affordance (idle render)", () => {
  it("renders the Summarise button and the P7 honesty copy", () => {
    const html = renderToString(createElement(JobSummaryCard, { jobId: "job-1" }));
    expect(html).toContain("Where is this job at?");
    expect(html).toContain("Summarise");
    // The card promises real numbers, not the model's wording.
    expect(html).toContain("actual counts");
    // Idle: no summary body, no error, no "Regenerate" yet.
    expect(html).not.toContain("From the records");
    expect(html).not.toContain("Regenerate");
    expect(html).not.toContain("role=\"alert\"");
  });

  it("wires a real button (not a link) — the generate action, not navigation", () => {
    const html = renderToString(createElement(JobSummaryCard, { jobId: "job-1" }));
    expect(html).toContain("<button");
  });
});

/**
 * The success/error render content is a projection of the pure helpers. We
 * assert here that the numbers the card will paint are the VERBATIM toolData
 * figures (P7) and that citations resolve to live hub routes — the exact strings
 * SummaryBody renders.
 */
describe("JobSummaryCard — the data it renders on success", () => {
  it("paints verbatim numbers from toolData, labour scoped by approval state", () => {
    const facts = factNumbers(ready().toolData, formatHoursLabel);
    const map = Object.fromEntries(facts.map((f) => [f.label, f.value]));
    expect(map["Rough-in"]).toBe("3 of 8 tasks complete");
    expect(map["Hours approved"]).toBe("6h · 1 entry");
    expect(map["Hours awaiting approval"]).toBe("14h 30m · 2 entries");
    expect(map["Open snags"]).toBe("1");
    // No bare total-hours figure anywhere.
    expect(map["Total hours"]).toBeUndefined();
  });

  it("renders citation chips to live hub anchors", () => {
    const cites = citations(ready().toolData, "job-1");
    const hrefs = cites.map((c) => c.href);
    expect(hrefs).toContain("/v2/jobs/job-1");
    expect(hrefs).toContain("/v2/jobs/job-1/observations");
    expect(hrefs).toContain("/hours/approvals");
  });
});
