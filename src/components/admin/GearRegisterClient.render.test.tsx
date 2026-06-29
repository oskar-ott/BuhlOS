import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AssetDrawer, GearRegisterClient } from "./GearRegisterClient";
import type { GearAsset, GearHolderUser } from "@/domains/gear/types";

// GearRegisterClient calls useRouter; stub it for the SSR smoke.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

/**
 * SSR render test for the Gear holder picker (node env). The transfer <select>
 * in AssetDrawer is the assignment surface; this pins that it lists exactly the
 * normalised assignable holders (field-tier + leading hands) the page hands it,
 * marks leading hands by their NORMALISED role (not a literal 'leadingHand'),
 * always offers "Return to depot", and excludes the asset's current holder.
 *
 * The useEffect history fetch never runs under renderToString, so history shows
 * its "Loading…" state and no network is touched.
 */

const HOLDERS: GearHolderUser[] = [
  { id: "u_field", username: "sparky", role: "electrician" },
  { id: "u_tradie", username: "chippy", role: "tradie" },
  { id: "u_lh", username: "lead", role: "lh" }, // canonical LH alias, NOT "leadingHand"
];

function assetFixture(overrides: Partial<GearAsset> = {}): GearAsset {
  return {
    id: "a1",
    name: "Hilti drill",
    type: "tool",
    currentHolderId: null,
    archived: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as GearAsset;
}

function render(asset: GearAsset, holders: GearHolderUser[]): string {
  return renderToString(
    createElement(AssetDrawer, {
      asset,
      holders,
      onClose: () => {},
      onEdit: () => {},
      onArchive: () => {},
      onMutate: () => {},
      isPending: false,
    }),
  );
}

/** React SSR inserts <!-- --> between adjacent text children; drop them so a
 *  username + " (LH)" suffix reads as one string. */
function text(html: string): string {
  return html.replace(/<!--\s*-->/g, "");
}

function optionCount(html: string): number {
  return (html.match(/<option/g) ?? []).length;
}

describe("Gear holder picker (AssetDrawer transfer <select>)", () => {
  it("lists every assignable holder the page provides + a return-to-depot option", () => {
    const html = render(assetFixture(), HOLDERS);
    expect(html).toContain("Return to depot");
    expect(html).toContain("sparky");
    expect(html).toContain("chippy");
    expect(html).toContain("lead");
    // one <option> per holder + the depot option
    expect(optionCount(html)).toBe(HOLDERS.length + 1);
  });

  it("marks a leading hand by NORMALISED role, not a literal 'leadingHand'", () => {
    const html = text(render(assetFixture(), HOLDERS));
    expect(html).toContain("lead (LH)");
    // exactly one holder is flagged LH; field-tier holders get no suffix
    expect((html.match(/\(LH\)/g) ?? []).length).toBe(1);
    expect(html).not.toContain("sparky (LH)");
    expect(html).not.toContain("chippy (LH)");
  });

  it("excludes the asset's CURRENT holder from the eligible list", () => {
    const html = render(
      assetFixture({ currentHolderId: "u_field", currentHolderName: "sparky" }),
      HOLDERS,
    );
    // u_field is the current holder → dropped from options; 2 holders + depot.
    expect(optionCount(html)).toBe(HOLDERS.length);
    expect(html).toContain("chippy");
    expect(html).toContain("lead");
  });

  it("hides the transfer picker entirely for an archived asset (no <select>)", () => {
    const html = render(assetFixture({ archived: true }), HOLDERS);
    expect(html).not.toContain("Return to depot");
    expect(optionCount(html)).toBe(0);
  });
});

describe("Gear register status-contextual row action (§7B)", () => {
  function renderTable(assets: GearAsset[]): string {
    return renderToString(
      createElement(GearRegisterClient, { initialAssets: assets, holders: HOLDERS }),
    );
  }

  it("offers 'Mark good' on a damaged asset and 'Mark found' on a missing one", () => {
    const html = renderTable([
      assetFixture({ id: "g_dmg", name: "Cracked tester", condition: "damaged" }),
      assetFixture({ id: "g_lost", name: "Lost ladder", condition: "missing" }),
    ]);
    expect(html).toContain('data-testid="gear-row-action-g_dmg"');
    expect(html).toContain("Mark good");
    expect(html).toContain('data-testid="gear-row-action-g_lost"');
    expect(html).toContain("Mark found");
  });

  it("offers 'Book test' when a test instrument's calibration has lapsed", () => {
    // calibrationDue well in the past → calibrationFlag === 'expired' regardless
    // of the day the component computes internally.
    const html = renderTable([
      assetFixture({ id: "g_cal", name: "Megger", type: "tool", calibrationDue: "2000-01-01" }),
    ]);
    expect(html).toContain('data-testid="gear-row-action-g_cal"');
    expect(html).toContain("Book test");
    expect(html).toContain("Calibration due");
  });

  it("shows ONLY the Manage fallback for a healthy asset (no contextual action)", () => {
    const html = renderTable([assetFixture({ id: "g_ok", name: "Good drill", condition: "good" })]);
    expect(html).not.toContain('data-testid="gear-row-action-g_ok"');
    expect(html).toContain("Manage");
  });

  it("renders an inline note from asset.notes when present", () => {
    const html = renderTable([
      assetFixture({ id: "g_note", name: "Drill", notes: "chuck sticks intermittently" }),
    ]);
    expect(html).toContain("chuck sticks intermittently");
  });
});
