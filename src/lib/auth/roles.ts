/**
 * Role taxonomy. Lifted verbatim from the legacy implementations:
 *   - public/admin/operations.html lines ~1541–1545
 *   - public/login.html landingFor()
 *
 * Keep these arrays in sync with the legacy values; the legacy login
 * is still active and the new login must redirect users to a surface
 * consistent with the existing auth cookie.
 */

export type Role =
  | "admin"
  | "boss"
  | "owner"
  | "manager"
  | "office"
  | "pm"
  | "estimator"
  | "leadinghand"
  | "leading_hand"
  | "leading-hand"
  | "lh"
  | "tradie"
  | "apprentice"
  | "labourer"
  | "electrician"
  | "client";

export const ADMIN_ROLES: ReadonlyArray<string> = [
  "admin",
  "boss",
  "owner",
  "manager",
  "office",
  "pm",
  "estimator",
];

export const LEADING_HAND_ROLES: ReadonlyArray<string> = [
  "leadinghand",
  "leading_hand",
  "leading-hand",
  "lh",
];

export const FIELD_ROLES: ReadonlyArray<string> = [
  "tradie",
  "apprentice",
  "labourer",
  "electrician",
];

export const CLIENT_ROLES: ReadonlyArray<string> = ["client"];

export function normaliseRole(raw: unknown): string {
  return String(raw ?? "").toLowerCase();
}

export function isAdminRole(role: unknown): boolean {
  return ADMIN_ROLES.includes(normaliseRole(role));
}

export function isLeadingHandRole(role: unknown): boolean {
  return LEADING_HAND_ROLES.includes(normaliseRole(role));
}

export function isFieldRole(role: unknown): boolean {
  return FIELD_ROLES.includes(normaliseRole(role));
}

export function isClientRole(role: unknown): boolean {
  return CLIENT_ROLES.includes(normaliseRole(role));
}
