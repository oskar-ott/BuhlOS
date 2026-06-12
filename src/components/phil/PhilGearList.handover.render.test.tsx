import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilGearList } from "./PhilGearList";
import type { GearAsset } from "@/domains/gear/types";

/**
 * #306 static guards: incoming handovers render as accept/decline prompts
 * with the responsibility promise; outgoing pendings show on held gear;
 * the handshake states never leak into the wrong section.
 */

const ME = "u_me";

const incoming = {
  id: "a_in",
  name: "Fluke 1587",
  type: "tool",
  currentHolderId: "u_other",
  pendingTransfer: { toUserId: ME, fromUserName: "Sam", note: "smoko handover" },
} as unknown as GearAsset;

const heldPending = {
  id: "a_out",
  name: "Makita drill",
  type: "tool",
  currentHolderId: ME,
  pendingTransfer: { toUserId: "u_other", toUserName: "Alex" },
} as unknown as GearAsset;

describe("PhilGearList handshake states (#306)", () => {
  it("incoming handover: accept/decline prompt + responsibility promise", () => {
    const html = renderToString(
      createElement(PhilGearList, { initialAssets: [incoming], viewerId: ME }),
    );
    expect(html).toContain("wants to hand you");
    expect(html).toContain("Fluke 1587");
    expect(html).toContain("not responsible for it until you accept");
    expect(html).toContain("handover-accept");
    expect(html).toContain("handover-decline");
    // it is NOT rendered as held gear (no Return/Hand over actions for it)
    expect(html).not.toContain("Hand over");
  });

  it("held gear with an outgoing pending shows the waiting state and blocks re-proposing", () => {
    const html = renderToString(
      createElement(PhilGearList, { initialAssets: [heldPending], viewerId: ME }),
    );
    expect(html).toContain("Waiting for");
    expect(html).toContain("Alex");
    expect(html).toContain("to accept this");
    expect(html).toMatch(/disabled=""[^>]*data-testid="handover-open"|data-testid="handover-open"[^>]*disabled=""/);
    expect(html).toContain("asset-history-toggle");
  });
});
