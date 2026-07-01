import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { OwnerFeatureBoard } from "./OwnerFeatureBoard";
import type { FlagItem } from "@/domains/platform/owner-console";

/**
 * #760 — the Owner Feature Control Board groups features by domain, renders the
 * two-dial toggles for product flags, and fences protected data-plane flags in a
 * read-only "System" group. Props-only SSR render (no router).
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
    ...over,
  } as FlagItem;
}

describe("<OwnerFeatureBoard />", () => {
  it("groups by domain, renders toggles + labels, and fences protected flags in a read-only System group", () => {
    const items: FlagItem[] = [
      mkFlag({
        key: "itp",
        label: "ITPs",
        domain: "QA & compliance",
        surface: "Shared",
        resolved: true,
        resolvedForOwner: true,
        killSwitch: true,
      }),
      mkFlag({ key: "rfi_register", label: "RFIs", domain: "QA & compliance", surface: "Shared" }),
      mkFlag({ key: "supabase_dual_write", protected: true, toggleable: false }),
    ];
    const html = renderToString(createElement(OwnerFeatureBoard, { items, rev: 3 }));

    // Domain group heading (React escapes &) + human labels.
    expect(html).toContain("QA &amp; compliance");
    expect(html).toContain("ITPs");
    expect(html).toContain("RFIs");
    // Interactive two-dial toggles for the non-protected features.
    expect(html).toContain("flag-customer-itp");
    expect(html).toContain("flag-preview-rfi_register");
    // Exposure filter row.
    expect(html).toContain("Preview only");
    // Protected data-plane flag lives in the read-only System group — no toggle.
    expect(html).toContain("System · data-plane");
    expect(html).not.toContain("flag-customer-supabase_dual_write");
  });

  it("empty (no flags) renders without crashing", () => {
    const html = renderToString(createElement(OwnerFeatureBoard, { items: [], rev: undefined }));
    expect(html).toContain("owner-feature-board");
  });
});
