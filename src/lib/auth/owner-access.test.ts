import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isOwnerRole as tsIsOwnerRole, OWNER_ROLES } from "./roles";

/**
 * Owner Console access (docs/owner-console.md). Pins the OWNER-ONLY gate on
 * both sides of the taxonomy: the TS predicate (src/lib/auth/roles.ts, used by
 * the page's local-dev fallback + landingFor) and the authoritative CJS gate
 * (api/_lib/auth.js, used by /api/owner). They must stay in lockstep.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");

let auth: {
  isOwnerRole: (role: unknown) => boolean;
  ownerEmailAllowed: (email: unknown) => boolean;
  canAccessOwnerConsole: (user: unknown) => boolean;
};

beforeEach(() => {
  delete process.env.OWNER_EMAILS;
  // The owner-access helpers never touch Blob, but auth.js requires ./blob at
  // load — inject a no-op so requiring it never reaches @vercel/blob.
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (_k: string, fallback: unknown) => fallback),
      readBlobFresh: vi.fn(async (_k: string, fallback: unknown) => fallback),
      setNoCache: vi.fn(),
    },
  } as unknown as NodeJS.Module;
  delete requireFromHere.cache[authPath];
  auth = requireFromHere(authPath);
});

afterEach(() => {
  delete process.env.OWNER_EMAILS;
});

describe("isOwnerRole (TS + CJS parity)", () => {
  it("is true only for the 'owner' role, case-insensitively", () => {
    for (const fn of [tsIsOwnerRole, (r: unknown) => auth.isOwnerRole(r)]) {
      expect(fn("owner")).toBe(true);
      expect(fn("OWNER")).toBe(true);
      expect(fn("Owner")).toBe(true);
      for (const other of ["admin", "boss", "manager", "office", "pm", "estimator", "tradie", "lh", "client"]) {
        expect(fn(other)).toBe(false);
      }
      expect(fn(null)).toBe(false);
      expect(fn(undefined)).toBe(false);
      expect(fn("")).toBe(false);
    }
  });

  it("OWNER_ROLES is exactly ['owner']", () => {
    expect([...OWNER_ROLES]).toEqual(["owner"]);
  });
});

describe("ownerEmailAllowed", () => {
  it("admits the default bootstrap owner email, case/space-insensitively", () => {
    expect(auth.ownerEmailAllowed("oskaott@gmail.com")).toBe(true);
    expect(auth.ownerEmailAllowed("OSKAOTT@GMAIL.COM")).toBe(true);
    expect(auth.ownerEmailAllowed("  oskaott@gmail.com  ")).toBe(true);
  });

  it("rejects other emails and empties", () => {
    expect(auth.ownerEmailAllowed("someone@else.com")).toBe(false);
    expect(auth.ownerEmailAllowed("")).toBe(false);
    expect(auth.ownerEmailAllowed(null)).toBe(false);
    expect(auth.ownerEmailAllowed(undefined)).toBe(false);
  });

  it("respects the OWNER_EMAILS env override (and drops the default)", () => {
    process.env.OWNER_EMAILS = "a@b.com, c@d.com";
    expect(auth.ownerEmailAllowed("a@b.com")).toBe(true);
    expect(auth.ownerEmailAllowed("C@D.COM")).toBe(true);
    expect(auth.ownerEmailAllowed("oskaott@gmail.com")).toBe(false);
  });
});

describe("canAccessOwnerConsole (the authoritative gate)", () => {
  it("admits the owner role OR an allowlisted email; denies everyone else", () => {
    expect(auth.canAccessOwnerConsole({ role: "owner" })).toBe(true);
    expect(auth.canAccessOwnerConsole({ role: "admin", email: "oskaott@gmail.com" })).toBe(true);

    // A normal admin without an allowlisted email is NOT an owner.
    expect(auth.canAccessOwnerConsole({ role: "admin", email: "boss@elsewhere.com" })).toBe(false);
    expect(auth.canAccessOwnerConsole({ role: "admin" })).toBe(false);
    expect(auth.canAccessOwnerConsole({ role: "boss" })).toBe(false);
    expect(auth.canAccessOwnerConsole({ role: "tradie" })).toBe(false);
    expect(auth.canAccessOwnerConsole({ role: "client" })).toBe(false);
    expect(auth.canAccessOwnerConsole(null)).toBe(false);
    expect(auth.canAccessOwnerConsole(undefined)).toBe(false);
  });
});
