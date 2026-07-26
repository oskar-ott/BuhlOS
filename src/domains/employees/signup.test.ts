import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  resolveLinkState,
  isPlausibleDob,
  SIGNUP_ROLES,
  SignupResolveResponseSchema,
  SignupAdminResponseSchema,
  SignupRequestPublicSchema,
} from "./signup";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const requireCjs = createRequire(import.meta.url);

const NOW = Date.parse("2026-07-23T00:00:00.000Z");
const link = (patch: Record<string, unknown> = {}) => ({
  status: "active" as const,
  expiresAt: "2026-07-30T00:00:00.000Z",
  cap: null,
  ...patch,
});

describe("crew sign-up link state", () => {
  it("a live link within expiry is valid", () => {
    expect(resolveLinkState(link(), 0, NOW)).toBe("valid");
  });
  it("expiry flips to expired (lazy — no cron)", () => {
    expect(resolveLinkState(link({ expiresAt: "2026-07-22T00:00:00.000Z" }), 0, NOW)).toBe("expired");
  });
  it("paused and revoked beat expiry", () => {
    expect(resolveLinkState(link({ status: "paused", expiresAt: "2026-01-01T00:00:00.000Z" }), 0, NOW)).toBe("paused");
    expect(resolveLinkState(link({ status: "revoked" }), 0, NOW)).toBe("revoked");
  });
  it("the cap counts pending + approved, not rejected", () => {
    expect(resolveLinkState(link({ cap: 5 }), 4, NOW)).toBe("valid");
    expect(resolveLinkState(link({ cap: 5 }), 5, NOW)).toBe("capped");
  });
  it("no link is invalid", () => {
    expect(resolveLinkState(null, 0, NOW)).toBe("invalid");
  });

  it("stays in sync with the api/signup.js mirror", () => {
    const api = requireCjs(resolve(REPO, "api/signup.js"));
    // The public handler doesn't export the helper — assert on source text,
    // same technique as the audit-schema sync tests: the four state rules
    // must appear in both files.
    void api;
    const fs = requireCjs("node:fs") as typeof import("node:fs");
    const src = fs.readFileSync(resolve(REPO, "api/signup.js"), "utf8");
    const admin = fs.readFileSync(resolve(REPO, "api/employees.js"), "utf8");
    for (const needle of [
      "if (link.status === 'revoked') return 'revoked';",
      "if (link.status === 'paused') return 'paused';",
      "if (Number.isFinite(exp) && exp < nowMs) return 'expired';",
      "return 'capped';",
    ]) {
      expect(src, `api/signup.js drifted: ${needle}`).toContain(needle);
      expect(admin, `api/employees.js drifted: ${needle}`).toContain(needle);
    }
  });
});

describe("dob plausibility", () => {
  it("accepts a normal working-age dob", () => {
    expect(isPlausibleDob("1998-03-14", NOW)).toBe(true);
  });
  it("rejects garbage, children and time travellers", () => {
    expect(isPlausibleDob("not-a-date", NOW)).toBe(false);
    expect(isPlausibleDob("2020-01-01", NOW)).toBe(false);
    expect(isPlausibleDob("1901-01-01", NOW)).toBe(false);
  });
});

describe("public-link role guard", () => {
  it("offers field tiers only — no admin/office role can come in via the link", () => {
    expect(SIGNUP_ROLES).not.toContain("admin");
    expect(SIGNUP_ROLES).not.toContain("office");
    expect(SIGNUP_ROLES).not.toContain("pm");
    expect(SIGNUP_ROLES).not.toContain("estimator");
  });
  it("offers only electrician and apprentice — labourer/LH come via invite", () => {
    expect([...SIGNUP_ROLES]).toEqual(["electrician", "apprentice"]);
  });
  it("matches the FIELD_ROLES list in api/signup.js", () => {
    const fs = requireCjs("node:fs") as typeof import("node:fs");
    const src = fs.readFileSync(resolve(REPO, "api/signup.js"), "utf8");
    expect(src).toContain("const FIELD_ROLES = ['electrician', 'apprentice'];");
  });
});

describe("schemas", () => {
  it("resolve response parses the safe projection", () => {
    expect(
      SignupResolveResponseSchema.safeParse({
        state: "valid",
        link: { companyName: "bühl electrical", createdByName: "oskar", expiresAt: "2026-07-30T00:00:00.000Z" },
      }).success,
    ).toBe(true);
    expect(SignupResolveResponseSchema.safeParse({ state: "expired", link: null }).success).toBe(true);
  });
  it("admin response never carries a pinHash", () => {
    const row = {
      id: "sr_1",
      linkId: "sl_1",
      status: "pending",
      firstName: "Liam",
      lastName: "Marriott",
      preferredName: null,
      email: "liam@x.com",
      mobile: "+61400000000",
      role: "electrician",
      apprenticeYear: null,
      legalName: "Liam James Marriott",
      dob: "1998-03-14",
      startDate: null,
      submittedAt: "2026-07-23T00:00:00.000Z",
      flags: { duplicateEmail: false, duplicateName: false },
    };
    expect(SignupAdminResponseSchema.safeParse({ link: null, requests: [row] }).success).toBe(true);
    // A row that smuggles pinHash still parses (zod strips), but the schema
    // must not DECLARE it — the api strips it server-side.
    expect("pinHash" in SignupRequestPublicSchema.shape).toBe(false);
  });
  it("still parses queue rows with legacy roles the picker no longer offers", () => {
    const legacyRow = {
      id: "sr_2",
      linkId: "sl_1",
      status: "pending",
      firstName: "Sam",
      lastName: "Hall",
      preferredName: null,
      email: "sam@x.com",
      mobile: "+61400000001",
      role: "labourer",
      apprenticeYear: null,
      legalName: "Samuel Hall",
      dob: "1995-06-01",
      startDate: null,
      submittedAt: "2026-07-23T00:00:00.000Z",
      flags: { duplicateEmail: false, duplicateName: false },
    };
    expect(SignupRequestPublicSchema.safeParse(legacyRow).success).toBe(true);
  });
});
