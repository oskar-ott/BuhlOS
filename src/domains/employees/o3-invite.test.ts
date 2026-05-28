import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  resolveInviteState,
  validatePin,
  isCommonPin,
  pinsMatch,
} from "./service";
import {
  ResolveInviteResponseSchema,
  ResolvedInviteSchema,
  AcceptInvitePayloadSchema,
} from "./schema";
import { PhilInviteLanding } from "@/components/phil/PhilInviteLanding";
import type { ResolvedInvite } from "./types";

/* ----------------------------------------------------------------------- */
/* Invite state resolution (bible P1 / P8–P10)                             */
/* ----------------------------------------------------------------------- */

describe("resolveInviteState", () => {
  const future = "2099-01-01T00:00:00.000Z";
  const past = "2020-01-01T00:00:00.000Z";
  const live = { status: "active" };

  it("valid for sent/opened/failed with a live employee + future expiry", () => {
    expect(resolveInviteState({ status: "sent", expiresAt: future }, { status: "invited" })).toBe("valid");
    expect(resolveInviteState({ status: "opened", expiresAt: future }, { status: "invited" })).toBe("valid");
    // A failed *email* still has a live token → valid (copy-link works).
    expect(resolveInviteState({ status: "failed", expiresAt: future }, { status: "invited" })).toBe("valid");
  });
  it("expired when past expiry (lazy)", () => {
    expect(resolveInviteState({ status: "sent", expiresAt: past }, { status: "invited" })).toBe("expired");
  });
  it("revoked / accepted pass through", () => {
    expect(resolveInviteState({ status: "revoked", expiresAt: future }, { status: "draft" })).toBe("revoked");
    expect(resolveInviteState({ status: "accepted", expiresAt: past }, live)).toBe("accepted");
  });
  it("invalid for missing invite or disabled employee", () => {
    expect(resolveInviteState(null)).toBe("invalid");
    expect(resolveInviteState({ status: "sent", expiresAt: future }, { status: "disabled" })).toBe("invalid");
  });
});

/* ----------------------------------------------------------------------- */
/* PIN rules (bible §06 P5 + §10 S09)                                      */
/* ----------------------------------------------------------------------- */

describe("PIN rules (O3 weak-PIN expansion)", () => {
  it("rejects the named weak PINs", () => {
    for (const bad of ["0000", "1111", "1234", "4321", "1212", "6969", "2580", "7777", "2345"]) {
      expect(isCommonPin(bad), bad).toBe(true);
      expect(validatePin(bad).ok, bad).toBe(false);
    }
  });
  it("accepts a non-trivial PIN", () => {
    expect(isCommonPin("8053")).toBe(false);
    expect(validatePin("8053")).toEqual({ ok: true });
  });
  it("rejects non-4-digit input", () => {
    for (const bad of ["", "12", "12345", "12a4", "abcd"]) {
      expect(validatePin(bad).ok, bad).toBe(false);
    }
  });
  it("confirms matching PINs", () => {
    expect(pinsMatch("8053", "8053")).toBe(true);
    expect(pinsMatch("8053", "8054")).toBe(false);
  });
});

/* ----------------------------------------------------------------------- */
/* Schemas — safe payload, no token; accept payload validation              */
/* ----------------------------------------------------------------------- */

describe("invite resolve/accept schemas", () => {
  const resolved = {
    firstName: "Liam",
    lastName: "Marriott",
    displayName: null,
    email: "liam.m@gmail.com",
    phone: null,
    role: "apprentice" as const,
    roleLabel: "Apprentice",
    appAccess: "phil" as const,
    apprenticeYear: 1,
    companyName: "bühl electrical",
    expiresAt: "2026-06-11T00:00:00.000Z",
    jobs: ["Magill Rd"],
  };
  it("ResolvedInvite has no token/tokenHash field", () => {
    expect(ResolvedInviteSchema.safeParse(resolved).success).toBe(true);
    expect(Object.keys(ResolvedInviteSchema.shape)).not.toContain("tokenHash");
    expect(Object.keys(ResolvedInviteSchema.shape)).not.toContain("token");
  });
  it("resolve response parses valid + error states", () => {
    expect(ResolveInviteResponseSchema.safeParse({ state: "valid", invite: resolved }).success).toBe(true);
    expect(ResolveInviteResponseSchema.safeParse({ state: "expired", invite: null }).success).toBe(true);
    expect(ResolveInviteResponseSchema.safeParse({ state: "banana" }).success).toBe(false);
  });
  it("accept payload requires 4-digit pin + confirm", () => {
    expect(AcceptInvitePayloadSchema.safeParse({ token: "t", pin: "8053", confirmPin: "8053" }).success).toBe(true);
    expect(AcceptInvitePayloadSchema.safeParse({ token: "t", pin: "80", confirmPin: "80" }).success).toBe(false);
    expect(AcceptInvitePayloadSchema.safeParse({ token: "", pin: "8053", confirmPin: "8053" }).success).toBe(false);
  });
});

/* ----------------------------------------------------------------------- */
/* Render smokes — landing + error states                                   */
/* ----------------------------------------------------------------------- */

const VALID: ResolvedInvite = {
  firstName: "Liam",
  lastName: "Marriott",
  displayName: null,
  email: "liam.m@gmail.com",
  phone: null,
  role: "apprentice",
  roleLabel: "Apprentice",
  appAccess: "phil",
  apprenticeYear: 1,
  companyName: "bühl electrical",
  expiresAt: "2026-06-11T00:00:00.000Z",
  jobs: ["Magill Rd"],
};

describe("PhilInviteLanding render", () => {
  it("valid invite shows greeting + Set up Phil CTA", () => {
    const html = renderToString(createElement(PhilInviteLanding, { token: "TKN", state: "valid", invite: VALID }));
    expect(html).toContain("Liam");
    expect(html).toContain("Set up Phil");
    expect(html).toContain("Apprentice");
    expect(html).toContain("bühl electrical");
  });
  it("expired / revoked / accepted / invalid render honest copy", () => {
    const e = (state: "expired" | "revoked" | "accepted" | "invalid") =>
      renderToString(createElement(PhilInviteLanding, { token: "TKN", state, invite: null }));
    expect(e("expired")).toContain("expired");
    expect(e("revoked")).toContain("no longer active");
    expect(e("accepted")).toContain("already been used");
    expect(e("invalid")).toContain("look right");
  });
  it("never renders raw token in the markup", () => {
    const html = renderToString(createElement(PhilInviteLanding, { token: "SECRET_TOKEN_123", state: "valid", invite: VALID }));
    expect(html).not.toContain("SECRET_TOKEN_123");
  });
});
