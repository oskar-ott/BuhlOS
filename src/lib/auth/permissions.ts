import { isAdminRole, isClientRole, isFieldRole, isLeadingHandRole } from "./roles";

/**
 * Minimal Phase A permission table. Real per-feature permissions land
 * in Phase B+ when actual mutations exist to gate.
 *
 * Phase A only needs to answer "is this user allowed on this surface?"
 * for middleware redirects.
 */

export type Surface = "admin" | "phil" | "lh" | "client";

export function canAccessSurface(role: unknown, surface: Surface): boolean {
  switch (surface) {
    case "admin":
      return isAdminRole(role);
    case "phil":
      return isFieldRole(role) || isLeadingHandRole(role);
    case "lh":
      return isLeadingHandRole(role) || isAdminRole(role);
    case "client":
      return isClientRole(role);
  }
}
