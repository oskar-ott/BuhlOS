import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilJobAreaDetail } from "./PhilJobAreaDetail";
import type { AreaCounts, AreaStageAvailability } from "./philJobWorkTree";
import type { JobStage, JobTaskTemplate } from "@/domains/jobs/types";

/**
 * Render observation for the area drill-in. No JSX (matches
 * StatusChip.test.tsx — esbuild's transform + the automatic runtime
 * don't always agree in the vitest node env), no Testing Library — we
 * render to an HTML string with react-dom/server and assert on the
 * worker-visible output across every edge case the drill-in must
 * handle. Doubles as a regression guard for the field-use contract.
 */

const noop = () => {};

function render(props: {
  areaName: string;
  spaceType?: string | null;
  stages: AreaStageAvailability;
  stage: JobStage;
  tasks: ReadonlyArray<JobTaskTemplate>;
  counts: AreaCounts;
}) {
  return renderToString(
    createElement(PhilJobAreaDetail, { ...props, onStageChange: noop }),
  );
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const task = (id: string, name: string): JobTaskTemplate => ({ id, name });
const BOTH: AreaStageAvailability = { roughIn: true, fitOff: true };
const RI: AreaStageAvailability = { roughIn: true, fitOff: false };
const FO: AreaStageAvailability = { roughIn: false, fitOff: true };
const NONE: AreaStageAvailability = { roughIn: false, fitOff: false };
const NO_COUNTS: AreaCounts = { snags: 0, itps: 0, photos: 0 };

describe("PhilJobAreaDetail render — header", () => {
  it("always shows the area name; space type when present", () => {
    const html = render({
      areaName: "Main Bar",
      spaceType: "Wet area",
      stages: BOTH,
      stage: "roughIn",
      tasks: [task("t1", "Pull power")],
      counts: NO_COUNTS,
    });
    expect(text(html)).toContain("Main Bar");
    expect(text(html)).toContain("Wet area");
  });
});

describe("PhilJobAreaDetail render — stage selector", () => {
  it("shows a Rough-in / Fit-off selector only when both stages have a plan", () => {
    const html = render({
      areaName: "Main Bar",
      stages: BOTH,
      stage: "roughIn",
      tasks: [task("t1", "Pull power")],
      counts: NO_COUNTS,
    });
    const t = text(html);
    expect(t).toContain("Rough-in");
    expect(t).toContain("Fit-off");
    // role=tablist marks the real selector
    expect(html).toContain('role="tablist"');
  });

  it("shows a static stage label (no selector) when only rough-in exists", () => {
    const html = render({
      areaName: "Riser",
      stages: RI,
      stage: "roughIn",
      tasks: [task("t1", "Cable tray")],
      counts: NO_COUNTS,
    });
    expect(html).not.toContain('role="tablist"');
    expect(text(html)).toContain("Rough-in tasks");
    expect(text(html)).not.toContain("Fit-off");
  });

  it("shows a static Fit-off label when only fit-off exists", () => {
    const html = render({
      areaName: "Foyer",
      stages: FO,
      stage: "fitOff",
      tasks: [task("t1", "Fit downlights")],
      counts: NO_COUNTS,
    });
    expect(html).not.toContain('role="tablist"');
    expect(text(html)).toContain("Fit-off tasks");
  });
});

describe("PhilJobAreaDetail render — task list + empty states", () => {
  it("lists tasks for the viewed stage", () => {
    const html = render({
      areaName: "Main Bar",
      stages: RI,
      stage: "roughIn",
      tasks: [task("t1", "Pull power"), task("t2", "Rough lighting")],
      counts: NO_COUNTS,
    });
    const t = text(html);
    expect(t).toContain("Pull power");
    expect(t).toContain("Rough lighting");
  });

  it("shows an honest empty state when the area has no task plan at all", () => {
    const html = render({
      areaName: "Store room",
      stages: NONE,
      stage: "roughIn",
      tasks: [],
      counts: NO_COUNTS,
    });
    const t = text(html);
    expect(t).toContain("No task plan for this area yet");
    expect(html).not.toContain('role="tablist"');
  });
});

describe("PhilJobAreaDetail render — quick links (real data only)", () => {
  it("emits a chip+anchor per non-zero count and nothing for zeroes", () => {
    const html = render({
      areaName: "Main Bar",
      stages: BOTH,
      stage: "roughIn",
      tasks: [task("t1", "x")],
      counts: { snags: 2, itps: 1, photos: 5 },
    });
    const t = text(html);
    expect(t).toContain("In this area");
    expect(t).toContain("2 snags");
    expect(t).toContain("1 ITP");
    expect(t).toContain("5 photos");
    expect(html).toContain('href="#phil-job-snags"');
    expect(html).toContain('href="#phil-job-itps"');
    expect(html).toContain('href="#phil-job-capture"');
    // honesty caption — counts are area-specific, list is job-wide
    expect(t).toContain("Counts are for this area");
  });

  it("hides the whole quick-link block when nothing is outstanding", () => {
    const html = render({
      areaName: "Main Bar",
      stages: BOTH,
      stage: "roughIn",
      tasks: [task("t1", "x")],
      counts: NO_COUNTS,
    });
    const t = text(html);
    expect(t).not.toContain("In this area");
    expect(html).not.toContain('href="#phil-job-snags"');
  });

  it("shows quick links even when there is no task plan (counts are independent)", () => {
    const html = render({
      areaName: "Store room",
      stages: NONE,
      stage: "roughIn",
      tasks: [],
      counts: { snags: 1, itps: 0, photos: 0 },
    });
    const t = text(html);
    expect(t).toContain("1 snag");
    expect(t).toContain("No task plan for this area yet");
    expect(html).toContain('href="#phil-job-snags"');
    // no fabricated itp/photo links
    expect(html).not.toContain('href="#phil-job-itps"');
    expect(html).not.toContain('href="#phil-job-capture"');
  });

  it("never renders a documents or materials per-area link", () => {
    const html = render({
      areaName: "Main Bar",
      stages: BOTH,
      stage: "roughIn",
      tasks: [task("t1", "x")],
      counts: { snags: 9, itps: 9, photos: 9 },
    });
    expect(html).not.toContain("#phil-job-documents");
    expect(html).not.toContain("#phil-job-materials");
  });
});

/* Observation dump — printed so a human (or the agent) can read exactly
 * what each edge case renders without a browser. Not an assertion. */
describe("PhilJobAreaDetail render — observation dump", () => {
  it("prints visible text per edge case", () => {
    const cases: Array<[string, Parameters<typeof render>[0]]> = [
      [
        "both stages + all counts",
        { areaName: "Main Bar", spaceType: "Wet area", stages: BOTH, stage: "roughIn", tasks: [task("t1", "Pull power"), task("t2", "Rough lighting")], counts: { snags: 2, itps: 1, photos: 5 } },
      ],
      [
        "rough-in only, no counts",
        { areaName: "Riser", stages: RI, stage: "roughIn", tasks: [task("t1", "Cable tray")], counts: NO_COUNTS },
      ],
      [
        "fit-off only, snags only",
        { areaName: "Foyer", stages: FO, stage: "fitOff", tasks: [task("t1", "Fit downlights")], counts: { snags: 1, itps: 0, photos: 0 } },
      ],
      [
        "no plan, photos only",
        { areaName: "Store room", stages: NONE, stage: "roughIn", tasks: [], counts: { snags: 0, itps: 0, photos: 3 } },
      ],
      [
        "no plan, no counts",
        { areaName: "Empty area", stages: NONE, stage: "roughIn", tasks: [], counts: NO_COUNTS },
      ],
    ];
    for (const [label, props] of cases) {
      // eslint-disable-next-line no-console
      console.log(`\n[${label}]\n  ${text(render(props))}`);
    }
    expect(cases.length).toBe(5);
  });
});
