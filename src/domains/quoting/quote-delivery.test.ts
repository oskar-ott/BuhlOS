import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * #240 — quote client-delivery lifecycle. Pure: never_sent → sent → viewed →
 * accepted/declined; viewed never inferred; accept/decline (status) outranks.
 */
const requireFromHere = createRequire(import.meta.url);
const qd = requireFromHere("../../../api/_lib/quote-delivery.js") as {
  deriveDeliveryState: (q: Record<string, unknown>) => { state: string; lastSentAt: string | null; recipient: string | null; since: string | null };
  isAwaitingClient: (q: Record<string, unknown>) => boolean;
  validateSent: (b: Record<string, unknown>) => { ok: boolean; value?: Record<string, unknown>; error?: string };
  appendSent: (q: Record<string, unknown>, v: Record<string, unknown>, a: Record<string, unknown>) => { sentEvents: unknown[] };
  appendViewed: (q: Record<string, unknown>, v: Record<string, unknown>, a: Record<string, unknown>) => { viewedEvents: unknown[] };
};

const ACTOR = { username: "Daniel" };

describe("deriveDeliveryState", () => {
  it("is never_sent with no delivery + draft status", () => {
    expect(qd.deriveDeliveryState({ status: "draft" }).state).toBe("never_sent");
  });
  it("is sent after a sent event, viewed after a viewed event", () => {
    const sent = { status: "submitted", delivery: { sentEvents: [{ at: "2026-06-01", recipient: "client@x", method: "email" }] } };
    const s = qd.deriveDeliveryState(sent);
    expect(s.state).toBe("sent");
    expect(s.recipient).toBe("client@x");
    expect(s.lastSentAt).toBe("2026-06-01");
    const viewed = { ...sent, delivery: { ...sent.delivery, viewedEvents: [{ at: "2026-06-02" }] } };
    expect(qd.deriveDeliveryState(viewed).state).toBe("viewed");
  });
  it("accepted/declined status outranks delivery events", () => {
    const base = { delivery: { sentEvents: [{ at: "2026-06-01", recipient: "c" }], viewedEvents: [{ at: "2026-06-02" }] } };
    expect(qd.deriveDeliveryState({ ...base, status: "accepted", acceptance: { acceptedAt: "2026-06-03" } }).state).toBe("accepted");
    expect(qd.deriveDeliveryState({ ...base, status: "lost" }).state).toBe("declined");
  });
  it("isAwaitingClient only for sent/viewed, not terminal", () => {
    expect(qd.isAwaitingClient({ status: "submitted", delivery: { sentEvents: [{ at: "2026-06-01", recipient: "c" }] } })).toBe(true);
    expect(qd.isAwaitingClient({ status: "draft" })).toBe(false);
    expect(qd.isAwaitingClient({ status: "accepted" })).toBe(false);
  });
});

describe("validateSent + append", () => {
  it("requires a date + recipient and normalises the method", () => {
    expect(qd.validateSent({ at: "nope", recipient: "c" }).ok).toBe(false);
    expect(qd.validateSent({ at: "2026-06-01" }).ok).toBe(false);
    const r = qd.validateSent({ at: "2026-06-01", recipient: "client@x", method: "weird" });
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({ at: "2026-06-01", recipient: "client@x", method: "email" }); // unknown → email
  });
  it("appendSent / appendViewed grow their event arrays with the actor", () => {
    const d1 = qd.appendSent({}, { at: "2026-06-01", recipient: "c", method: "email" }, ACTOR);
    expect(d1.sentEvents).toHaveLength(1);
    const d2 = qd.appendViewed({ delivery: d1 }, { at: "2026-06-02" }, ACTOR);
    expect(d2.viewedEvents).toHaveLength(1);
  });
});
