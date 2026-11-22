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

describe("NewJobForm — BuhlOS issues the number (job_code_auto, #1152)", () => {
  it("off (the default): the IV number is required, worded as before", () => {
    const html = renderToString(createElement(NewJobForm));
    expect(html).toContain("The job number workers give the wholesaler");
    expect(html).toContain('placeholder="e.g. IV3232"');
    expect(html).not.toContain("Leave blank");
  });

  it("on: the IV number is optional and says what leaving it blank does", () => {
    const html = renderToString(createElement(NewJobForm, { issuedNumbers: true }));
    expect(html).toContain("Leave blank and BuhlOS gives the job the next number. Or type one, e.g. a ServiceM8 number.");
    expect(html).toContain('placeholder="Blank = next BuhlOS number"');
    // the name still carries the required mark; the IV number no longer does
    const marks = (html.match(/text-rose-600">\*</g) ?? []).length;
    expect(marks).toBe(1);
    // no number is shown before one exists
    expect(html).not.toContain("issued-job-code");
  });
});
