import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { OwnerFeatureBoard } from "./OwnerFeatureBoard";
import type { FlagItem } from "@/domains/platform/owner-console";

/**
 * #760 — the Owner Feature Control Board groups features by domain, renders the
 * EASY staged-rollout control (Off · Preview · Live) per feature, an "Open to
 * test" link when a feature is reachable for the owner, and fences protected
 * data-plane flags in a read-only "System" group. Props-only SSR render.
 */

function mkFlag(over: Partial<FlagItem> & { key: string }): FlagItem {
  return {
    description: `${over.key} description`,
    default: false,
    target: "global",
    expires: "2026-12-31",
    resolved: false,
    resolvedForOwner: false,
    ownerPreview: null,
    source: "default",
    ownerSource: "default",
    expiryStatus: "ok",
    protected: false,
    toggleable: true,
    label: null,
    domain: null,
    surface: null,
    killSwitch: false,
    core: false,
    previewHref: null,
    ...over,
  } as FlagItem;
}

describe("<OwnerFeatureBoard />", () => {
  it("groups by domain, renders the staged Off/Preview/Live control + Open-to-test, fences protected flags", () => {
    const items: FlagItem[] = [
      mkFlag({
        key: "itp",
        label: "ITPs",
        domain: "QA & compliance",
        surface: "Shared",
        resolved: true, // live
        resolvedForOwner: true,
        killSwitch: true,
        previewHref: "/itp-templates",
      }),
      mkFlag({
        key: "rfi_register",
        label: "RFIs",
        domain: "QA & compliance",
        surface: "Shared",
        resolved: false, // preview only
        resolvedForOwner: true,
        ownerPreview: true,
        previewHref: "/v2/jobs",
      }),
      mkFlag({ key: "supabase_dual_write", protected: true, toggleable: false }),
    ];
    const html = renderToString(createElement(OwnerFeatureBoard, { items, rev: 3 }));

    // Domain group heading (React escapes &) + human labels.
    expect(html).toContain("QA &amp; compliance");
    expect(html).toContain("ITPs");
    expect(html).toContain("RFIs");
    // The three-stage control exists for each product feature.
    for (const t of ["rollout-off-itp", "rollout-preview-itp", "rollout-live-itp"]) {
      expect(html).toContain(t);
    }
    // The switch itself carries the state: the current stop is pressed.
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="rollout-live-itp"/);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="rollout-preview-rfi_register"/);
    // Where it shows up, in site language — never the internal field-app name.
    expect(html).toContain("office + field app");
    // Open-to-test link for the previewed feature (reachable for the owner).
    expect(html).toContain("feature-open-rfi_register");
    expect(html).toContain("Open to test");
    // Protected data-plane flag lives in the read-only System group — no control.
    expect(html).toContain("System · data-plane");
    expect(html).not.toContain("rollout-live-supabase_dual_write");
  });

  it("empty (no flags) renders without crashing", () => {
    const html = renderToString(createElement(OwnerFeatureBoard, { items: [], rev: undefined }));
    expect(html).toContain("owner-feature-board");
  });
});
