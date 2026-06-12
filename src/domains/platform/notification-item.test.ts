import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_PREF_KEYS,
  NOTIFICATION_ITEM_KINDS,
  isUnread,
  unreadCount,
  type NotificationItem,
} from "./notification-item";

/**
 * The `NotificationItem` contract (#218) + the drift guard that keeps THREE
 * lists 1:1 (issue #218 AC: kinds aligned with pref keys):
 *   - the TS pref-key list (this file's surface, used by the panel + bell),
 *   - the CJS router's PREF_KEYS (api/_lib/notify-routing.js — the runtime),
 *   - the prefs endpoint's VALID_KEYS (api/notification-prefs.js — the store).
 * If any of the three drifts, this test fails before a sender kind can ship
 * without a pref toggle (or vice versa).
 */
const requireFromHere = createRequire(import.meta.url);

function extractValidKeys(): string[] {
  // api/notification-prefs.js builds `const VALID_KEYS = new Set([ ... ])`. The
  // file imports api/_lib/blob (Vercel-only) at module load, so parse the
  // source rather than require it.
  const fs = requireFromHere("node:fs") as typeof import("fs");
  const path = requireFromHere.resolve("../../../api/notification-prefs.js");
  const src = fs.readFileSync(path, "utf8");
  const block = src.slice(src.indexOf("VALID_KEYS"));
  const arr = block.slice(block.indexOf("["), block.indexOf("]") + 1);
  return (arr.match(/'([^']+)'/g) || []).map((s) => s.replace(/'/g, ""));
}

const routing = requireFromHere("../../../api/_lib/notify-routing.js") as { PREF_KEYS: string[] };
const engine = requireFromHere("../../../api/_lib/notify.js") as { REGISTRY: Record<string, { prefKey: string | null }> };

describe("NotificationItem contract — kinds ↔ pref keys 1:1 (#218)", () => {
  it("the TS pref-key list matches the prefs endpoint VALID_KEYS", () => {
    expect([...NOTIFICATION_PREF_KEYS].sort()).toEqual(extractValidKeys().sort());
  });

  it("the TS pref-key list matches the CJS router PREF_KEYS", () => {
    expect([...NOTIFICATION_PREF_KEYS].sort()).toEqual([...routing.PREF_KEYS].sort());
  });

  it("the engine registry declares exactly the six pref-backed kinds", () => {
    expect(Object.keys(engine.REGISTRY).sort()).toEqual([...NOTIFICATION_PREF_KEYS].sort());
  });

  it("every registry event's prefKey is one of the six keys (no orphan gate)", () => {
    for (const def of Object.values(engine.REGISTRY)) {
      expect(NOTIFICATION_PREF_KEYS).toContain(def.prefKey);
    }
  });

  it("NotificationItem kinds are the same six (additive-open union, pref-backed today)", () => {
    expect([...NOTIFICATION_ITEM_KINDS].sort()).toEqual([...NOTIFICATION_PREF_KEYS].sort());
  });
});

describe("unread helpers (the bell badge)", () => {
  const base: NotificationItem = {
    id: "n1",
    kind: "hoursApproved",
    title: "Hours approved",
    occurredAt: "2026-06-12T01:00:00.000Z",
  };

  it("a row with no readAt is unread; with a readAt it is read", () => {
    expect(isUnread(base)).toBe(true);
    expect(isUnread({ ...base, readAt: null })).toBe(true);
    expect(isUnread({ ...base, readAt: "2026-06-12T02:00:00.000Z" })).toBe(false);
  });

  it("unreadCount counts only unread rows", () => {
    const items: NotificationItem[] = [
      base,
      { ...base, id: "n2", readAt: "2026-06-12T02:00:00.000Z" },
      { ...base, id: "n3" },
    ];
    expect(unreadCount(items)).toBe(2);
    expect(unreadCount([])).toBe(0);
  });
});
