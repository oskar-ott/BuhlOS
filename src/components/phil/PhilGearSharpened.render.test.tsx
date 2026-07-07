import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

import { PhilGearSharpened } from "./PhilGearSharpened";
import type { GearAsset } from "@/domains/gear/types";

/**
 * SSR smoke for the sharpened /phil/gear (Wave 2c). Static guards:
 *   - "Needs sorting" holds only REAL urgent items (incoming handovers,
 *     expired/near-due calibrations, overdue returns);
 *   - "Your gear" / "On loan" partition on the register's real ownership;
 *   - every existing capability (return / got-it / hand-over / damaged /
 *     missing / history) keeps its surface and testids;
 *   - "Scan a tag" does NOT render (no scan path exists — honest absence).
 */

const ME = "u_me";

function futureDate(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function asset(over: Partial<GearAsset> & Pick<GearAsset, "id" | "name">): GearAsset {
  return {
    type: "tool",
    currentHolderId: ME,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  } as GearAsset;
}

function render(assets: GearAsset[]) {
  return renderToString(
    createElement(PhilGearSharpened, { initialAssets: assets, viewerId: ME }),
  );
}

describe("PhilGearSharpened — needs sorting (real urgency only)", () => {
  it("expired calibration + overdue return + incoming handover, with the real count", () => {
    const html = render([
      asset({ id: "a1", name: "Angle grinder", identifier: "#A-0412", calibrationDue: "2020-06-02" }),
      asset({ id: "a2", name: "Extension lead 15m", identifier: "#A-0155", expectedReturn: "2020-01-01" }),
      asset({
        id: "a3",
        name: "Fluke 1587",
        currentHolderId: "u_other",
        pendingTransfer: { toUserId: ME, fromUserName: "Sam" },
      }),
    ]);
    expect(html).toContain("Needs sorting · 3");
    expect(html).toContain("phil-gear-needs-sorting");
    expect(html).toContain("Expired");
    expect(html).toContain("Calibration expired");
    expect(html).toContain("Overdue");
    expect(html).toContain("Was due back");
    // Incoming handover keeps its accept/decline capability + testids.
    expect(html).toContain("wants to hand you");
    expect(html).toContain("handover-accept");
    expect(html).toContain("handover-decline");
  });

  it("a near-due calibration reads Due soon (warning), not Expired", () => {
    const html = render([
      asset({ id: "a1", name: "MFT", identifier: "#A-0208", calibrationDue: futureDate(9) }),
    ]);
    expect(html).toContain("Needs sorting · 1");
    expect(html).toContain("Due soon");
    expect(html).not.toContain(">Expired<");
  });

  it("no urgent items → the section is honestly absent", () => {
    const html = render([asset({ id: "a1", name: "Impact driver" })]);
    expect(html).not.toContain("Needs sorting");
  });
});

describe("PhilGearSharpened — your gear / on loan", () => {
  it("partitions hired gear into On loan with its real supplier + hire end", () => {
    const html = render([
      asset({ id: "a1", name: "Impact driver", identifier: "#A-0311" }),
      asset({
        id: "a2",
        name: "Site laser level",
        ownership: "hired",
        hireSupplier: "FDC store",
        hireEndDate: futureDate(3),
      }),
    ]);
    expect(html).toContain("Your gear · 1");
    expect(html).toContain("On loan");
    expect(html).toContain("From FDC store");
    expect(html).toContain("Hire ends");
    // The ref chip renders the real identifier only.
    expect(html).toContain("#A-0311");
  });

  it("keeps every existing capability reachable (return / got it / hand over / damaged / missing / history)", () => {
    const html = render([
      asset({ id: "a1", name: "Impact driver", assignedAt: "2026-06-01T00:00:00Z" }),
    ]);
    expect(html).toContain("Return");
    expect(html).toContain("Got it");
    expect(html).toContain("Hand over");
    expect(html).toContain("handover-open");
    expect(html).toContain("Damaged");
    expect(html).toContain("Missing");
    expect(html).toContain("asset-history-toggle");
    // Honest state line: only the real held-since fact.
    expect(html).toContain("Held since");
  });

  it("never renders a scan affordance or a fabricated test/tag date", () => {
    const html = render([asset({ id: "a1", name: "Impact driver" })]);
    expect(html).not.toContain("Scan a tag");
    expect(html).not.toContain("Tagged ·");
  });
});
