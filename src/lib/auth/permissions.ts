import {
  isAdminRole,
  isClientRole,
  isFieldRole,
  isLeadingHandRole,
  isStaffRole,
  normaliseRole,
} from "./roles";

/**
 * Minimal Phase A permission table. Real per-feature permissions land
 * in Phase B+ when actual mutations exist to gate.
 *
 * Phase A only needs to answer "is this user allowed on this surface?"
 * for middleware redirects.
 */

export type Surface = "admin" | "phil" | "lh" | "client" | "portal";

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
    // The modern client portal (#271 / Epic 16) — the read-only surface that
    // will replace the kept static /client page. Client role only. landingFor
    // still sends clients to /client until the cutover PR (route-ownership
    // §12.1), so a client reaches /portal by navigation, not by default.
    case "portal":
      return isClientRole(role);
  }
}

/**
 * FULL job CREATE is literal-`admin`, NOT the admin tier. POST /api/jobs gates
 * on `me.role !== 'admin'` (api/jobs.js) — deliberately narrower than
 * EDIT/build, which use canManageJob (admin tier OR LH-on-job). We can't widen
 * the FULL-create gate: list visibility for "all jobs" is also literal-admin,
 * so a boss who created a job wouldn't see it in their own list.
 *
 * ONE flag-gated widening exists (Phil sharpened W2b, the recorded product
 * decision): a field/leading-hand caller with `phil_sharpened` enabled may
 * POST a RESTRICTED body — { name, code (IV####), siteAddress? } only — via
 * handlePhilFieldCreate in api/jobs.js. The server auto-assigns the creator
 * (assignedJobIds) so the visibility caveat above doesn't apply to that path.
 * Flag off = literal-admin, unchanged. Flipping the flag is the governance
 * step (P15) that ratifies the widening.
 *
 * This helper still mirrors the FULL-create gate: it guards the admin "New
 * job" button and /v2/jobs/new, which submit the full builder body — a
 * boss/pm (admin tier, not 'admin') never lands on a create form whose submit
 * would 403. Phil's "+ New job" form has its own gate (the sharpened flag +
 * phil surface) and does NOT use this helper. Build/edit entry points stay on
 * canAccessSurface(role, "admin").
 */
export function canCreateJob(role: unknown): boolean {
  return normaliseRole(role) === "admin";
}

/**
 * Named capability helpers — the page-side mirror of the same wrappers in
 * api/_lib/auth.js. They gate by INTENT so pages and APIs read the same way
 * ("can this role approve hours?") instead of re-deriving tiers inline. All
 * are thin wrappers over the role tiers in roles.ts; keep names + meaning in
 * sync with the CJS copy. (No new abstraction is introduced — these alias the
 * existing tier helpers; they exist for call-site readability + a single
 * tested contract.)
 */

// Surfaces (aliases of canAccessSurface, named for readability at call sites)
export function isOfficeRole(role: unknown): boolean {
  return isAdminRole(role);
}
export function canAccessBuhlOS(role: unknown): boolean {
  return isAdminRole(role);
}
export function canAccessPhil(role: unknown): boolean {
  return isFieldRole(role) || isLeadingHandRole(role);
}

// Jobs — draft/archived are office-only (admin tier); publish is a status
// flip the LH restriction blocks, so it's admin tier too.
export function canViewDraftJobs(role: unknown): boolean {
  return isAdminRole(role);
}
export function canViewArchivedJobs(role: unknown): boolean {
  return isAdminRole(role);
}
export function canPublishJobs(role: unknown): boolean {
  return isAdminRole(role);
}

// Hours
export function canSubmitHours(role: unknown): boolean {
  return isFieldRole(role) || isLeadingHandRole(role);
}
export function canApproveHours(role: unknown): boolean {
  return isStaffRole(role);
}

// Evidence / gear / plans
export function canReviewEvidence(role: unknown): boolean {
  return isAdminRole(role);
}
export function canManageGear(role: unknown): boolean {
  return isAdminRole(role);
}
export function canViewAssignedGear(role: unknown): boolean {
  return isFieldRole(role) || isLeadingHandRole(role);
}
export function canViewCurrentPlans(role: unknown): boolean {
  return isAdminRole(role) || isLeadingHandRole(role) || isFieldRole(role);
}
export function canViewSupersededPlans(role: unknown): boolean {
  return isAdminRole(role) || isLeadingHandRole(role);
}

// Plan markups (Plans Phase 2 overlays). Role-tier intent helpers — the API
// additionally job-scopes management via canManageJob (admin tier any job, LH
// on assigned job). Mirror in api/_lib/auth.js.
//   - manage  = create/edit/archive/toggle visibleToPhil (office side)
//   - view    = see ALL non-archived overlays (office side)
//   - philView= see only visibleToPhil non-archived overlays (field side)
export function canManagePlanMarkups(role: unknown): boolean {
  return isAdminRole(role) || isLeadingHandRole(role);
}
export function canViewPlanMarkups(role: unknown): boolean {
  return isAdminRole(role) || isLeadingHandRole(role);
}
export function canViewPhilPlanMarkups(role: unknown): boolean {
  return isFieldRole(role) || isLeadingHandRole(role);
}
