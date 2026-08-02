/**
 * Role taxonomy. Originally lifted verbatim from the legacy implementations
 * (public/admin/operations.html ADMIN_ROLES + public/login.html landingFor(),
 * both deleted in the legacy-interface cutover) so existing auth cookies and
 * users.json role values keep resolving identically. This file is now the
 * ONLY role taxonomy in the product — api/_lib/auth.js mirrors it.
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
  | "subcontractor"
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
  // Subbies (owner decision 2026-08-02): field-tier in every way — field app,
  // hours against jobs, gear — EXCEPT payroll: they invoice the business
  // directly, so their approved hours are excluded from the Xero push
  // (payroll-validation) and they're never expected/nagged for missing days
  // (isHoursTrackedWorker in api/_lib/auth.js).
  "subcontractor",
];

export const CLIENT_ROLES: ReadonlyArray<string> = ["client"];

/**
 * Owner is a NARROWING WITHIN the admin tier, not a new tier: 'owner' is
 * already an ADMIN_ROLES member, so every owner is an admin but not every
 * admin is an owner. It exists so the product/platform-owner surface — the
 * Owner Console (docs/owner-console.md) — can gate to the person who runs the
 * platform, distinct from the day-to-day office admins. Mirrors OWNER_ROLES +
 * isOwnerRole in api/_lib/auth.js (keep both in sync).
 */
export const OWNER_ROLES: ReadonlyArray<string> = ["owner"];

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
 * Narrowing WITHIN the field tier (like owner within admin): every
 * subcontractor is a field worker, but payroll and the missing-days
 * expectation treat them specially — they invoice the business directly.
 * Mirrors isSubcontractorRole in api/_lib/auth.js (keep both in sync).
 */
export function isSubcontractorRole(role: unknown): boolean {
  return normaliseRole(role) === "subcontractor";
}

/**
 * Product/platform owner — the NARROW gate for the Owner Console
 * (docs/owner-console.md). NOTE: 'owner' is also an admin-tier role, so
 * isAdminRole('owner') is true too; this predicate never replaces the
 * admin-tier checks, it sits inside them. The email-allowlist bootstrap
 * (OWNER_EMAILS) lives API-side in api/_lib/auth.js because the session
 * cookie carries only { userId, role } — no email.
 */
export function isOwnerRole(role: unknown): boolean {
  return OWNER_ROLES.includes(normaliseRole(role));
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
 *   jobs:create          → exactly 'admin' (POST /api/jobs; narrower than the
 *                                           admin tier — see canCreateJob)
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
 *   observations:read    → requireAuth({jobId}) + non-client (job-scoped view)
 *   observations:review  → isAdminRole     (cross-job inbox triage/assign/resolve;
 *                                           matches access:buhlos so the API agrees
 *                                           with the BuhlOS surface gate)
 *   observations:convert → isAdminRole     (RFI/Variation/etc. — office only)
 *   employees:manage     → isAdminRole
 *   reports:read         → isStaffRole
 *   settings:manage      → isAdminRole
 *
 * canWrite / canManageJob live in api/_lib/auth.js (they need live
 * assignedJobIds from users.json, which only the API has).
 */
