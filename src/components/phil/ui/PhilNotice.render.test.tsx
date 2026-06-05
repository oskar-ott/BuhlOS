import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilNotice } from "./PhilNotice";

/**
 * SSR smoke for the shared Phil notice. Verifies the title/body render, that
 * each tone maps to an on-token state rail (never the old raw-palette boxes),
 * and that the ARIA role can escalate to "alert" for errors.
 */
function render(props: Parameters<typeof PhilNotice>[0]) {
  return renderToString(createElement(PhilNotice, props));
}

describe("PhilNotice", () => {
  it("renders the title and body", () => {
    const html = render({ tone: "warning", title: "Couldn’t load your jobs", children: "Try again" });
    expect(html).toContain("Couldn’t load your jobs");
    expect(html).toContain("Try again");
  });

  it("maps each tone to a distinct on-token rail and drops raw palette", () => {
    const danger = render({ tone: "danger", children: "x" });
    const success = render({ tone: "success", children: "x" });
    const warning = render({ tone: "warning", children: "x" });
    const info = render({ tone: "info", children: "x" });
    expect(danger).toContain("border-l-state-danger");
    expect(success).toContain("border-l-state-success");
    expect(warning).toContain("border-l-state-warning");
    expect(info).toContain("border-l-state-info");
    const all = danger + success + warning + info;
    expect(all).not.toContain("bg-rose-50");
    expect(all).not.toContain("bg-amber-50");
    expect(all).not.toContain("bg-emerald-50");
  });

  it("is a status region by default and an alert when asked", () => {
    expect(render({ children: "x" })).toContain('role="status"');
    expect(render({ role: "alert", children: "x" })).toContain('role="alert"');
  });
});
