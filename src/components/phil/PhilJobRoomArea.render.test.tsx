import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

vi.mock("next/navigation", () => ({
  usePathname: () => "/phil/jobs/j1",
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { PhilJobRoomArea } from "./PhilJobRoomArea";
import type { PhilTaskReadiness } from "@/domains/jobs/phil-task-projection";
import type { OwedProofItem } from "./philJobRooms";

/**
 * SSR smoke for the rooms-flow Area view (phil_job_rooms, dark — #133 §2.4).
 * Pins: phase-pill semantics, REAL task states in prototype voice, the
 * observation-derived blocked banner, honest streaming/empty branches, and
 * the sticky Photo · Note · Issue capture bar.
 */

type AreaProps = Parameters<typeof PhilJobRoomArea>[0];

function baseProps(over: Partial<AreaProps> = {}): AreaProps {
  return {
    jobId: "j1",
    areaId: "a1",
    areaName: "Reception",
    stages: { roughIn: true, fitOff: true },
    stage: "roughIn",
    onStageChange: () => {},
    tasks: [
      { id: "t1", name: "Cable pulls — reception ring", state: "complete" },
      { id: "t2", name: "GPOs terminated", state: "in_progress" },
      { id: "t3", name: "Data outlets — 6 points", state: "not_started" },
    ],
    taskStatePending: false,
    taskStateError: null,
    taskError: null,
    onToggleTask: () => {},
    owedProof: [],
    onBack: () => {},
    onCapturePhoto: () => {},
    onCaptureNote: () => {},
    onCaptureIssue: () => {},
    ...over,
  };
}

function render(over: Partial<AreaProps> = {}) {
  return renderToString(createElement(PhilJobRoomArea, baseProps(over)));
}

describe("PhilJobRoomArea", () => {
  it("renders heading, back exit, phase pills (current filled navy) and n/m", () => {
    const html = render();
    expect(html).toContain("Reception");
    expect(html).toContain('data-testid="phil-room-area-back"');
    expect(html).toContain("Whole job");
    // Both stages exist → the segmented pills; current = filled navy.
    expect(html).toContain('role="tablist"');
    expect(html).toContain("Rough-in");
    expect(html).toContain("Fit-off");
    expect(html).toContain("bg-brand-navy");
    // Real counts: 1 of 3 done, 2 left.
    expect(html).toContain("2 left in rough-in");
    expect(html).toContain("1/3 done");
  });

  it("renders task rows with real states in site voice — Going for in-progress", () => {
    const html = render();
    expect(html).toContain("Cable pulls — reception ring");
    expect(html).toContain(">Going<"); // in-progress chip (uppercased by CSS)
    expect(html).toContain("Mark done");
    expect(html).toContain("Undo"); // the done row's non-optimistic control
  });

  it("hides the pills when the area has a single stage (nothing to choose)", () => {
    const html = render({ stages: { roughIn: true, fitOff: false } });
    expect(html).not.toContain('role="tablist"');
    expect(html).toContain("Rough-in");
  });

  it("shows the blocked banner ONLY for real observation-derived blockers", () => {
    const none = render();
    expect(none).not.toContain(">Blocked<");
    const readiness = new Map<string, PhilTaskReadiness>([
      ["t3", { readiness: "blocked", blockedReason: "Joinery not landed" }],
    ]);
    const html = render({ readinessByTaskId: readiness });
    expect(html).toContain("Blocked");
    expect(html).toContain("Joinery not landed");
  });

  it("shows 'Needs you here' only when proof is really owed in THIS area", () => {
    const none = render();
    expect(none).not.toContain("Needs you here");
    const owed: OwedProofItem[] = [
      {
        workPackageId: "wp1",
        workPackageTitle: "Reception power",
        requirement: { id: "re1", label: "Photo before it's sheeted", kind: "photo" },
        areaIds: ["a1"],
      },
      {
        workPackageId: "wp2",
        workPackageTitle: "Elsewhere",
        requirement: { id: "re2", label: "Other-area photo", kind: "photo" },
        areaIds: ["a2"],
      },
    ];
    const html = render({ owedProof: owed });
    expect(html).toContain("Needs you here");
    expect(html).toContain("Photo before it&#x27;s sheeted");
    expect(html).not.toContain("Other-area photo"); // other area's proof stays out
  });

  it("streams honestly: skeleton rows while pending, never a false 'to do'", () => {
    const html = render({ taskStatePending: true });
    expect(html).toContain('aria-label="Loading task progress"');
    expect(html).not.toContain("Mark done");
    expect(html).not.toContain("left in rough-in");
  });

  it("names the reason on an empty stage / missing plan", () => {
    const empty = render({ tasks: [] });
    expect(empty).toContain("Nothing listed in rough-in");
    const noPlan = render({ tasks: [], stages: { roughIn: false, fitOff: false } });
    expect(noPlan).toContain("No task plan for this area yet");
  });

  it("renders the sticky Photo · Note · Issue capture bar (≥44px targets)", () => {
    const html = render();
    expect(html).toContain('data-testid="phil-room-area-capture-bar"');
    expect(html).toContain(">Photo<");
    expect(html).toContain(">Note<");
    expect(html).toContain(">Issue<");
    expect(html).toContain("min-h-[48px]");
  });
});
