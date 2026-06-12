import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AssetEditorSheet } from "./AssetEditorSheet";
import type { GearAsset, GearHolderUser } from "@/domains/gear/types";

/**
 * Static guards for the asset editor (#389) — the modern replacement for
 * the cutover-deleted legacy form. Live POST/PUT behaviour is pinned by the
 * assets API harness (incl. #394's create-persists-hire-fields cases).
 */

const holders: GearHolderUser[] = [{ id: "u1", username: "sparky", role: "tradie" }];
const noop = () => undefined;

describe("AssetEditorSheet", () => {
  it("create mode: core fields + create-and-assign picker, save disabled without a name", () => {
    const html = renderToString(
      createElement(AssetEditorSheet, {
        mode: "create",
        holders,
        onClose: noop,
        onSaved: noop,
      }),
    );
    expect(html).toContain("Add an asset");
    expect(html).toContain("Identifier / serial");
    expect(html).toContain("Assign to (optional)");
    expect(html).toContain("sparky");
    expect(html).toMatch(/disabled=""[^>]*data-testid="asset-editor-save"/);
  });

  it("edit mode: prefilled, hired fields visible for a hired asset, NO holder picker", () => {
    const asset = {
      id: "a1",
      name: "Genie lift",
      type: "other",
      ownership: "hired",
      hireEndDate: "2026-07-31",
      hireRateExGst: 180.5,
      hireSupplier: "Coates Hire",
    } as unknown as GearAsset;
    const html = renderToString(
      createElement(AssetEditorSheet, {
        mode: "edit",
        asset,
        holders,
        onClose: noop,
        onSaved: noop,
      }),
    );
    expect(html).toContain("Edit Genie lift");
    expect(html).toContain("Coates Hire");
    expect(html).toContain("Hire end date");
    expect(html).not.toContain("Assign to (optional)");
    expect(html).toContain("Holder changes happen via Transfer");
  });

  it("an owned asset hides the hire fields", () => {
    const asset = { id: "a2", name: "Drill", type: "tool", ownership: "owned" } as unknown as GearAsset;
    const html = renderToString(
      createElement(AssetEditorSheet, { mode: "edit", asset, holders, onClose: noop, onSaved: noop }),
    );
    expect(html).not.toContain("Hire end date");
  });
});
