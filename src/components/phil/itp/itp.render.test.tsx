import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ItpBadge, ItpPrimaryButton, ItpSegmented } from "./ItpControls";
import { ItpDangerZone } from "./ItpDangerZone";
import { ItpDock } from "./ItpDock";
import { ItpLeaveGuard } from "./ItpLeaveGuard";
import { ItpPendingTile } from "./ItpPhotoTile";
import { PhilItpWalkthrough } from "./PhilItpWalkthrough";

/**
 * SSR smoke for the ITP builder's pieces (handoff 2026-11-02): the exact
 * copy, the real elements (button / role=group / aria-pressed), the words
 * on every tile state, and the walkthrough's first step + Skip.
 */

describe("ITP controls", () => {
  it("segmented control is a labelled group with aria-pressed segments", () => {
    const html = renderToString(createElement(ItpSegmented, { value: "roll", onChange: () => {} }));
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Photos from"');
    expect(html).toContain("Camera roll");
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
  });

  it("primary button is 64px yellow on navy; badges carry words + a dot", () => {
    const html = renderToString(createElement(ItpPrimaryButton, null, "New area"));
    expect(html).toContain("min-h-[64px]");
    expect(html).toContain("bg-accent-yellow");
    expect(html).toContain('type="button"');
    const badge = renderToString(createElement(ItpBadge, { tone: "warning" }, "PDF out of date"));
    expect(badge).toContain("PDF out of date");
    expect(badge).toContain("bg-state-warning-dot");
  });
});

describe("ItpDangerZone", () => {
  const base = {
    label: "Remove area",
    armedLabel: "Tap again to remove Kitchen",
    consequence: "Removes Kitchen and its 3 photos from this ITP.",
    onArm: () => {},
    onConfirm: () => {},
    onKeep: () => {},
  };
  it("at rest: label + consequence, no Keep it", () => {
    const html = renderToString(createElement(ItpDangerZone, { ...base, armed: false }));
    expect(html).toContain("Remove area");
    expect(html).toContain("Removes Kitchen and its 3 photos from this ITP.");
    expect(html).not.toContain("Keep it");
  });
  it("armed: red fill, 'Tap again to…', Keep it", () => {
    const html = renderToString(createElement(ItpDangerZone, { ...base, armed: true }));
    expect(html).toContain("Tap again to remove Kitchen");
    expect(html).toContain("bg-state-danger");
    expect(html).toContain("Keep it");
  });
});

describe("ItpDock + tiles", () => {
  it("dock status is a polite live region with the primary under it", () => {
    const html = renderToString(
      createElement(ItpDock, {
        status: createElement(ItpBadge, { tone: "info" }, "Saving 1 of 3"),
        statusAction: "PDFs · 2",
        primary: createElement(ItpPrimaryButton, null, "New area"),
      })
    );
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Saving 1 of 3");
    expect(html).toContain("PDFs · 2");
    expect(html).toContain("sticky bottom-0");
  });

  it("every pending tile state has words, and only Didn't save gets Retry / Over 8 MB gets Clear", () => {
    const render = (state: "waiting" | "saving" | "failed" | "notSent" | "tooBig") =>
      renderToString(
        createElement(ItpPendingTile, {
          item: { localId: "x", areaId: "a", file: {} as File, previewUrl: "blob:x", state },
          index: 2,
          total: 3,
          areaName: "Kitchen",
          onRetry: () => {},
          onClear: () => {},
        })
      );
    expect(render("waiting")).toContain("Waiting");
    expect(render("saving")).toContain("Saving");
    const failed = render("failed");
    expect(failed).toContain("Didn&#x27;t save");
    expect(failed).toContain("Retry");
    expect(failed).toContain("ring-state-danger");
    const notSent = render("notSent");
    expect(notSent).toContain("Not sent");
    expect(notSent).not.toContain("Retry");
    const big = render("tooBig");
    expect(big).toContain("Over 8 MB · Not added");
    expect(big).toContain("Clear");
    expect(render("saving")).toContain('aria-label="Photo 2 of 3, Kitchen, Saving"');
  });
});

describe("Leave guard + walkthrough", () => {
  it("leave guard is an assertive alertdialog with Stay here first", () => {
    const html = renderToString(
      createElement(ItpLeaveGuard, { open: true, count: 3, onStay: () => {}, onLeave: () => {} })
    );
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("3 photos haven&#x27;t saved");
    expect(html.indexOf("Stay here")).toBeLessThan(html.indexOf("Leave anyway"));
    expect(
      renderToString(
        createElement(ItpLeaveGuard, { open: false, count: 0, onStay: () => {}, onLeave: () => {} })
      )
    ).toBe("");
  });

  it("walkthrough opens on step 1 with Skip, 1 of 4 and a full-width Next", () => {
    const html = renderToString(
      createElement(PhilItpWalkthrough, { open: true, onSkip: () => {}, onDone: () => {} })
    );
    expect(html).toContain("How ITPs work");
    expect(html).toContain("Skip");
    expect(html).toContain("Tap a name, take photos");
    expect(html).toContain("1 of 4");
    expect(html).toContain("Next");
    expect(html).not.toContain(">Back<");
    expect(html).not.toContain("Got it");
  });
});
