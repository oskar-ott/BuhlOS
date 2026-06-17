import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilJobAreaDetail } from "./PhilJobAreaDetail";
import type { AreaCounts, AreaStageAvailability } from "./philJobWorkTree";
import type { JobStage } from "@/domains/jobs/types";
import type { TaskState, WorkerTask } from "@/domains/jobs/taskState";
import type { PhilTaskReadiness } from "@/domains/jobs/phil-task-projection";

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
  tasks: ReadonlyArray<WorkerTask>;
  counts: AreaCounts;
  onToggleTask?: (taskId: string, next: TaskState) => void;
  pendingTaskIds?: ReadonlySet<string>;
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

const task = (
  id: string,
  name: string,
  state: TaskState = "not_started",
): WorkerTask => ({ id, name, state });
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

describe("PhilJobAreaDetail render — task state + toggle", () => {
  it("read-only (no onToggleTask) shows a real state pill and no controls", () => {
    const html = render({
      areaName: "Main Bar",
      stages: RI,
      stage: "roughIn",
      tasks: [task("t1", "Pull power", "complete"), task("t2", "Rough lighting")],
      counts: NO_COUNTS,
    });
    const t = text(html);
    expect(t).toContain("Done"); // state of the complete task
    expect(t).toContain("To do"); // state of the not-started task
    // No mutation affordance when the parent didn't wire one.
    expect(t).not.toContain("Mark done");
    expect(t).not.toContain("Undo");
  });

  it("interactive: Mark done for not-done tasks, Undo for done tasks", () => {
    const html = render({
      areaName: "Main Bar",
      stages: RI,
      stage: "roughIn",
      tasks: [task("t1", "Pull power"), task("t2", "Rough lighting", "complete")],
      counts: NO_COUNTS,
      onToggleTask: noop,
    });
    const t = text(html);
    expect(t).toContain("Mark done");
    expect(t).toContain("Undo");
  });

  it("displays a pre-existing in_progress state but still offers Mark done (binary v1)", () => {
    const html = render({
      areaName: "Main Bar",
      stages: RI,
      stage: "roughIn",
      tasks: [task("t1", "Pull power", "in_progress")],
      counts: NO_COUNTS,
      onToggleTask: noop,
    });
    // We faithfully render in_progress (never hide real state) but the v1
    // control drives it straight to done.
    expect(text(html)).toContain("Mark done");
  });

  it("shows a saving state and disables the control for a pending task", () => {
    const html = render({
      areaName: "Main Bar",
      stages: RI,
      stage: "roughIn",
      tasks: [task("t1", "Pull power")],
      counts: NO_COUNTS,
      onToggleTask: noop,
      pendingTaskIds: new Set(["t1"]),
    });
    expect(text(html)).toContain("Saving");
    expect(html).toContain("disabled");
  });

  it("shows an honest completion count for the viewed stage", () => {
    const html = render({
      areaName: "Main Bar",
      stages: RI,
      stage: "roughIn",
      tasks: [
        task("t1", "a", "complete"),
        task("t2", "b"),
        task("t3", "c", "complete"),
      ],
      counts: NO_COUNTS,
    });
    expect(text(html)).toContain("2 of 3 done");
  });

  it("reads 'All N done' only when every task is complete", () => {
    const html = render({
      areaName: "Main Bar",
      stages: RI,
      stage: "roughIn",
      tasks: [task("t1", "a", "complete"), task("t2", "b", "complete")],
      counts: NO_COUNTS,
    });
    expect(text(html)).toContain("All 2 done");
  });

  it("never renders admin/editor controls in the field drill-in", () => {
    const html = render({
      areaName: "Main Bar",
      stages: BOTH,
      stage: "roughIn",
      tasks: [task("t1", "Pull power")],
      counts: NO_COUNTS,
      onToggleTask: noop,
    });
    const t = text(html).toLowerCase();
    expect(t).not.toContain("edit task");
    expect(t).not.toContain("add task");
    expect(t).not.toContain("delete");
    expect(t).not.toContain("archive");
    // No free-text editors leak the office builder into the field view.
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("contentEditable");
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

describe("PhilJobAreaDetail render — readiness/blocker indicator", () => {
  function renderWithReadiness(
    readinessByTaskId: ReadonlyMap<string, PhilTaskReadiness>,
  ): string {
    return renderToString(
      createElement(PhilJobAreaDetail, {
        areaName: "Main Bar",
        stages: RI,
        stage: "roughIn" as JobStage,
        tasks: [task("t1", "Pull power"), task("t2", "Rough lighting")],
        counts: NO_COUNTS,
        onStageChange: noop,
        readinessByTaskId,
      }),
    );
  }

  it("shows a 'Blocked — <reason>' line only for the blocked task", () => {
    const map = new Map<string, PhilTaskReadiness>([
      ["t1", { readiness: "blocked", blockedReason: "Waiting on switchgear" }],
      ["t2", { readiness: "ready", blockedReason: null }],
    ]);
    const out = text(renderWithReadiness(map));
    expect(out).toContain("Blocked");
    expect(out).toContain("Waiting on switchgear");
    // The ready task contributes no blocked/ready label (no clutter).
    expect(out).not.toContain("Ready");
  });

  it("renders no blocked line when nothing is blocked (honest-empty = zero change)", () => {
    const map = new Map<string, PhilTaskReadiness>([
      ["t1", { readiness: "ready", blockedReason: null }],
      ["t2", { readiness: "complete", blockedReason: null }],
    ]);
    const out = text(renderWithReadiness(map));
    expect(out).not.toContain("Blocked");
    // The task names still render exactly as before.
    expect(out).toContain("Pull power");
    expect(out).toContain("Rough lighting");
  });

  it("with no readiness map at all, rows render exactly as today (no blocked line)", () => {
    const out = text(
      renderToString(
        createElement(PhilJobAreaDetail, {
          areaName: "Main Bar",
          stages: RI,
          stage: "roughIn" as JobStage,
          tasks: [task("t1", "Pull power")],
          counts: NO_COUNTS,
          onStageChange: noop,
        }),
      ),
    );
    expect(out).not.toContain("Blocked");
    expect(out).toContain("Pull power");
  });
});
