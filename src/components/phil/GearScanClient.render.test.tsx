import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { GearScanClient } from "./GearScanClient";
import type { ScanInfoResponse } from "@/domains/gear/types";

/**
 * #303 scan landing state matrix. The scanned tool must show the ONE right
 * action for its state — and never crash or blank. These SSR renders pin each
 * of the states the audit named.
 */

const ME = "u_me";
type ScanAsset = ScanInfoResponse["asset"];

function asset(over: Partial<ScanAsset>): ScanAsset {
  return {
    id: "a_1",
    name: "Makita drill",
    type: "tool",
    identifier: "TOOL-014",
    status: "available",
    archived: false,
    condition: "good",
    currentHolderId: null,
    currentHolderName: null,
    heldByMe: false,
    pendingTransfer: null,
    ...over,
  };
}

function render(props: Parameters<typeof GearScanClient>[0]) {
  return renderToString(createElement(GearScanClient, props));
}

describe("GearScanClient — scan landing state matrix (#303)", () => {
  it("in-storage + assignable role → the one Claim action", () => {
    const html = render({ asset: asset({}), canClaim: true, viewerId: ME });
    expect(html).toContain("Makita drill");
    expect(html).toContain("TOOL-014");
    expect(html).toContain("scan-claim");
    expect(html).toContain("Claim this tool");
    // Not the held or other-holder actions.
    expect(html).not.toContain("scan-return");
    expect(html).not.toContain("scan-request-transfer");
  });

  it("in-storage + NON-assignable (admin/client) → honest read-only note, no claim", () => {
    const html = render({ asset: asset({}), canClaim: false, viewerId: ME });
    expect(html).not.toContain("scan-claim");
    expect(html).toContain("read-only");
  });

  it("held-by-me → return + report actions (the existing set)", () => {
    const html = render({
      asset: asset({ status: "assigned", currentHolderId: ME, heldByMe: true }),
      canClaim: true,
      viewerId: ME,
    });
    expect(html).toContain("scan-return");
    expect(html).toContain("scan-check");
    expect(html).toContain("scan-damaged");
    expect(html).toContain("scan-missing");
    expect(html).toContain("Held by");
    expect(html).toContain("You");
    expect(html).not.toContain("scan-claim");
  });

  it("held-by-other → honest 'held by <name>' + Request transfer (#306)", () => {
    const html = render({
      asset: asset({
        status: "assigned",
        currentHolderId: "u_sam",
        currentHolderName: "Sam D.",
        heldByMe: false,
      }),
      canClaim: true,
      viewerId: ME,
    });
    expect(html).toContain("Sam D.");
    expect(html).toContain("holding this");
    expect(html).toContain("scan-request-transfer");
    expect(html).not.toContain("scan-claim");
  });

  it("held-by-other with a pending handover → shows the waiting state, no new request", () => {
    const html = render({
      asset: asset({
        status: "assigned",
        currentHolderId: "u_sam",
        currentHolderName: "Sam D.",
        heldByMe: false,
        pendingTransfer: { toUserId: "u_jo", toUserName: "Jo" },
      }),
      canClaim: true,
      viewerId: ME,
    });
    expect(html).toContain("already waiting on");
    expect(html).not.toContain("scan-request-transfer");
  });

  it("retired → honest 'no longer in service', no actions", () => {
    const html = render({
      asset: asset({ status: "retired", archived: true }),
      canClaim: true,
      viewerId: ME,
    });
    expect(html).toContain("No longer in service");
    expect(html).not.toContain("scan-claim");
    expect(html).not.toContain("scan-return");
  });
});
