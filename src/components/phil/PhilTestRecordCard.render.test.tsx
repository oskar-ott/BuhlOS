import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilTestRecordCard, defectPrefillFromFailedRows } from "./PhilTestRecordCard";
import type { TestRecordRow } from "@/domains/test-records/schema";

/**
 * SSR render tests (node env — no jsdom; effects never run under renderToString).
 * They pin the static structure + the HONEST-NUMBERS contract: the sheet opens
 * with one empty circuit row and shows NO pass/fail until a reading + a limit are
 * entered (no fake verdict, P7). The live derivation logic is exercised as a pure
 * function in src/domains/test-records/test-records.test.ts.
 */

function render(props: Partial<Parameters<typeof PhilTestRecordCard>[0]> = {}): string {
  return renderToString(
    createElement(PhilTestRecordCard, {
      open: true,
      jobName: "Birdwood",
      onClose: () => {},
      onSubmit: () => {},
      ...props,
    }),
  ).replace(/<!-- -->/g, "");
}

describe("PhilTestRecordCard", () => {
  it("renders nothing when closed", () => {
    expect(render({ open: false })).toBe("");
  });

  it("opens as a labelled dialog scoped to the job", () => {
    const html = render();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('data-testid="test-record-card"');
    expect(html).toContain("Record test results");
    expect(html).toContain("Birdwood");
  });

  it("shows the requirement label it satisfies when provided", () => {
    expect(render({ requirementLabel: "Circuit test result" })).toContain("Circuit test result");
  });

  it("starts with the tester field and one empty circuit row", () => {
    const html = render();
    expect(html).toContain('data-testid="test-record-tester"');
    expect(html).toContain('data-testid="test-record-circuit"');
    // exactly one circuit row to start
    expect(html.match(/data-testid="test-record-row"/g)).toHaveLength(1);
  });

  it("uses a decimal keypad for the numeric reading + limit fields", () => {
    const html = render();
    // value, min and max are all inputMode=decimal (numeric keypad on a phone).
    // React preserves the camelCase attribute name in the SSR output.
    expect(html.match(/inputMode="decimal"/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("shows NO pass/fail verdict before a reading + limit are entered (no fake numbers, P7)", () => {
    const html = render();
    // the empty row prompts for input rather than asserting a status
    expect(html).toContain("Enter a reading and a pass limit to see pass or fail.");
    expect(html).not.toContain('data-testid="test-record-row-status"');
  });

  it("pre-fills the tester from the signed-in worker when given", () => {
    expect(render({ defaultTester: "Sparky" })).toContain('value="Sparky"');
  });

  it("the submit button is disabled until who-tested + a circuit are filled", () => {
    const html = render();
    // SSR initial state: tester empty, no named circuit → disabled + the helper line
    expect(html).toContain('data-testid="test-record-submit"');
    expect(html).toContain("disabled");
    expect(html).toContain("Add who tested and at least one circuit to save.");
  });

  it("surfaces a parent error message", () => {
    // (an apostrophe would be HTML-escaped in the SSR string — assert plain text)
    expect(render({ errorMessage: "Saved but not attached as proof." })).toContain(
      "Saved but not attached as proof.",
    );
  });

  it("shows the saving label while a save→link is in flight", () => {
    expect(render({ saving: true })).toContain("Saving…");
  });
});

/* ----------------------------------------------------------------------
 * #520 — post-submit saved-result view (defect from a failed circuit)
 * -------------------------------------------------------------------- */

const failedRow: TestRecordRow = {
  circuit: "Ring final — kitchen sockets",
  testType: "insulation_resistance",
  value: 0.4,
  unit: "MΩ",
  min: 1,
  max: null,
  status: "fail",
};

describe("PhilTestRecordCard — #520 saved-result view", () => {
  it("shows the failed circuits + Report defect after a save with failures", () => {
    const html = render({
      savedResult: { recordId: "tr_1", failedRows: [failedRow] },
      onReportDefect: () => {},
    });
    expect(html).toContain("Test saved");
    expect(html).toContain("1 circuit failed.");
    expect(html).toContain('data-testid="test-record-failed-rows"');
    expect(html).toContain("Ring final — kitchen sockets");
    expect(html).toContain('data-testid="test-record-report-defect"');
    expect(html).toContain("Report defect");
    // the capture form is replaced, not stacked
    expect(html).not.toContain('data-testid="test-record-submit"');
  });

  it("pluralises multiple failed circuits", () => {
    const html = render({
      savedResult: {
        recordId: "tr_1",
        failedRows: [failedRow, { ...failedRow, circuit: "Oven circuit" }],
      },
      onReportDefect: () => {},
    });
    expect(html).toContain("2 circuits failed.");
    expect(html).toContain("Oven circuit");
  });

  it("shows the normal capture form when there is no saved result (P10)", () => {
    const html = render({ onReportDefect: () => {} });
    expect(html).toContain('data-testid="test-record-submit"');
    expect(html).not.toContain('data-testid="test-record-report-defect"');
  });

  it("an empty failedRows list closes as before (no saved view)", () => {
    const html = render({ savedResult: { recordId: "tr_1", failedRows: [] } });
    expect(html).toContain('data-testid="test-record-submit"');
    expect(html).not.toContain("Test saved");
  });
});

describe("defectPrefillFromFailedRows", () => {
  it("builds title + description from the REAL readings only (P7)", () => {
    const prefill = defectPrefillFromFailedRows([failedRow]);
    expect(prefill.title).toBe("Failed test: Ring final — kitchen sockets");
    expect(prefill.description).toContain("Insulation resistance");
    expect(prefill.description).toContain("0.4 MΩ");
    expect(prefill.description).toContain("pass ≥ 1 MΩ");
  });

  it("counts the extra failed circuits in the title", () => {
    const prefill = defectPrefillFromFailedRows([
      failedRow,
      { ...failedRow, circuit: "Oven circuit" },
    ]);
    expect(prefill.title).toBe("Failed test: Ring final — kitchen sockets +1 more");
    expect(prefill.description).toContain("Oven circuit");
  });
});
