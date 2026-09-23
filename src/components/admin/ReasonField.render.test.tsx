import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ReasonField } from "./ReasonField";

function render(props: Partial<Parameters<typeof ReasonField>[0]> = {}) {
  return renderToString(
    createElement(ReasonField, { value: "", onChange: () => {}, ...props }),
  );
}

describe("ReasonField — the send-back dialogs' required reason", () => {
  it("renders no alert and no describedby while there is no error", () => {
    const html = render();
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("aria-describedby");
    expect(html).toContain('aria-required="true"');
  });

  it("renders the error next to the textarea, wired with aria-describedby", () => {
    const html = render({ value: "wrong job", error: "Couldn't reject. Try again." });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Couldn&#x27;t reject. Try again.");
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).toContain('aria-invalid="true"');
    // The typed reason is still in the field (a failure never wipes it).
    expect(html).toContain(">wrong job</textarea>");
  });

  it("labels the textarea by id", () => {
    const html = render();
    const id = /<textarea[^>]*\sid="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`for="${id}"`);
  });
});
