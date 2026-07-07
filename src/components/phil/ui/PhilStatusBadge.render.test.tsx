import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  PHIL_STATUS_TONE,
  PhilStatusBadge,
  type PhilStatusLabel,
  type PhilStatusTone,
} from "./PhilStatusBadge";

/**
 * SSR smoke for the sharpened status badge — the ONE badge language (§1).
 * Pins the canonical label→tone vocabulary, the on-token tint quads (never a
 * raw hex or Tailwind palette class), the 6px dot, and the 12px label floor.
 */
function render(props: Parameters<typeof PhilStatusBadge>[0]) {
  return renderToString(createElement(PhilStatusBadge, props));
}

const TONE_PILL: Record<PhilStatusTone, string> = {
  neutral: "bg-state-neutral-subtle-bg",
  info: "bg-state-info-subtle-bg",
  warning: "bg-state-warning-subtle-bg",
  danger: "bg-state-danger-subtle-bg",
  success: "bg-state-success-subtle-bg",
};

describe("PhilStatusBadge", () => {
  it("renders every canonical label with its vocabulary tone (dot + tint pill)", () => {
    for (const [label, tone] of Object.entries(PHIL_STATUS_TONE) as Array<
      [PhilStatusLabel, PhilStatusTone]
    >) {
      const html = render({ label });
      expect(html, label).toContain(label);
      expect(html, label).toContain(TONE_PILL[tone]);
      expect(html, label).toContain(`bg-state-${tone}-dot`);
      expect(html, label).toContain(`border-state-${tone}-subtle-border`);
      expect(html, label).toContain(`text-state-${tone}-subtle-text`);
    }
  });

  it("pins the five-tone vocabulary from the design prompt", () => {
    expect(PHIL_STATUS_TONE["Not started"]).toBe("neutral");
    expect(PHIL_STATUS_TONE["In progress"]).toBe("info");
    expect(PHIL_STATUS_TONE.Submitted).toBe("info");
    expect(PHIL_STATUS_TONE.Syncing).toBe("info");
    expect(PHIL_STATUS_TONE["Needs photo"]).toBe("warning");
    expect(PHIL_STATUS_TONE["In review"]).toBe("warning");
    expect(PHIL_STATUS_TONE.Offline).toBe("warning");
    expect(PHIL_STATUS_TONE.Blocked).toBe("danger");
    expect(PHIL_STATUS_TONE.Rejected).toBe("danger");
    expect(PHIL_STATUS_TONE.Failed).toBe("danger");
    expect(PHIL_STATUS_TONE.Done).toBe("success");
    expect(PHIL_STATUS_TONE.Approved).toBe("success");
    expect(PHIL_STATUS_TONE.Saved).toBe("success");
  });

  it("lets a domain word reuse a tone with an explicit tone prop", () => {
    const html = render({ label: "Check owed", tone: "warning" });
    expect(html).toContain("Check owed");
    expect(html).toContain("bg-state-warning-subtle-bg");
    expect(html).toContain("bg-state-warning-dot");
  });

  it("holds the 12px legibility floor and the badge type voice (no 11px prototype size)", () => {
    const html = render({ label: "Done" });
    expect(html).toContain("text-[12px]");
    expect(html).not.toContain("text-[11px]");
    expect(html).toContain("uppercase");
    expect(html).toContain("font-display");
    expect(html).toContain("tracking-[0.03em]");
  });

  it("uses only token classes — no raw palette or hardcoded hex", () => {
    const html = render({ label: "Blocked" });
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(html).not.toContain("bg-rose-");
    expect(html).not.toContain("bg-amber-");
    expect(html).not.toContain("bg-emerald-");
  });
});
