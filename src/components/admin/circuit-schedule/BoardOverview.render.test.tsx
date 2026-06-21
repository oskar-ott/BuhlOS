import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { BoardOverview } from "./BoardOverview";
import { SAMPLE_BOARDS, SAMPLE_JOB } from "@/domains/circuit-schedule/sample-boards";

/**
 * SSR smoke for the office board overview — the client render path the API
 * test can't reach. Pins: it renders the boards + KPIs without throwing, shows
 * the Add affordance only when the viewer can manage, and is honest-empty for a
 * read-only viewer with no schedule.
 */
const noop = () => {};

describe("BoardOverview", () => {
  it("renders boards + KPIs and the Add control for a manager", () => {
    const html = renderToString(
      createElement(BoardOverview, {
        boards: SAMPLE_BOARDS,
        job: SAMPLE_JOB,
        canManage: true,
        onOpen: noop,
        onAddBoard: noop,
        onPrint: noop,
      }),
    );
    expect(html).toContain("Circuit schedules");
    expect(html).toContain("Main switchboard");
    expect(html).toContain("AS/NZS 3000");
    expect(html).toContain("Add board");
  });

  it("hides the Add control for a read-only viewer", () => {
    const html = renderToString(
      createElement(BoardOverview, {
        boards: SAMPLE_BOARDS,
        job: SAMPLE_JOB,
        canManage: false,
        onOpen: noop,
        onAddBoard: noop,
        onPrint: noop,
      }),
    );
    expect(html).toContain("Main switchboard");
    expect(html).not.toContain("Add board");
    expect(html).not.toContain("Add a board");
  });

  it("is honest-empty for a read-only viewer with no schedule", () => {
    const html = renderToString(
      createElement(BoardOverview, {
        boards: [],
        job: SAMPLE_JOB,
        canManage: false,
        onOpen: noop,
        onAddBoard: noop,
        onPrint: noop,
      }),
    );
    expect(html).toContain("No circuit schedules yet");
  });
});
