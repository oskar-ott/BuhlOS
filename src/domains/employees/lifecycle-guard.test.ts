import { describe, expect, it } from "vitest";
import {
  isActiveAdmin,
  countActiveAdmins,
  validateRoleChange,
  validateDeactivation,
} from "./lifecycle-guard";
import type { Employee } from "./types";

/** #221 — pure lifecycle guards. No I/O; deterministic rules. */

type Lite = Pick<Employee, "id" | "role" | "status">;
const e = (id: string, role: string, status: Employee["status"] = "active"): Lite =>
  ({ id, role, status }) as Lite;

const ADMIN_A = e("a", "admin");
const ADMIN_B = e("b", "pm");
const FIELD = e("f", "electrician");
const DISABLED_ADMIN = e("d", "office", "disabled");

describe("isActiveAdmin / countActiveAdmins", () => {
  it("active + admin-tier role is an active admin (pm/office count, via isAdminRole)", () => {
    expect(isActiveAdmin(ADMIN_A)).toBe(true);
    expect(isActiveAdmin(ADMIN_B)).toBe(true);
    expect(isActiveAdmin(FIELD)).toBe(false);
    expect(isActiveAdmin(DISABLED_ADMIN)).toBe(false); // disabled → not active
  });
  it("counts only active admins", () => {
    expect(countActiveAdmins([ADMIN_A, ADMIN_B, FIELD, DISABLED_ADMIN])).toBe(2);
  });
});

describe("validateRoleChange", () => {
  it("rejects a non-canonical role", () => {
    const r = validateRoleChange({ employee: FIELD, toRole: "wizard", allEmployees: [FIELD, ADMIN_A] });
    expect(r).toMatchObject({ ok: false, code: "invalid_role" });
  });

  it("rejects demoting the LAST active admin", () => {
    const r = validateRoleChange({ employee: ADMIN_A, toRole: "electrician", allEmployees: [ADMIN_A, FIELD] });
    expect(r).toMatchObject({ ok: false, code: "last_admin" });
  });

  it("allows demoting one admin when another active admin remains", () => {
    const r = validateRoleChange({ employee: ADMIN_A, toRole: "electrician", allEmployees: [ADMIN_A, ADMIN_B] });
    expect(r.ok).toBe(true);
  });

  it("allows promoting a field worker to admin", () => {
    const r = validateRoleChange({ employee: FIELD, toRole: "admin", allEmployees: [FIELD, ADMIN_A] });
    expect(r.ok).toBe(true);
  });

  it("a disabled admin doesn't count as the last active admin", () => {
    // changing the disabled admin's role is fine; ADMIN_A is the only ACTIVE admin
    const r = validateRoleChange({ employee: DISABLED_ADMIN, toRole: "electrician", allEmployees: [DISABLED_ADMIN, ADMIN_A] });
    expect(r.ok).toBe(true);
  });

  it("admin → another admin-tier role is fine even as the last admin", () => {
    const r = validateRoleChange({ employee: ADMIN_A, toRole: "office", allEmployees: [ADMIN_A, FIELD] });
    expect(r.ok).toBe(true);
  });
});

describe("validateDeactivation", () => {
  it("rejects disabling the last active admin", () => {
    const r = validateDeactivation({ employee: ADMIN_A, allEmployees: [ADMIN_A, FIELD] });
    expect(r).toMatchObject({ ok: false, code: "last_admin" });
  });

  it("allows disabling one admin when another remains", () => {
    const r = validateDeactivation({ employee: ADMIN_A, allEmployees: [ADMIN_A, ADMIN_B] });
    expect(r.ok).toBe(true);
  });

  it("allows disabling a field worker", () => {
    const r = validateDeactivation({ employee: FIELD, allEmployees: [FIELD, ADMIN_A] });
    expect(r.ok).toBe(true);
  });

  it("rejects disabling an already-disabled account", () => {
    const r = validateDeactivation({ employee: DISABLED_ADMIN, allEmployees: [DISABLED_ADMIN, ADMIN_A] });
    expect(r).toMatchObject({ ok: false, code: "already_disabled" });
  });
});
