import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ScheduleBuilder } from "./ScheduleBuilder";
import { SAMPLE_BOARDS, SAMPLE_JOB } from "@/domains/circuit-schedule/sample-boards";

/**
 * #666 — SSR smoke for the schedule builder's mobile fallback. The grid is a
 * desktop authoring tool, so on a phone it must scroll inside its own wrapper
 * (overflow-x-auto) rather than force page-wide overflow, and carry an honest
 * "best on desktop" hint. Pins both so they can't silently regress (and so the
 * file stays out of admin-mobile-tables.test's exempt list legitimately).
 */
const noop = () => {};

describe("ScheduleBuilder mobile fallback (#666)", () => {
  const html = renderToString(
    createElement(ScheduleBuilder, {
      board: SAMPLE_BOARDS[0]!,
      job: SAMPLE_JOB,
      canManage: true,
      update: noop,
      onDelete: noop,
      onBack: noop,
      onPrint: noop,
    }),
  );

  it("contains the table's overflow-x-auto scroll container", () => {
    expect(html).toContain("overflow-x-auto");
  });

  it("shows an honest, desktop-only authoring hint (sm:hidden)", () => {
    expect(html).toContain("Best edited on a desktop");
    expect(html).toContain("cs-mobile-hint");
    expect(html).toContain("sm:hidden");
  });
});
