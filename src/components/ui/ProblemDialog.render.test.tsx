import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ProblemDialog } from "./ProblemDialog";
import { explainHoursProblem } from "@/domains/timesheets/problem";

/**
 * The error pop-up (owner pull 2026-10-11): what didn't happen, what went
 * wrong, why, and what to do — in one alertdialog that sits above the phone
 * closeout's review sheet.
 */
function render(props: Parameters<typeof ProblemDialog>[0]): string {
  return renderToString(createElement(ProblemDialog, props));
}

describe("ProblemDialog", () => {
  const ownHours = explainHoursProblem("fix", { status: 403, body: { error: "cannot amend your own hours" } });

  it("renders nothing when there's no problem", () => {
    expect(render({ problem: null, onClose: () => {} })).toBe("");
  });

  it("shows the caption, title, why and what to do — as an alertdialog above the review sheet", () => {
    const html = render({ problem: ownHours, onClose: () => {} });
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("z-[80]");
    expect(html).toContain("Fix not saved");
    expect(html).toContain("You can&#x27;t do this to your own hours");
    expect(html).toContain("Nobody fixes their own pay from the office side.");
    expect(html).toContain("What to do");
    expect(html).toContain('data-testid="problem-ok"');
  });

  it("offers 'Try again' only when retrying can work AND the screen can retry", () => {
    const offline = explainHoursProblem("log", { status: 0, kind: "network" });
    expect(render({ problem: offline, onClose: () => {}, onRetry: () => {} })).toContain("problem-retry");
    expect(render({ problem: offline, onClose: () => {} })).not.toContain("problem-retry");
    // Own-hours can't be fixed by retrying — no button that would fail again.
    expect(render({ problem: ownHours, onClose: () => {}, onRetry: () => {} })).not.toContain("problem-retry");
  });
});
