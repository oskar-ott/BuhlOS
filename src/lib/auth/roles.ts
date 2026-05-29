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

/**
 * "Staff" = admin tier OR leading-hand tier: the people who manage jobs,
 * approve hours, triage snags/observations and see team-wide views. Field
 * workers and clients are not staff. Mirrors `isStaffRole` in
 * api/_lib/auth.js (keep both in sync) and is the canonical replacement for
 * the inline `['admin','leadingHand'].includes(role)` checks the legacy API
 * used to do.
 */
export function isStaffRole(role: unknown): boolean {
  return isAdminRole(role) || isLeadingHandRole(role);
}

/**
 * Capability model.
 *
 * BuhlOS/Phil authorise by ROLE TIER, not by per-feature capability flags —
 * the tiers above (admin / leading-hand / field / client) ARE the
 * capability groups. This table documents how the capabilities the product
 * reasons about map onto the tiers, so future endpoints gate consistently:
 *
 *   access:buhlos        → isAdminRole            (admin tier)
 *   access:phil          → isFieldRole || isLeadingHandRole
 *   jobs:read            → isStaffRole || assigned || (client && own job)
 *   jobs:write           → canWrite   (admin tier, or LH/field on assigned job)
 *   jobs:manage          → canManageJob (admin tier, or LH on assigned job)
 *   hours:create         → isFieldRole || isLeadingHandRole (own/on-behalf)
 *   hours:approve        → isStaffRole
 *   evidence:create      → canWrite
 *   evidence:review      → isAdminRole
 *   snags:create         → canWrite
 *   snags:review         → isStaffRole
 *   gear:read            → any authenticated non-client
 *   gear:manage          → isAdminRole
 *   observations:create  → canWrite        (field/LH on assigned job, admin any)
 *   observations:review  → isStaffRole     (triage/assign/priority/resolve)
 *   observations:convert → isAdminRole     (RFI/Variation/etc. — office only)
 *   employees:manage     → isAdminRole
 *   reports:read         → isStaffRole
 *   settings:manage      → isAdminRole
 *
 * canWrite / canManageJob live in api/_lib/auth.js (they need live
 * assignedJobIds from users.json, which only the API has).
 */
