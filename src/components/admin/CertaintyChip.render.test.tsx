import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { CertaintyChip } from "./CertaintyChip";
import { CERTAINTY_STATES, CERTAINTY_LABEL, type CertaintyState } from "@/domains/jobs/certainty";

function render(cert: CertaintyState): string {
  return renderToString(createElement(CertaintyChip, { cert }));
}

describe("CertaintyChip", () => {
  it("renders the fixed label for every state", () => {
    for (const s of CERTAINTY_STATES) {
      expect(render(s)).toContain(CERTAINTY_LABEL[s]);
    }
  });

  it("tags the chip with its state for styling/test hooks", () => {
    expect(render("confirmed")).toContain('data-cert="confirmed"');
  });

  it("renders a suggestion dashed + muted", () => {
    expect(render("suggested")).toContain("border-dashed");
  });

  it("strikes through an ignored row", () => {
    expect(render("ignored")).toContain("line-through");
  });

  it("gives each state a visually distinct class set", () => {
    const seen = new Set<string>();
    for (const s of CERTAINTY_STATES) {
      const match = render(s).match(/class="([^"]+)"/);
      expect(match, `cert=${s}`).toBeTruthy();
      seen.add(match?.[1] ?? "");
    }
    expect(seen.size).toBe(CERTAINTY_STATES.length);
  });
});
