import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { DialPicker } from "./DialPicker";

/**
 * The band follows the SPIN, the pick follows TAPS (2026-09-23 usability
 * audit). The yellow notch (data-band="picked") may only mark the row that is
 * actually picked; spun away from it, the caption names the real pick so an
 * untapped row in the band can never pass for the choice. SSR renders the
 * landing position (the pick, else initialId, else the top row).
 */
const items = [
  { id: "daytype:sick", label: "Sick day" },
  { id: "daytype:holiday", label: "Holiday" },
  { id: "j1", label: "Smith Residence Rewire" },
  { id: "j2", label: "Smith St Shopfit" },
];

function render(props: Partial<Parameters<typeof DialPicker>[0]> = {}) {
  return renderToString(
    createElement(DialPicker, {
      items,
      selectedId: null,
      onSelect: () => {},
      disabled: false,
      ariaLabel: "Choose the job for these hours",
      countNoun: "options",
      testId: "job-dial",
      ...props,
    })
  );
}

describe("DialPicker — honest band", () => {
  it("nothing picked: the band carries no 'picked' notch", () => {
    const html = render();
    expect(html).toContain('data-band="empty"');
    expect(html).not.toContain('aria-checked="true"');
  });

  it("lands on initialId when nothing is picked (not the day types on top)", () => {
    const html = render({ initialId: "j1" });
    expect(html).toContain("3 of 4 options");
  });

  it("the pick sitting in the band gets the notch", () => {
    const html = render({ selectedId: "j2" });
    expect(html).toContain('data-band="picked"');
    expect(html).toContain('aria-checked="true"');
  });

  it("the picked row always reads as picked (tick + picked style)", () => {
    const html = render({ selectedId: "j2" });
    const picked = html.slice(html.indexOf('aria-checked="true"') - 200, html.indexOf("Smith St Shopfit"));
    expect(picked).toContain("itemPicked");
    expect(html).toContain("✓");
  });
});
