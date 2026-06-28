/**
 * Client-side role gates for the services-locations card (#230). These mirror
 * the server gates in api/services-locations.js (admin + assigned LH/field may
 * add; admin + assigned LH may edit/remove) so the Phil + admin UIs only show
 * affordances the user could actually use — the server is still the authority.
 *
 * Job-level assignment is NOT re-checked here: any non-client viewer who has
 * reached the /phil/jobs/[jobId] page is already admin or assigned to the job
 * (the page + api gate enforce it). So "can write" on this surface reduces to
 * "is this an admin / LH / field role (not a client)".
 *
 * Cross-ref:
 *   api/_lib/auth.js canWrite / canManageJob — the server tiers
 *   src/lib/auth/roles.ts — the canonical role taxonomy
 */

const ADMIN_ROLES = new Set([
  "admin",
  "boss",
  "owner",
  "manager",
  "office",
  "pm",
  "estimator",
]);
const LEADING_HAND_ROLES = new Set([
  "leadinghand",
  "leading_hand",
  "leading-hand",
  "lh",
]);
const FIELD_ROLES = new Set(["tradie", "apprentice", "labourer", "electrician"]);

function norm(role: string | null | undefined): string {
  return String(role ?? "").toLowerCase();
}

/** Admin tier OR leading-hand tier OR field tier — the roles allowed to ADD a
 *  service location on a job they can see (server: canWrite). Clients excluded. */
export function canAddServiceLocation(role: string | null | undefined): boolean {
  const r = norm(role);
  return ADMIN_ROLES.has(r) || LEADING_HAND_ROLES.has(r) || FIELD_ROLES.has(r);
}

/** Admin tier OR leading-hand tier — the roles allowed to EDIT/REMOVE a service
 *  location (server: canManageJob). Field workers add but don't manage. */
export function canManageServiceLocation(role: string | null | undefined): boolean {
  const r = norm(role);
  return ADMIN_ROLES.has(r) || LEADING_HAND_ROLES.has(r);
}
