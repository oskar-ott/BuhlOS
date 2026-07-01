import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobInterfaceSectionNav } from "./JobInterfaceSectionNav";
import type { Job } from "@/domains/jobs/types";

/**
 * #760 owner feature-control: the job-hub section nav hides a live section only
 * when the owner has explicitly turned its kill-switch off (killSwitches[key]
 * === false). Everything else — including sections whose flag is absent from the
 * map — stays visible (live-by-default). Props-only SSR render (no router).
 */

const job = { id: "j1", name: "Riverside" } as unknown as Job;

function render(killSwitches?: Partial<Record<string, boolean>>): string {
  return renderToString(
    createElement(JobInterfaceSectionNav, { job, itpEnabled: true, killSwitches }),
  );
}

describe("<JobInterfaceSectionNav /> kill-switch filtering (#760)", () => {
  it("shows every live section by default (no killSwitches map)", () => {
    const html = render();
    // React SSR escapes & → &amp; ("Documents & specs" → "Documents &amp; specs").
    for (const label of ["Evidence", "Snags", "Observations", "Diary", "Activity", "Documents &amp; specs"]) {
      expect(html).toContain(label);
    }
  });

  it("hides ONLY the sections explicitly turned off; the rest stay", () => {
    const html = render({ snags: false, diary: false, evidence: true });
    // Turned off → gone.
    expect(html).not.toContain("Defects raised by the field"); // Snags description
    expect(html).not.toContain("day-by-day site diary"); // Diary description
    // Still on (explicit true, or absent = live-by-default).
    expect(html).toContain("Evidence");
    expect(html).toContain("Observations");
    expect(html).toContain("Consolidated audit trail"); // Activity
  });

  it("a flag absent from the map is treated as ON (live by default)", () => {
    const html = render({ snags: false }); // only snags resolved off
    expect(html).toContain("Circuit schedules");
    expect(html).toContain("Closeout");
  });
});
