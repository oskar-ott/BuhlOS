import {
  isAdminRole,
  isClientRole,
  isFieldRole,
  isLeadingHandRole,
  normaliseRole,
} from "./roles";

/**
 * The ONE canonical landingFor() for the new Phase A surface.
 *
 * Phase A+ maps roles to a mix of new and legacy URLs:
 *   - admin    → /command-centre        (new BuhlOS admin shell)
 *   - field    → /phil/my-day           (new Phil home — the "Today" tab; its page
 *                                         docstring notes it "replaces the placeholder
 *                                         /v2/phil". /phil/my-day is gated to field/LH,
 *                                         so a field worker always passes the gate here.)
 *   - LH       → /lh                    (still legacy; vercel.json rewrites to lh-home.html)
 *   - client   → /client                (still legacy; vercel.json rewrites to client.html)
 *   - unknown  → /v2/login              (so users can re-attempt)
 *
 * Route-ownership contract: docs/route-ownership.md §10.
 *
 * The legacy login.html keeps its own landingFor() pointing at /admin/operations,
 * /my-day, etc. — that's correct because legacy login serves the legacy surfaces.
 * Mixing the two is intentional in Phase A; cutover is Phase B+.
 *
 * Cross-ref: docs/rebuild-audit/08-next-claude-code-prompt.md §"For /login"
 */
export function landingFor(role: unknown): string {
  const r = normaliseRole(role);
  if (isAdminRole(r)) return "/command-centre";
  if (isLeadingHandRole(r)) return "/lh";
  if (isFieldRole(r)) return "/phil/my-day";
  if (isClientRole(r)) return "/client";
  return "/v2/login";
}

/**
 * Returns true if `role` is permitted to view a page mounted under the
 * given canonical landing. Used by middleware to detect wrong-surface
 * users (e.g. a tradie hitting /command-centre) and redirect them home.
 */
export function rolePermits(role: unknown, landing: string): boolean {
  return landingFor(role) === landing;
}
