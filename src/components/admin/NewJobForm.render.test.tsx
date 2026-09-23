import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { NewJobForm, createJobFieldError } from "./NewJobForm";

describe("NewJobForm — the Create button explains itself", () => {
  it("is clickable on an empty (invalid) form — a click reveals the errors instead of a dead button", () => {
    const html = renderToString(createElement(NewJobForm));
    const button = /<button[^>]*data-testid="create-draft"[^>]*>/.exec(html)?.[0] ?? "";
    expect(button).not.toBe("");
    expect(button).not.toMatch(/\sdisabled(="[^"]*")?[\s>]/);
    // No errors before the first attempt.
    expect(html).not.toContain("IV number is required");
  });
});

describe("createJobFieldError — server refusals land on their field", () => {
  it("puts a duplicate IV number (409) on the code field, naming the clashing job", () => {
    expect(
      createJobFieldError(409, { error: 'code IV3232 is already used by "Magill Rd"' }),
    ).toEqual({ code: "That IV number is already used by “Magill Rd” — pick another." });
    expect(createJobFieldError(409, {})).toEqual({
      code: "That IV number is already in use — pick another.",
    });
  });

  it("puts a duplicate name (400 id already exists) on the name field", () => {
    expect(createJobFieldError(400, { error: "job id already exists" })).toEqual({
      name: "A job with this name already exists — use a different name.",
    });
  });

  it("leaves every other failure as a form-level error", () => {
    expect(createJobFieldError(400, { error: "name required" })).toBeNull();
    expect(createJobFieldError(500, null)).toBeNull();
    expect(createJobFieldError(0, "timeout")).toBeNull();
  });
});
