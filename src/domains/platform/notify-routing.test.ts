import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Pure routing table for the notify() engine (#162). The router is the CJS
 * module api/_lib/notify-routing.js (CJS so the serverless runtime can require
 * it directly); imported here via createRequire — the same bridge the cron-auth
 * unit test uses.
 *
 * These are the table-driven decisions the engine delegates to: audience +
 * prefs + an event def + email config → who gets which channels. The
 * end-to-end suppression/delivery proof against the real handlers lives in
 * notify-engine-api.test.ts; this file pins the rules in isolation.
 */
type EventDef = {
  kind: string;
  prefKey: string | null;
  alwaysOn?: boolean;
  channels: string[];
};
type NotifyUser = { id: string; notificationPrefs?: Record<string, unknown> };
type Env = { emailConfigured: boolean };
type RouteResult = {
  deliver: Array<{ userId: string; channels: string[] }>;
  skipped: Array<{ userId: string; reason: string }>;
};
interface Routing {
  routeEvent: (event: EventDef, audience: ReadonlyArray<NotifyUser>, env: Env) => RouteResult;
  prefEnabled: (prefs: Record<string, unknown> | null | undefined, key: string) => boolean;
  channelsForUser: (event: EventDef, user: NotifyUser, env: Env) => string[];
  PREF_KEYS: string[];
  CHANNELS: string[];
}

const requireFromHere = createRequire(import.meta.url);
const routing = requireFromHere("../../../api/_lib/notify-routing.js") as Routing;

const { routeEvent, prefEnabled, channelsForUser, PREF_KEYS, CHANNELS } = routing;

const PUSH_PREF: EventDef = { kind: "hoursApproved", prefKey: "hoursApproved", channels: ["push"] };
const ALWAYS_ON: EventDef = { kind: "hoursRejected", prefKey: null, alwaysOn: true, channels: ["push"] };
const EMAIL_ONLY: EventDef = { kind: "future", prefKey: null, channels: ["email"] };
const PUSH_AND_EMAIL: EventDef = { kind: "future2", prefKey: "dailyDigest", channels: ["push", "email"] };

function user(id: string, prefs?: Record<string, unknown>) {
  return prefs === undefined ? { id } : { id, notificationPrefs: prefs };
}

describe("prefEnabled — documented defaults (#162)", () => {
  it("missing object → true (a user who never opened prefs is unchanged)", () => {
    expect(prefEnabled(undefined, "hoursApproved")).toBe(true);
    expect(prefEnabled(null, "hoursApproved")).toBe(true);
  });

  it("missing key → true", () => {
    expect(prefEnabled({ snagAssigned: false }, "hoursApproved")).toBe(true);
  });

  it("explicit false → false; explicit true → true", () => {
    expect(prefEnabled({ hoursApproved: false }, "hoursApproved")).toBe(false);
    expect(prefEnabled({ hoursApproved: true }, "hoursApproved")).toBe(true);
  });

  it("coerces a non-boolean stored value the same way the prefs endpoint does", () => {
    // api/notification-prefs.js stores !!value; a corrupt 0/1 reads consistently.
    expect(prefEnabled({ hoursApproved: 0 as unknown as boolean }, "hoursApproved")).toBe(false);
    expect(prefEnabled({ hoursApproved: 1 as unknown as boolean }, "hoursApproved")).toBe(true);
  });
});

describe("routeEvent — pref gating", () => {
  it("delivers to default-pref and missing-pref users; suppresses only the muted one", () => {
    const audience = [
      user("a", {}), // empty prefs → default true
      user("b", { hoursApproved: false }), // muted
      user("c"), // no prefs object → default true
      user("d", { snagAssigned: false }), // muted a DIFFERENT type → still gets this one
    ];
    const { deliver, skipped } = routeEvent(PUSH_PREF, audience, { emailConfigured: false });
    expect(deliver.map((d) => d.userId)).toEqual(["a", "c", "d"]);
    expect(deliver.every((d) => d.channels.length === 1 && d.channels[0] === "push")).toBe(true);
    expect(skipped).toEqual([{ userId: "b", reason: "muted" }]);
  });

  it("muting is per-user: one muted account never suppresses the rest of the fan-out", () => {
    const audience = [user("keep1", {}), user("muted", { staleSnags: false }), user("keep2", {})];
    const def: EventDef = { kind: "staleSnags", prefKey: "staleSnags", channels: ["push"] };
    const { deliver } = routeEvent(def, audience, { emailConfigured: false });
    expect(deliver.map((d) => d.userId)).toEqual(["keep1", "keep2"]);
  });

  it("alwaysOn events ignore prefs entirely (the rejection / office-inbox class)", () => {
    const audience = [user("a", { hoursApproved: false }), user("b", {})];
    const { deliver, skipped } = routeEvent(ALWAYS_ON, audience, { emailConfigured: false });
    // both delivered despite a's mute — alwaysOn bypasses the gate
    expect(deliver.map((d) => d.userId)).toEqual(["a", "b"]);
    expect(skipped).toHaveLength(0);
  });

  it("skips users without an id and never throws on a sparse audience", () => {
    const audience = [user("a", {}), { } as { id: string }, null as unknown as { id: string }];
    const { deliver } = routeEvent(PUSH_PREF, audience, { emailConfigured: false });
    expect(deliver.map((d) => d.userId)).toEqual(["a"]);
  });
});

describe("routeEvent — channel resolution (email seam, never a fake send)", () => {
  it("v1 push-only event always offers push", () => {
    const { deliver } = routeEvent(PUSH_PREF, [user("a", {})], { emailConfigured: true });
    expect(deliver[0]!.channels).toEqual(["push"]);
  });

  it("an email-declaring event drops the email leg when email is unconfigured → skipped no-channels", () => {
    const { deliver, skipped } = routeEvent(EMAIL_ONLY, [user("a", {})], { emailConfigured: false });
    expect(deliver).toHaveLength(0);
    expect(skipped).toEqual([{ userId: "a", reason: "no-channels" }]);
  });

  it("an email-declaring event keeps email when configured", () => {
    const { deliver } = routeEvent(EMAIL_ONLY, [user("a", {})], { emailConfigured: true });
    expect(deliver[0]!.channels).toEqual(["email"]);
  });

  it("push+email event keeps push but adds email only when configured", () => {
    const off = routeEvent(PUSH_AND_EMAIL, [user("a", {})], { emailConfigured: false });
    expect(off.deliver[0]!.channels).toEqual(["push"]);
    const on = routeEvent(PUSH_AND_EMAIL, [user("a", {})], { emailConfigured: true });
    expect(on.deliver[0]!.channels).toEqual(["push", "email"]);
  });

  it("channelsForUser mirrors routeEvent's per-user decision", () => {
    expect(channelsForUser(PUSH_PREF, user("a", { hoursApproved: false }), { emailConfigured: true })).toEqual([]);
    expect(channelsForUser(PUSH_PREF, user("a", {}), { emailConfigured: true })).toEqual(["push"]);
  });
});

describe("routing constants are the canonical lists", () => {
  it("PREF_KEYS is exactly the six documented keys", () => {
    expect([...PREF_KEYS].sort()).toEqual(
      ["dailyDigest", "dailyHoursReminder", "hoursApproved", "snagAssigned", "staleSnags", "tagReminders"].sort(),
    );
  });
  it("CHANNELS lists push then the email seam", () => {
    expect(CHANNELS).toEqual(["push", "email"]);
  });
});
