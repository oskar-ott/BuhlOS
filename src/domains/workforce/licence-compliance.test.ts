import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Unit contract for api/_lib/licence-compliance.js (#331) — the ONE engine
 * behind register chips, the drawer, Phil self-view and the alert cron.
 * Pure module, no mocks. Boundary days, renewal collapse, archived-worker
 * exclusion and the band-crossing dedupe are all pinned here.
 */

const requireFromHere = createRequire(import.meta.url);
const engine = requireFromHere("../../../api/_lib/licence-compliance.js") as {
  LICENCE_TYPES: Array<{ id: string; label: string }>;
  parseIsoDay: (s: string) => number;
  licenceStatusFor: (
    expiryDate: string | null,
    opts?: { now?: Date; withinDays?: number }
  ) => { status: string; daysToExpiry: number | null };
  effectiveCredentials: (credentials: unknown[]) => Array<Record<string, unknown>>;
  licenceRows: (
    credentials: unknown[],
    users: unknown[],
    opts?: { now?: Date; withinDays?: number }
  ) => Array<Record<string, unknown>>;
  licenceThresholdFor: (days: number) => string | null;
  newLicenceCrossings: (
    rows: Array<Record<string, unknown>>,
    state: Record<string, unknown>,
    now?: Date
  ) => { crossed: Array<Record<string, unknown>>; nextState: Record<string, unknown> };
  worstStatusByUser: (
    credentials: unknown[],
    opts?: { now?: Date; withinDays?: number }
  ) => Record<string, string>;
};

// Fixed "today" for every test: 2026-06-15 local midnight.
const NOW = new Date(2026, 5, 15, 10, 30);
const iso = (daysFromNow: number) => {
  const d = new Date(2026, 5, 15);
  d.setDate(d.getDate() + daysFromNow);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function cred(id: string, userId: string, typeId: string, expiryDate: string | null, extra = {}) {
  return { id, userId, typeId, label: typeId, expiryDate, ...extra };
}

function user(id: string, extra = {}) {
  return { id, username: id, role: "electrician", ...extra };
}

describe("parseIsoDay — strict ISO only", () => {
  it("accepts yyyy-mm-dd, rejects legacy dd/mm/yyyy and impossible dates", () => {
    expect(Number.isFinite(engine.parseIsoDay("2026-06-15"))).toBe(true);
    expect(Number.isFinite(engine.parseIsoDay("15/06/2026"))).toBe(false);
    expect(Number.isFinite(engine.parseIsoDay("2026-02-31"))).toBe(false); // no rollover
    expect(Number.isFinite(engine.parseIsoDay("June 15"))).toBe(false);
    expect(Number.isFinite(engine.parseIsoDay(""))).toBe(false);
  });
});

describe("licenceStatusFor — day-0 semantics match the tags engine", () => {
  it.each([
    [-1, "expired"],
    [0, "expiring"], // expiry day itself is still "expiring", not expired
    [14, "expiring"],
    [60, "expiring"], // window boundary inclusive
    [61, "current"],
  ])("%i days out → %s", (days, status) => {
    const r = engine.licenceStatusFor(iso(days as number), { now: NOW });
    expect(r.status).toBe(status);
    expect(r.daysToExpiry).toBe(days);
  });

  it("null expiry is a real state: no-expiry, null days, never alerts", () => {
    expect(engine.licenceStatusFor(null, { now: NOW })).toEqual({
      status: "no-expiry",
      daysToExpiry: null,
    });
  });
});

describe("effectiveCredentials — renewals supersede", () => {
  it("latest expiry wins per (user, type); null expiry counts as never-expires", () => {
    const old = cred("c_old", "u1", "electrical", iso(-10));
    const renewed = cred("c_new", "u1", "electrical", iso(300));
    const forever = cred("c_forever", "u1", "white-card", null);
    const oldWhite = cred("c_oldwhite", "u1", "white-card", iso(5));
    const eff = engine.effectiveCredentials([old, renewed, forever, oldWhite]);
    const ids = eff.map((c) => c.id).sort();
    expect(ids).toEqual(["c_forever", "c_new"]);
  });

  it("'other' tickets are distinct things — never collapsed", () => {
    const a = cred("c_a", "u1", "other", iso(-5), { label: "Confined spaces" });
    const b = cred("c_b", "u1", "other", iso(100), { label: "Asbestos awareness" });
    expect(engine.effectiveCredentials([a, b])).toHaveLength(2);
  });

  it("different workers never collapse", () => {
    const a = cred("c_a", "u1", "electrical", iso(-5));
    const b = cred("c_b", "u2", "electrical", iso(100));
    expect(engine.effectiveCredentials([a, b])).toHaveLength(2);
  });
});

describe("licenceRows — the cron projection", () => {
  it("expiring/expired on live workers only, expired first, no licence number", () => {
    const credentials = [
      cred("c1", "u_live", "electrical", iso(-3), { number: "QLD-12345" }),
      cred("c2", "u_live", "ewp", iso(30)),
      cred("c3", "u_live", "first-aid", iso(200)), // current → not a row
      cred("c4", "u_live", "white-card", null), // no expiry → never
      cred("c5", "u_archived", "electrical", iso(-50)),
      cred("c6", "u_disabled", "electrical", iso(2)),
      cred("c7", "u_ghost", "electrical", iso(2)), // unknown user → dropped
    ];
    const users = [
      user("u_live"),
      user("u_archived", { archived: true }),
      user("u_disabled", { disabled: true }),
    ];
    const rows = engine.licenceRows(credentials, users, { now: NOW });
    expect(rows.map((r) => r.id)).toEqual(["c1", "c2"]); // expired first
    expect(rows[0]).toMatchObject({
      kind: "licence",
      key: "licence:c1",
      userId: "u_live",
      status: "expired",
      daysToExpiry: -3,
    });
    // PII discipline: rows feed push payloads — the number must not be there.
    expect(JSON.stringify(rows)).not.toContain("QLD-12345");
  });

  it("a renewal suppresses the superseded record's alert", () => {
    const credentials = [
      cred("c_old", "u1", "electrical", iso(-10)),
      cred("c_new", "u1", "electrical", iso(300)),
    ];
    const rows = engine.licenceRows(credentials, [user("u1")], { now: NOW });
    expect(rows).toEqual([]);
  });
});

describe("threshold bands + crossing dedupe", () => {
  it("bands: expired < 0 ≤ t14 ≤ 14 < t60 ≤ 60 < silent", () => {
    expect(engine.licenceThresholdFor(-1)).toBe("expired");
    expect(engine.licenceThresholdFor(0)).toBe("t14");
    expect(engine.licenceThresholdFor(14)).toBe("t14");
    expect(engine.licenceThresholdFor(15)).toBe("t60");
    expect(engine.licenceThresholdFor(60)).toBe("t60");
    expect(engine.licenceThresholdFor(61)).toBeNull();
  });

  it("same band twice stays silent; moving bands fires; renewals prune state", () => {
    const row = (days: number) => ({ key: "licence:c1", daysToExpiry: days });
    const first = engine.newLicenceCrossings([row(30)], {}, NOW);
    expect(first.crossed).toHaveLength(1); // entered t60
    const second = engine.newLicenceCrossings([row(29)], first.nextState, NOW);
    expect(second.crossed).toHaveLength(0); // still t60 — silent
    const third = engine.newLicenceCrossings([row(10)], second.nextState, NOW);
    expect(third.crossed).toHaveLength(1); // crossed into t14
    const fourth = engine.newLicenceCrossings([row(-1)], third.nextState, NOW);
    expect(fourth.crossed).toHaveLength(1); // crossed into expired
    // Renewed → no row → pruned, lifecycle resets.
    const fifth = engine.newLicenceCrossings([], fourth.nextState, NOW);
    expect(fifth.nextState).toEqual({});
  });
});

describe("worstStatusByUser — register chips", () => {
  it("expired beats expiring beats ok; renewal-aware", () => {
    const credentials = [
      cred("c1", "u_bad", "electrical", iso(-3)),
      cred("c2", "u_bad", "ewp", iso(200)),
      cred("c3", "u_warn", "first-aid", iso(30)),
      cred("c4", "u_ok", "white-card", null),
      // renewal: old expired electrical superseded → u_renewed is ok
      cred("c5", "u_renewed", "electrical", iso(-10)),
      cred("c6", "u_renewed", "electrical", iso(300)),
    ];
    expect(engine.worstStatusByUser(credentials, { now: NOW })).toEqual({
      u_bad: "expired",
      u_warn: "expiring",
      u_ok: "ok",
      u_renewed: "ok",
    });
  });
});
