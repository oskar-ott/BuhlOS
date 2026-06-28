import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilTestRecordCard } from "./PhilTestRecordCard";

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
