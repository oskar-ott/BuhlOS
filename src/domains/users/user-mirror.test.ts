import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Signup user mirror (2026-08-09 incident). A worker absent from
 * public.user_profiles is invisible to the hours mirror AND falls back on the
 * read cutover — this module writes the profile row at account creation so
 * every new login is mapped from day one. Best-effort + triple-gated like
 * hours-mirror: any failure returns a reason, never throws.
 */

const requireFromHere = createRequire(import.meta.url);
const p = requireFromHere.resolve("../../../api/_lib/user-mirror.js");
const { mirrorSignupUser, PG_USER_ROLES } = requireFromHere(p) as {
  mirrorSignupUser: (
    user: Record<string, unknown> | null,
    extras?: object,
    deps?: object
  ) => Promise<{ mirrored: boolean; reason?: string; error?: string }>;
  PG_USER_ROLES: string[];
};

const OLD_URL = process.env.SUPABASE_DB_URL;
afterEach(() => {
  if (OLD_URL === undefined) delete process.env.SUPABASE_DB_URL;
  else process.env.SUPABASE_DB_URL = OLD_URL;
});

const USER = {
  id: "u_new1",
  username: "worker@example.com",
  name: "Tom Smith",
  role: "electrician",
  email: "worker@example.com",
  createdAt: "2026-08-09T00:00:00.000Z",
};
const throwDb = () => { throw new Error("getDb must not be called"); };

describe("mirrorSignupUser — gates", () => {
  it("skips without supabase env — no flag/db touch", async () => {
    delete process.env.SUPABASE_DB_URL;
    const r = await mirrorSignupUser(USER, {}, { getDb: throwDb, isFlagOn: async () => { throw new Error("nope"); } });
    expect(r).toEqual({ mirrored: false, reason: "no supabase env" });
  });

  it("skips when the dual-write flag is off — no db touch", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await mirrorSignupUser(USER, {}, { getDb: throwDb, isFlagOn: async () => false });
    expect(r).toEqual({ mirrored: false, reason: "flag off" });
  });

  it("skips a role the user_profiles CHECK would reject — never guesses", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await mirrorSignupUser({ ...USER, role: "wizard" }, {}, { getDb: throwDb, isFlagOn: async () => true });
    expect(r).toEqual({ mirrored: false, reason: 'role "wizard" not mirrorable' });
  });

  it("subcontractor IS mirrorable (signup role since #979)", () => {
    expect(PG_USER_ROLES).toContain("subcontractor");
  });

  it("skips a malformed user object", async () => {
    const r = await mirrorSignupUser(null, {}, { getDb: throwDb, isFlagOn: async () => true });
    expect(r).toEqual({ mirrored: false, reason: "no user/id/username" });
  });

  it("returns reason 'error' on a db failure — never throws (account creation survives)", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await mirrorSignupUser(USER, {}, { isFlagOn: async () => true, getDb: () => { throw new Error("pooler down"); } });
    expect(r.mirrored).toBe(false);
    expect(r.reason).toBe("error");
    expect(r.error).toContain("pooler down");
  });
});

describe("mirrorSignupUser — write path", () => {
  // sql tag: call 1 = tenant lookup, call 2 = the upsert.
  const dbServing = (opts: { tenant?: boolean } = {}) => {
    const calls: unknown[][] = [];
    const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(values);
      if (calls.length === 1) return Promise.resolve(opts.tenant === false ? [] : [{ id: "t1" }]);
      return Promise.resolve([]);
    };
    return { getDb: () => tag, calls };
  };

  it("skips when the tenant is not mirrored", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const { getDb } = dbServing({ tenant: false });
    const r = await mirrorSignupUser(USER, {}, { isFlagOn: async () => true, getDb });
    expect(r).toEqual({ mirrored: false, reason: "tenant not mirrored" });
  });

  it("upserts the profile with the users.json identity + employee phone", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const { getDb, calls } = dbServing();
    const r = await mirrorSignupUser(USER, { phone: "+61421558902" }, { isFlagOn: async () => true, getDb });
    expect(r).toEqual({ mirrored: true });
    expect(calls).toHaveLength(2);
    // The upsert carries: tenant, legacy id, username, display name, email,
    // phone, role, createdAt — in the insert's value order.
    expect(calls[1]).toEqual([
      "t1", "u_new1", "worker@example.com", "Tom Smith",
      "worker@example.com", "+61421558902", "electrician", "2026-08-09T00:00:00.000Z",
    ]);
  });
});
