import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { SchedulePreview } from "./SchedulePreview";
import { SAMPLE_BOARDS, SAMPLE_JOB } from "@/domains/circuit-schedule/sample-boards";

/**
 * #666 — SSR smoke for the schedule preview's mobile fallback. The wide
 * AS/NZS-3000 schedule table is contained in an overflow-x-auto wrapper so it
 * scrolls inside the paper on a phone instead of breaking the page; the print
 * rule (which targets .cs-paper) is unaffected.
 */
const noop = () => {};

describe("SchedulePreview mobile fallback (#666)", () => {
  it("wraps the schedule table in an overflow-x-auto container", () => {
    const html = renderToString(
      createElement(SchedulePreview, {
        board: SAMPLE_BOARDS[0]!,
        job: SAMPLE_JOB,
        onBack: noop,
      }),
    );
    expect(html).toContain("overflow-x-auto");
    // the doc table still renders inside the paper
    expect(html).toContain("cs-doc-table");
    expect(html).toContain("cs-paper");
  });
});
