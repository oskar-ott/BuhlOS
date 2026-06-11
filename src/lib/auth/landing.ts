import {
  isAdminRole,
  isClientRole,
  isFieldRole,
  isLeadingHandRole,
  normaliseRole,
} from "./roles";

/**
 * The ONE canonical landingFor() — post legacy-interface cutover.
 *
 * The product has exactly two interfaces (docs/route-ownership.md §2):
 *   - admin    → /command-centre        (BuhlOS — desktop/office)
 *   - field    → /phil/my-day           (Phil — mobile/field; gated to field/LH)
 *   - LH       → /phil/my-day           (leading hands are field-tier; the legacy
 *                                         /lh home was removed in the cutover —
 *                                         LHs additionally have read access to
 *                                         /v2/jobs via the middleware "lh" surface)
 *   - client   → /client                (the read-only client portal — the ONE
 *                                         static page kept from the legacy estate,
 *                                         external-customer-facing; replacement is
 *                                         tracked as issue #271 / Epic 16)
 *   - unknown  → /v2/login              (so users can re-attempt)
 *
 * Route-ownership contract: docs/route-ownership.md §10. The legacy
 * login.html and its private landingFor() were deleted in the cutover —
 * this function is the only landing logic in the product.
 */
export function landingFor(role: unknown): string {
  const r = normaliseRole(role);
  if (isAdminRole(r)) return "/command-centre";
  if (isLeadingHandRole(r)) return "/phil/my-day";
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
