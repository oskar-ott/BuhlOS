import {
  isAdminRole,
  isClientRole,
  isFieldRole,
  isLeadingHandRole,
  normaliseRole,
} from "./roles";

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

/**
 * Job CREATE is literal-`admin`, NOT the admin tier. POST /api/jobs gates on
 * `me.role !== 'admin'` (api/jobs.js) — deliberately narrower than EDIT/build,
 * which use canManageJob (admin tier OR LH-on-job). We can't widen the POST
 * gate: list visibility for "all jobs" is also literal-admin, so a boss who
 * created a job wouldn't see it in their own list.
 *
 * Mirror that here so the "New job" button and /v2/jobs/new are gated to the
 * same set the server will accept — a boss/pm (admin tier, not 'admin') never
 * lands on a create form whose submit would 403. Build/edit entry points stay
 * on canAccessSurface(role, "admin").
 */
export function canCreateJob(role: unknown): boolean {
  return normaliseRole(role) === "admin";
}
