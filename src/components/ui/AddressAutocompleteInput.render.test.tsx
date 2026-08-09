import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AddressAutocompleteInput } from "./AddressAutocompleteInput";

function render(value = ""): string {
  return renderToString(
    createElement(AddressAutocompleteInput, {
      value,
      onChange: () => {},
      placeholder: "e.g. 12 Magill Rd, Stepney SA 5069",
      className: "test-input-class",
      "data-testid": "job-site-address",
    })
  );
}

describe("AddressAutocompleteInput", () => {
  it("renders a plain combobox input with the passed class, testid and placeholder", () => {
    const html = render();
    expect(html).toContain('role="combobox"');
    expect(html).toContain('data-testid="job-site-address"');
    expect(html).toContain("test-input-class");
    expect(html).toContain("12 Magill Rd, Stepney SA 5069");
  });

  it("keeps the suggestion list closed on first render — even with a long value", () => {
    const html = render("12 Magill Road, Stepney SA 5069");
    expect(html).not.toContain('role="listbox"');
    expect(html).toContain('aria-expanded="false"');
  });

  it("turns browser autofill off so it can't fight the suggestion list", () => {
    expect(render().toLowerCase()).toContain('autocomplete="off"');
  });
});
