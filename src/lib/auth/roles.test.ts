import { describe, expect, it } from "vitest";
import {
  isAdminRole,
  isClientRole,
  isFieldRole,
  isLeadingHandRole,
  isStaffRole,
  normaliseRole,
} from "./roles";

describe("role tier helpers (modern)", () => {
  it("isAdminRole spans the whole admin tier, case-insensitive", () => {
    for (const r of [
      "admin",
      "boss",
      "owner",
      "manager",
      "office",
      "pm",
      "estimator",
      "Boss",
      "OWNER",
    ]) {
      expect(isAdminRole(r)).toBe(true);
    }
    for (const r of ["tradie", "lh", "client", "", null, undefined]) {
      expect(isAdminRole(r)).toBe(false);
    }
  });

  it("isLeadingHandRole matches every stored alias", () => {
    for (const r of ["leadinghand", "leading_hand", "leading-hand", "lh", "LH"]) {
      expect(isLeadingHandRole(r)).toBe(true);
    }
    expect(isLeadingHandRole("admin")).toBe(false);
    expect(isLeadingHandRole("tradie")).toBe(false);
  });

  it("isFieldRole covers the trades and excludes staff", () => {
    for (const r of ["tradie", "apprentice", "labourer", "electrician"]) {
      expect(isFieldRole(r)).toBe(true);
      expect(isStaffRole(r)).toBe(false);
    }
  });

  it("isStaffRole = admin tier OR leading-hand tier", () => {
    for (const r of ["admin", "boss", "office", "pm", "leadinghand", "lh"]) {
      expect(isStaffRole(r)).toBe(true);
    }
    for (const r of ["tradie", "apprentice", "electrician", "client", ""]) {
      expect(isStaffRole(r)).toBe(false);
    }
  });

  it("isClientRole is its own tier", () => {
    expect(isClientRole("client")).toBe(true);
    expect(isClientRole("admin")).toBe(false);
  });

  it("normaliseRole lowercases and tolerates nullish", () => {
    expect(normaliseRole("Boss")).toBe("boss");
    expect(normaliseRole(null)).toBe("");
    expect(normaliseRole(undefined)).toBe("");
  });
});
