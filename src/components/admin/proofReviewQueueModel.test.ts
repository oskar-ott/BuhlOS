import { describe, expect, it } from "vitest";
import { proofActionMessage, proofActionShouldRefresh } from "./proofReviewQueueModel";

describe("proofActionMessage (#503 office sign-off result mapping)", () => {
  it("returns null on ok (the row is removed, no error shown)", () => {
    expect(proofActionMessage("ok", "approve")).toBeNull();
  });

  it("shows the INDEPENDENCE message on unauthorized (self-review → can't sign off your own)", () => {
    // The engine returns reason 'self_review' (409) which the client maps to
    // 'unauthorized'; this is the surface's honesty promise.
    expect(proofActionMessage("unauthorized", "approve")).toContain(
      "can’t sign off proof you captured",
    );
  });

  it("tells the user it is refreshing on a stale conflict", () => {
    expect(proofActionMessage("stale", "approve")).toContain("changed since you loaded it");
  });

  it("does not claim it was already actioned for a generic error", () => {
    expect(proofActionMessage("error", "send back")).toBe("Couldn’t send back — try again.");
    expect(proofActionMessage("invalid", "approve")).toContain("actioned already");
  });

  it("only refreshes on a stale result", () => {
    expect(proofActionShouldRefresh("stale")).toBe(true);
    for (const k of ["ok", "unauthorized", "invalid", "error", "incomplete"] as const) {
      expect(proofActionShouldRefresh(k)).toBe(false);
    }
  });
});
