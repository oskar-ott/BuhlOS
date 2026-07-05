import { describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { Bar } from "./Bar";
import { Dot } from "./Dot";
import { Avatar, initialsFromName } from "./Avatar";
import { SevBadge } from "./SevBadge";
import { SourceBadge } from "./SourceBadge";
import { ActionBadge } from "./ActionBadge";
import { PageHead } from "./PageHead";
import { KpiStrip } from "./KpiStrip";
import { Seg } from "./Seg";
import { PhotoTile } from "./PhotoTile";
import { Row } from "./Row";

const r = (el: ReactElement) => renderToString(el).replace(/<!-- -->/g, "");

describe("Bar", () => {
  it("clamps + buckets the fill width and sets progressbar aria", () => {
    expect(r(createElement(Bar, { pct: 50 }))).toContain("w-1/2");
    expect(r(createElement(Bar, { pct: 250 }))).toContain("w-full"); // clamped
    expect(r(createElement(Bar, { pct: -10 }))).toContain("w-0");
    expect(r(createElement(Bar, { pct: 73, tone: "danger" }))).toContain('aria-valuenow="73"');
    expect(r(createElement(Bar, { pct: 73, tone: "danger" }))).toContain("bg-state-danger");
  });
});

describe("Avatar", () => {
  it("derives initials", () => {
    expect(initialsFromName("Jordan Pike")).toBe("JP");
    expect(initialsFromName("Madonna")).toBe("MA");
    expect(initialsFromName("  ")).toBe("?");
  });
  it("renders initials", () => {
    expect(r(createElement(Avatar, { name: "Jordan Pike" }))).toContain("JP");
    expect(r(createElement(Avatar, { name: "A B", tone: "yellow", size: "lg" }))).toContain("AB");
  });
});

describe("badges", () => {
  it("SevBadge words lead", () => {
    expect(r(createElement(SevBadge, { sev: "critical" }))).toContain("Critical");
    expect(r(createElement(SevBadge, { sev: "info" }))).toContain("Info");
  });
  it("SourceBadge shows the register", () => {
    expect(r(createElement(SourceBadge, { source: "Snags" }))).toContain("Snags");
  });
  it("ActionBadge is honest about exact vs fallback", () => {
    expect(r(createElement(ActionBadge, { exact: true }))).toContain("Exact action");
    expect(r(createElement(ActionBadge, { exact: false }))).toContain("Fallback");
  });
});

describe("PageHead + KpiStrip", () => {
  it("PageHead renders title + sub + actions", () => {
    const html = r(
      createElement(PageHead, {
        title: "Hours",
        sub: "Week 24 · pay run Thu",
        actions: createElement("button", {}, "Export"),
      })
    );
    expect(html).toContain("Hours");
    expect(html).toContain("Week 24");
    expect(html).toContain("Export");
  });
  it("KpiStrip renders cells incl. an honest not-tracked dash", () => {
    const html = r(
      createElement(KpiStrip, {
        cells: [
          { lbl: "Open", num: 4, tone: "warn" },
          { lbl: "Stale", num: "—" },
        ],
      })
    );
    expect(html).toContain("Open");
    expect(html).toContain("4");
    expect(html).toContain("—");
    expect(html).toContain("text-state-danger"); // warn tone
  });

  it("KpiStrip: a cell with onClick becomes a labelled button; a plain cell stays static", () => {
    const html = r(
      createElement(KpiStrip, {
        cells: [
          { lbl: "Blockers", num: 3, onClick: () => {}, ariaLabel: "Blockers: 3 — open Publish" },
          { lbl: "Areas", num: 7 },
        ],
      })
    );
    // The clickable cell is a real button carrying its accessible label…
    expect(html).toContain("<button");
    expect(html).toContain('aria-label="Blockers: 3 — open Publish"');
    // …and it's the ONLY button — the plain "Areas" cell stays a div.
    expect(html.match(/<button/g)?.length).toBe(1);
    expect(html).toContain("Areas");
  });
});

describe("Seg", () => {
  it("marks the active option and renders counts", () => {
    const html = r(
      createElement(Seg, {
        options: [
          { value: "open", label: "Open", count: 3 },
          { value: "all", label: "All" },
        ],
        value: "open",
        onChange: () => {},
      })
    );
    expect(html).toContain("Open");
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("3");
  });
});

describe("Dot + PhotoTile", () => {
  it("Dot tones + PhotoTile caption render", () => {
    expect(r(createElement(Dot, { tone: "red" }))).toContain("bg-state-danger");
    expect(r(createElement(PhotoTile, { caption: "PLAN" }))).toContain("PLAN");
  });
});

describe("Row", () => {
  it("renders title + meta + right; becomes a button when clickable", () => {
    const plain = r(createElement(Row, { title: "Unit 1", meta: "Level 1 · 3 tasks", right: "→" }));
    expect(plain).toContain("Unit 1");
    expect(plain).toContain("Level 1");
    expect(plain).not.toContain("<button");
    const clickable = r(createElement(Row, { title: "Click me", onClick: () => {} }));
    expect(clickable).toContain("<button");
  });
});
