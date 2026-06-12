import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_PREF_META,
  NotificationPrefsSchema,
  applyServerEcho,
  defaultPrefs,
  optimisticToggle,
  parsePrefsResponse,
  rollback,
} from "./notification-prefs";
import { NOTIFICATION_PREF_KEYS } from "./notification-item";

/**
 * Client-side prefs contract (#218). The server treats a missing key as `true`;
 * the client MUST apply the same default or the panel shows "off" for a pref
 * the server treats as on. These tests pin that defaults-merge end to end.
 */

describe("NotificationPrefsSchema — missing keys default true", () => {
  it("an empty object resolves every key to true", () => {
    const parsed = NotificationPrefsSchema.parse({});
    for (const k of NOTIFICATION_PREF_KEYS) expect(parsed[k]).toBe(true);
  });

  it("a partial object keeps explicit falses and defaults the rest to true", () => {
    const parsed = NotificationPrefsSchema.parse({ hoursApproved: false });
    expect(parsed.hoursApproved).toBe(false);
    expect(parsed.dailyDigest).toBe(true);
    expect(parsed.snagAssigned).toBe(true);
  });

  it("strips unknown keys (the server constrains writes via VALID_KEYS)", () => {
    const parsed = NotificationPrefsSchema.parse({
      hoursApproved: true,
      somethingElse: false,
    }) as Record<string, unknown>;
    expect("somethingElse" in parsed).toBe(false);
  });
});

describe("parsePrefsResponse — tolerant envelope handling", () => {
  it("parses the server's { prefs, role } envelope", () => {
    const out = parsePrefsResponse({
      prefs: { hoursApproved: false, dailyDigest: true },
      role: "admin",
    });
    expect(out).not.toBeNull();
    expect(out!.hoursApproved).toBe(false);
    expect(out!.dailyDigest).toBe(true);
    expect(out!.tagReminders).toBe(true); // defaulted
  });

  it("an absent prefs object defaults everything to true (the common case)", () => {
    const out = parsePrefsResponse({ role: "office" });
    expect(out).not.toBeNull();
    for (const k of NOTIFICATION_PREF_KEYS) expect(out![k]).toBe(true);
  });

  it("a bare prefs map (no envelope) is still accepted", () => {
    const out = parsePrefsResponse({ hoursApproved: false });
    expect(out).not.toBeNull();
    expect(out!.hoursApproved).toBe(false);
  });

  it("returns null for an unusable payload (so the caller can show an error)", () => {
    expect(parsePrefsResponse({ prefs: { hoursApproved: "nope" } })).toBeNull();
  });
});

describe("metadata + defaults", () => {
  it("there is exactly one labelled meta row per pref key, no bare keys", () => {
    expect(NOTIFICATION_PREF_META.map((m) => m.key).sort()).toEqual(
      [...NOTIFICATION_PREF_KEYS].sort(),
    );
    for (const m of NOTIFICATION_PREF_META) {
      expect(m.label.length).toBeGreaterThan(0);
      // Description must name WHO receives it (AC: no bare key names) — every
      // description ends with a "Sent to …" recipient clause.
      expect(m.description.length).toBeGreaterThan(20);
      expect(m.description).toMatch(/Sent to /);
      expect(m.label).not.toBe(m.key);
    }
  });

  it("defaultPrefs is all-true", () => {
    const d = defaultPrefs();
    for (const k of NOTIFICATION_PREF_KEYS) expect(d[k]).toBe(true);
  });
});

describe("toggle state machine — optimistic flip + rollback (the panel core)", () => {
  it("optimisticToggle flips one key and leaves the rest untouched", () => {
    const before = defaultPrefs();
    const after = optimisticToggle(before, "hoursApproved");
    expect(after.hoursApproved).toBe(false);
    expect(after.dailyDigest).toBe(true);
    expect(before.hoursApproved).toBe(true); // immutable
    // flipping again returns to true
    expect(optimisticToggle(after, "hoursApproved").hoursApproved).toBe(true);
  });

  it("rollback restores the previous value of one key after a failed PUT", () => {
    const flipped = optimisticToggle(defaultPrefs(), "dailyDigest"); // now false
    expect(flipped.dailyDigest).toBe(false);
    const restored = rollback(flipped, "dailyDigest", true);
    expect(restored.dailyDigest).toBe(true);
    expect(restored.hoursApproved).toBe(true);
  });

  it("applyServerEcho trusts the server object on success, keeps local on null", () => {
    const local = defaultPrefs();
    const server = { ...local, staleSnags: false };
    expect(applyServerEcho(local, server).staleSnags).toBe(false);
    expect(applyServerEcho(local, null)).toBe(local);
  });
});
