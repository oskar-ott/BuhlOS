import { describe, it, expect } from "vitest";
import { landingFor, rolePermits } from "./landing";

describe("landingFor()", () => {
  it("routes admin roles to /command-centre", () => {
    // 'owner' is deliberately excluded — it lands on the Owner Console
    // (docs/owner-console.md); see the dedicated test below.
    for (const role of ["admin", "boss", "manager", "office", "pm", "estimator"]) {
      expect(landingFor(role)).toBe("/command-centre");
      expect(landingFor(role.toUpperCase())).toBe("/command-centre");
    }
  });

  it("routes the owner role to its private Owner Console (/owner)", () => {
    expect(landingFor("owner")).toBe("/owner");
    expect(landingFor("OWNER")).toBe("/owner");
  });

  it("routes field roles to /phil/my-day (the Phil home, not the /v2/phil placeholder)", () => {
    for (const role of ["tradie", "apprentice", "labourer", "electrician"]) {
      expect(landingFor(role)).toBe("/phil/my-day");
    }
  });

  it("routes leading hands to /phil/my-day (legacy /lh home removed in the cutover)", () => {
    for (const role of ["leadinghand", "leading_hand", "leading-hand", "lh"]) {
      expect(landingFor(role)).toBe("/phil/my-day");
    }
  });

  it("routes clients to /client", () => {
    expect(landingFor("client")).toBe("/client");
  });

  it("falls back to /v2/login for unknown / null roles", () => {
    expect(landingFor(null)).toBe("/v2/login");
    expect(landingFor(undefined)).toBe("/v2/login");
    expect(landingFor("")).toBe("/v2/login");
    expect(landingFor("nonsense")).toBe("/v2/login");
  });
});

describe("rolePermits()", () => {
  it("accepts a role on its own landing", () => {
    expect(rolePermits("admin", "/command-centre")).toBe(true);
    expect(rolePermits("tradie", "/phil/my-day")).toBe(true);
    expect(rolePermits("owner", "/owner")).toBe(true);
  });

  it("rejects a role on the wrong landing", () => {
    expect(rolePermits("tradie", "/command-centre")).toBe(false);
    expect(rolePermits("admin", "/phil/my-day")).toBe(false);
    // owner ∈ admin tier, but its canonical landing is the Owner Console.
    expect(rolePermits("owner", "/command-centre")).toBe(false);
  });
});
