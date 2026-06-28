import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ArchivedStructureSection, JobBuilderClient, tabFromHash } from "./JobBuilderClient";
import { projectArchivedStructure } from "@/domains/jobs/builder";
import type { Job } from "@/domains/jobs/types";

describe("tabFromHash (deep-link hash → builder tab)", () => {
  it("resolves a known tab hash, ignores unknown/empty hashes", () => {
    expect(tabFromHash("#publish")).toBe("publish");
    expect(tabFromHash("#basics")).toBe("basics");
    // the no-crew anchor targets the sibling panel, not a tab → no tab change
    expect(tabFromHash("#assigned-field-workers")).toBeNull();
    expect(tabFromHash("#nonsense")).toBeNull();
    expect(tabFromHash("")).toBeNull();
    expect(tabFromHash(null)).toBeNull();
    expect(tabFromHash(undefined)).toBeNull();
  });
});

// JobBuilderClient calls useRouter (refresh after save/publish). Stub it so the
// SSR smoke doesn't need a mounted app router.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

/**
 * Server-render smoke for the Job Builder / Editor workspace. Mirrors the
 * project's renderToString approach (ObservationsInbox.render.test.tsx) — node
 * env, no browser. Catches SSR crashes, broken composition and missing copy.
 *
 * Only the default (Basics) tab renders here — renderToString can't click a
 * tab — so the per-tab content (structure / preview / publish) is exercised by
 * the pure-logic tests in src/domains/jobs/builder.test.ts, which is where the
 * real risk (payload shaping + publish rules + preview derivation) lives.
 */

function makeJob(over: Partial<Job> & { id: string; name: string }): Job {
  return { ...over } as Job;
}

describe("JobBuilderClient", () => {
  it("renders the workspace shell, tabs, and basics fields for a draft", () => {
    const html = renderToString(
      createElement(JobBuilderClient, {
        job: makeJob({ id: "job-1", name: "Birdwood Tower", status: "draft" }),
      })
    );

    // Header carries the job name.
    expect(html).toContain("Birdwood Tower");
    // Every section is reachable from the rail, incl. the dedicated Scope section.
    expect(html).toContain("Basics");
    expect(html).toContain("Scope");
    expect(html).toContain("Structure");
    expect(html).toContain("Field modules");
    expect(html).toContain("Phil preview");
    expect(html).toContain("Publish");
    expect(html).toContain("More");
    // Basics (default tab) shows its fields.
    expect(html).toContain("Job name");
    expect(html).toContain("Site address");
    expect(html).toContain("Access notes");
    expect(html).toContain("Site induction required before the crew attends");
    // Scope of work moved to its own Scope section — not on the default Basics tab.
    expect(html).not.toContain("Scope of work");
  });

  it("shows the office-only visibility state for a draft", () => {
    const html = renderToString(
      createElement(JobBuilderClient, {
        job: makeJob({ id: "job-1", name: "Draft Job", status: "draft" }),
      })
    );
    expect(html).toContain("Office-only (not yet published)");
    // A pristine load is not dirty — nothing to save.
    expect(html).toContain("All changes saved");
  });

  it("shows the field-visible state for a published (active) job", () => {
    const html = renderToString(
      createElement(JobBuilderClient, {
        job: makeJob({ id: "job-1", name: "Live Job", status: "active" }),
      })
    );
    expect(html).toContain("Visible to the field");
  });

  // #377 — the structure lock + notice are gone. Even a job WITH archived
  // rooms/tasks must never render the old freeze copy anywhere (the builder is
  // editable; archived items show as read-only rows on the Structure tab).
  it("renders no structure-lock notice, even for a job with archived structure", () => {
    const html = renderToString(
      createElement(JobBuilderClient, {
        job: makeJob({
          id: "job-1",
          name: "Long Runner",
          status: "active",
          areaGroups: [
            { id: "g", name: "L1", areas: [{ id: "a-arch", name: "Old store", archived: true }] },
          ],
          roughInTasks: [{ id: "rt-arch", name: "Old conduit", archived: true }],
        }),
      })
    );
    expect(html).not.toContain("Structure editing is locked");
    expect(html).not.toContain("until the builder can edit around archived items");
  });
});

/**
 * #377 — the read-only archived structure section. SSR-rendered directly (the
 * full client only renders the Basics tab under renderToString). Proves the
 * archived rows show with an "Archived" pill and carry NO editable controls.
 */
describe("ArchivedStructureSection (#377 read-only rows)", () => {
  const archivedJob = makeJob({
    id: "j",
    name: "J",
    areaGroups: [
      {
        id: "g-live",
        name: "Level 1",
        areas: [
          { id: "a-live", name: "Unit 1" },
          { id: "a-arch", name: "Old store", spaceType: "Store", archived: true },
        ],
      },
      { id: "g-arch", name: "Old wing", archived: true, areas: [{ id: "a-x", name: "Room X" }] },
    ],
    roughInTasks: [{ id: "rt-arch", name: "Old conduit run", archived: true }],
    fitOffTasks: [{ id: "ft-arch", name: "Legacy GPO swap", archived: true }],
  });

  it("renders archived groups, areas and job-level tasks as read-only rows with an Archived pill", () => {
    const html = renderToString(
      createElement(ArchivedStructureSection, { archived: projectArchivedStructure(archivedJob) })
    );
    expect(html).toContain("Archived (read-only)");
    // The archived group, area and tasks each appear.
    expect(html).toContain("Old wing");
    expect(html).toContain("Old store");
    expect(html).toContain("Old conduit run");
    expect(html).toContain("Legacy GPO swap");
    // The honest "Archived" pill is present.
    expect(html).toContain("Archived");
    // Read-only: no text inputs and no remove/trash controls in the section.
    expect(html).not.toContain("<input");
    expect(html).not.toContain("Remove");
    expect(html).not.toContain("aria-label=\"Remove area\"");
  });

  it("renders nothing when the job has no archived structure", () => {
    const clean = makeJob({
      id: "j",
      name: "J",
      areaGroups: [{ id: "g", name: "L1", areas: [{ id: "a", name: "U1" }] }],
    });
    const html = renderToString(
      createElement(ArchivedStructureSection, { archived: projectArchivedStructure(clean) })
    );
    expect(html).toBe("");
  });
});
