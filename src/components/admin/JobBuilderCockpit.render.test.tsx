import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobBuilderCockpit, type CockpitNavGroup } from "./JobBuilderCockpit";
import type { BuilderReadiness } from "@/domains/jobs/builder";

const readiness: BuilderReadiness = {
  state: "warnings",
  stateLabel: "Ready — with warnings",
  tone: "warning",
  blockers: [],
  warnings: [
    { code: "no-site-address", message: "No site address.", severity: "warning", source: "publish" },
  ],
  blockingCount: 0,
  warningCount: 1,
  canPublish: true,
};

const nav: CockpitNavGroup[] = [
  {
    heading: "Build",
    items: [
      { key: "basics", label: "Basics", status: "ok" },
      { key: "structure", label: "Structure", status: "block", testId: "builder-structure-tab" },
    ],
  },
  {
    heading: "Ship",
    items: [{ key: "publish", label: "Publish", status: "ok", testId: "builder-publish-tab" }],
  },
];

function render(activeKey: string): string {
  return renderToString(
    createElement(JobBuilderCockpit, {
      readiness,
      nav,
      activeKey,
      onSelect: () => {},
      canvas: createElement("div", { "data-testid": "the-canvas" }, "CANVAS BODY"),
      inspector: createElement("div", {}, "INSPECTOR BODY"),
    })
  );
}

describe("JobBuilderCockpit", () => {
  it("renders the readiness meter with state label and counts", () => {
    const html = render("basics");
    expect(html).toContain("Build readiness");
    expect(html).toContain("Ready — with warnings");
    expect(html).toContain("Blocker"); // the meter cell label
    expect(html).toContain("Warning");
  });

  it("renders grouped nav with the section labels and preserved testids", () => {
    const html = render("basics");
    expect(html).toContain("Build");
    expect(html).toContain("Ship");
    expect(html).toContain("Basics");
    expect(html).toContain("Structure");
    expect(html).toContain("Publish");
    expect(html).toContain('data-testid="builder-structure-tab"');
    expect(html).toContain('data-testid="builder-publish-tab"');
  });

  it("marks the active section with aria-current=page", () => {
    const html = render("structure");
    expect(html).toContain('aria-current="page"');
  });

  it("renders the canvas and inspector slots", () => {
    const html = render("basics");
    expect(html).toContain("CANVAS BODY");
    expect(html).toContain("INSPECTOR BODY");
  });

  it("renders a pinned Review queue rail entry with the untriaged count", () => {
    const html = renderToString(
      createElement(JobBuilderCockpit, {
        readiness,
        nav,
        activeKey: "basics",
        onSelect: () => {},
        reviewCount: 4,
        reviewActive: false,
        onOpenReview: () => {},
        canvas: createElement("div", {}, "C"),
        inspector: createElement("div", {}, "I"),
      })
    );
    expect(html).toContain('data-testid="cockpit-open-review"');
    expect(html).toContain("Review queue");
    expect(html).toContain(">4<"); // the count badge
  });

  it("omits the Review queue entry when reviewCount is undefined", () => {
    const html = render("basics"); // base render passes no review props
    expect(html).not.toContain('data-testid="cockpit-open-review"');
  });

  // Wave 2 (job_builder_redesign) — the rail readiness summary is flag-gated:
  // ON shows the Bar (progressbar aria) + the mono counts line rolled up from
  // the nav items' own statuses; OFF renders today's rail with neither.
  it("shows the rail readiness bar + counts line when redesign is on", () => {
    const html = renderToString(
      createElement(JobBuilderCockpit, {
        readiness,
        nav,
        activeKey: "basics",
        onSelect: () => {},
        redesign: true,
        canvas: createElement("div", {}, "C"),
        inspector: createElement("div", {}, "I"),
      })
    );
    expect(html).toContain('data-testid="cockpit-rail-readiness"');
    expect(html).toContain('role="progressbar"');
    // fixture nav: basics ok · structure block · publish ok → 2 / 0 / 1
    expect(html).toContain("2 ready · 0 review · 1 block");
  });

  it("renders no rail readiness bar when redesign is off (today's rail)", () => {
    const html = render("basics"); // base render passes no redesign prop
    expect(html).not.toContain('data-testid="cockpit-rail-readiness"');
    expect(html).not.toContain('role="progressbar"');
  });

  it("renders a step sub-label only when redesign is on", () => {
    const navWithSub: CockpitNavGroup[] = [
      {
        heading: "Build",
        items: [{ key: "structure", label: "Structure", status: "ok", sub: "3 areas" }],
      },
    ];
    const base = {
      readiness,
      nav: navWithSub,
      activeKey: "basics",
      onSelect: () => {},
      canvas: createElement("div", {}, "C"),
      inspector: createElement("div", {}, "I"),
    };
    const on = renderToString(createElement(JobBuilderCockpit, { ...base, redesign: true }));
    expect(on).toContain('data-testid="cockpit-nav-sub"');
    expect(on).toContain("3 areas");
    const off = renderToString(createElement(JobBuilderCockpit, base));
    expect(off).not.toContain('data-testid="cockpit-nav-sub"');
    expect(off).not.toContain("3 areas");
  });
});
