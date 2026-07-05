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
    // Every section is reachable from the rail — Build, Deliver, Ship, More.
    expect(html).toContain("Overview");
    expect(html).toContain("Basics");
    expect(html).toContain("Scope");
    expect(html).toContain("Structure");
    expect(html).toContain("Field modules");
    expect(html).toContain("Plans &amp; docs");
    expect(html).toContain("Materials");
    expect(html).toContain("Gear");
    expect(html).toContain("ITPs / QA");
    expect(html).toContain("Risks &amp; RFIs");
    expect(html).toContain("Crew");
    expect(html).toContain("Phil preview");
    expect(html).toContain("Publish");
    expect(html).toContain("More");
    // Rail groups.
    expect(html).toContain("Deliver");
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

  // #206 Plan Studio — discoverable, not hidden. In the REDESIGN rail it's always
  // listed: ai_drawings ON = the live step; OFF = a "behind flag" sub + a flagged-off
  // canvas (the "where is Plan Studio?" fix). The legacy (redesign-off) rail stays
  // byte-for-byte — it lists Plan Studio only when ai_drawings is on.
  it("Plan Studio: hidden on the legacy rail when dark, discoverable 'behind flag' on the redesign rail", () => {
    const legacyDark = renderToString(
      createElement(JobBuilderClient, {
        job: makeJob({ id: "job-1", name: "Dark Job", status: "draft" }),
      })
    );
    expect(legacyDark).not.toContain("Plan Studio");

    const redesignDark = renderToString(
      createElement(JobBuilderClient, {
        job: makeJob({ id: "job-1", name: "Redesign Job", status: "draft" }),
        redesignEnabled: true,
      })
    );
    expect(redesignDark).toContain("Plan Studio");
    expect(redesignDark).toContain("behind flag");

    const lit = renderToString(
      createElement(JobBuilderClient, {
        job: makeJob({ id: "job-1", name: "Lit Job", status: "draft" }),
        planStudioEnabled: true,
      })
    );
    expect(lit).toContain("Plan Studio");
    expect(lit).not.toContain("behind flag");
  });

  // Waves 3+4 — the redesign-campaign tabs are dark behind job_builder_redesign.
  // OFF: today's rail byte-for-byte (five per-hub link tabs, no Spec/Deliver).
  // ON: Spec & circuits + the single Deliver step; the five link tabs collapse.
  it("swaps the rail's Deliver tabs only when the job_builder_redesign flag prop is on", () => {
    const off = renderToString(
      createElement(JobBuilderClient, {
        job: makeJob({ id: "job-1", name: "Dark Job", status: "draft" }),
      })
    );
    expect(off).not.toContain("Spec &amp; circuits");
    // today's five link-out tabs still present
    expect(off).toContain("Plans &amp; docs");
    expect(off).toContain("Materials");
    expect(off).toContain("ITPs / QA");

    const on = renderToString(
      createElement(JobBuilderClient, {
        job: makeJob({ id: "job-1", name: "Lit Job", status: "draft" }),
        redesignEnabled: true,
      })
    );
    expect(on).toContain("Spec &amp; circuits");
    // the five per-hub tabs collapse into the one Deliver step
    expect(on).not.toContain("Plans &amp; docs");
    expect(on).not.toContain("ITPs / QA");
    // Crew survives (it isn't a link-out hub)
    expect(on).toContain("Crew");
    // Wave 4b — the Documents step joins the Build group when redesign is ON,
    // and is absent from today's rail when OFF. Scoped to the exact rail label
    // ("Documents" also appears mid-sentence in the More tab's copy).
    expect(on).toContain(">Documents<");
    expect(off).not.toContain(">Documents<");

    // Wave 2 — live step sub-labels ride the same flag. A bare job with
    // default modules shows the real "9 on" count (9 of the 10 field-module
    // toggles default ON; itps defaults off). OFF renders no sub-labels.
    expect(off).not.toContain('data-testid="cockpit-nav-sub"');
    expect(on).toContain('data-testid="cockpit-nav-sub"');
    expect(on).toContain("9 on");

    // UI/UX polish — the redesign rail reads in WORK order: scope before the
    // documents step, and Plan Studio (whose output feeds Structure) before
    // Structure. The legacy (off) rail keeps its original order untouched.
    expect(on.indexOf(">Scope<")).toBeGreaterThan(-1);
    expect(on.indexOf(">Scope<")).toBeLessThan(on.indexOf(">Documents<"));
    expect(on.indexOf(">Plan Studio<")).toBeGreaterThan(-1);
    expect(on.indexOf(">Plan Studio<")).toBeLessThan(on.indexOf(">Structure<"));
  });

  // Wave 2 — the header eyebrow (mono ref · site line above the job name) is
  // flag-gated and only ever shows fields that exist.
  it("shows the header eyebrow (ref · site) only when the redesign flag prop is on", () => {
    const job = makeJob({
      id: "job-1",
      name: "Eyebrow Job",
      status: "draft",
      ref: "J-2041",
      siteAddress: "1 Smith St",
    });
    const off = renderToString(createElement(JobBuilderClient, { job }));
    expect(off).not.toContain('data-testid="builder-header-eyebrow"');

    const on = renderToString(createElement(JobBuilderClient, { job, redesignEnabled: true }));
    expect(on).toContain('data-testid="builder-header-eyebrow"');
    expect(on).toContain("Ref J-2041 · 1 Smith St");

    // A job with neither ref nor address renders no eyebrow at all (P7).
    const bare = renderToString(
      createElement(JobBuilderClient, {
        job: makeJob({ id: "job-2", name: "Bare Job", status: "draft" }),
        redesignEnabled: true,
      })
    );
    expect(bare).not.toContain('data-testid="builder-header-eyebrow"');
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
