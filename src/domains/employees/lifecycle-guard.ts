import { isAdminRole } from "@/lib/auth/roles";
import { EmployeeRoleSchema } from "./schema";
import type { Employee } from "./types";

/**
 * Employee lifecycle guards (#221) — the pure safety rules behind "deactivate"
 * and "change role". The one rule that protects the business: you can never
 * strand the org without an admin. Demoting or disabling the LAST active
 * admin-tier account is refused; a non-canonical role is refused.
 *
 * Pure + dependency-free (only the shared role taxonomy + the role enum): no
 * I/O, no React. The API (api/employees.js) and the drawer call these before
 * they mutate, so the rule lives in ONE tested place and both surfaces agree.
 * Admin-tier membership is the normalised `isAdminRole` (never a literal
 * `=== 'admin'`), so boss/owner/office/pm all count as admins (role-literal
 * discipline).
 */

type EmployeeLite = Pick<Employee, "id" | "role" | "status">;

export type LifecycleResult =
  | { ok: true }
  | { ok: false; code: "invalid_role" | "last_admin" | "already_disabled"; error: string };

/** An account that currently has admin access: active AND an admin-tier role. */
export function isActiveAdmin(e: Pick<Employee, "role" | "status">): boolean {
  return e.status === "active" && isAdminRole(e.role);
}

/** How many accounts currently hold admin access. */
export function countActiveAdmins(employees: ReadonlyArray<Pick<Employee, "role" | "status">>): number {
  return employees.reduce((n, e) => (isActiveAdmin(e) ? n + 1 : n), 0);
}

/** Active admins OTHER than `exceptId` — the count that would remain if that
 *  account lost admin access. Robust whether or not `employees` includes it. */
function otherActiveAdmins(
  employees: ReadonlyArray<EmployeeLite>,
  exceptId: string,
): number {
  return employees.reduce(
    (n, e) => (e.id !== exceptId && isActiveAdmin(e) ? n + 1 : n),
    0,
  );
}

/**
 * Validate a role change. Refuses a non-canonical role, and refuses removing
 * admin from the last active admin (no other active admin would remain).
 */
export function validateRoleChange(input: {
  employee: EmployeeLite;
  toRole: string;
  allEmployees: ReadonlyArray<EmployeeLite>;
}): LifecycleResult {
  if (!EmployeeRoleSchema.safeParse(input.toRole).success) {
    return { ok: false, code: "invalid_role", error: `Unknown role "${input.toRole}".` };
  }
  const losingAdmin = isActiveAdmin(input.employee) && !isAdminRole(input.toRole);
  if (losingAdmin && otherActiveAdmins(input.allEmployees, input.employee.id) === 0) {
    return {
      ok: false,
      code: "last_admin",
      error: "Cannot remove admin from the last active admin — promote another admin first.",
    };
  }
  return { ok: true };
}

/**
 * Validate a deactivation. Refuses disabling an already-disabled account, and
 * refuses disabling the last active admin.
 */
export function validateDeactivation(input: {
  employee: EmployeeLite;
  allEmployees: ReadonlyArray<EmployeeLite>;
}): LifecycleResult {
  if (input.employee.status === "disabled") {
    return { ok: false, code: "already_disabled", error: "This account is already disabled." };
  }
  if (isActiveAdmin(input.employee) && otherActiveAdmins(input.allEmployees, input.employee.id) === 0) {
    return {
      ok: false,
      code: "last_admin",
      error: "Cannot disable the last active admin — promote another admin first.",
    };
  }
  return { ok: true };
}
