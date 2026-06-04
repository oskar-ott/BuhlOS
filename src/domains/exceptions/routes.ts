/**
 * Canonical action-route registry for the Needs Attention inbox.
 *
 * Every exception's "next action" resolves through here, so the inbox can only
 * ever link to a REAL, implemented BuhlOS surface. Each route is tied to the
 * page file that implements it (`sourceFile`) — `routes.test.ts` asserts those
 * files exist on disk, which makes "the link goes somewhere real" an enforced,
 * test-backed contract that catches a future route rename instead of shipping a
 * broken link.
 *
 * No fake routes, no future placeholders: a target that can't be satisfied
 * (unknown key, a per-job route with no jobId, a non-internal href) degrades to
 * an explicit `unavailable` state with a reason — the UI renders that as a muted
 * "action unavailable", never a clickable broken link.
 */

export type ExceptionActionState = "available" | "fallback" | "unavailable" | "future";

/** Encode a single dynamic path segment (jobId, etc.). */
export function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

/** True if the string contains any control char, space, or DEL (code <= 0x20 or 0x7f). */
function hasControlOrWhitespace(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * Internal-only href guard. An action link must be a canonical absolute path
 * on this app — never external, never a scheme, never malformed. Printable
 * punctuation (e.g. "-" in a jobId) is allowed; whitespace/control chars are not.
 */
export function isSafeActionHref(href: string | undefined | null): href is string {
  if (!href || typeof href !== "string") return false;
  if (!href.startsWith("/")) return false; // absolute internal path only
  if (href.startsWith("//")) return false; // protocol-relative ("//evil.example")
  if (href.includes(":")) return false; // no scheme (javascript:, http:, mailto:, …)
  if (href.includes("\\")) return false; // backslash trick
  if (hasControlOrWhitespace(href)) return false;
  return true;
}

interface RouteDef {
  /** Build the canonical href. Per-job routes consume `jobId`. */
  build: (params: { jobId?: string }) => string;
  /** The page.tsx that implements this route — proof of existence. */
  sourceFile: string;
  /** Default CTA label (a caller may override). */
  defaultLabel: string;
  /** True when the route needs a jobId path segment. */
  perJob: boolean;
}

export const ACTION_ROUTES = {
  hoursApprovals: {
    build: () => "/hours/approvals",
    sourceFile: "src/app/(admin)/hours/approvals/page.tsx",
    defaultLabel: "Review approvals",
    perJob: false,
  },
  observationsInbox: {
    build: () => "/observations",
    sourceFile: "src/app/(admin)/observations/page.tsx",
    defaultLabel: "Open observations",
    perJob: false,
  },
  materialRequests: {
    build: () => "/material-requests",
    sourceFile: "src/app/(admin)/material-requests/page.tsx",
    defaultLabel: "Open material requests",
    perJob: false,
  },
  jobHub: {
    build: (p) => `/v2/jobs/${encodeSegment(p.jobId!)}`,
    sourceFile: "src/app/v2/jobs/[jobId]/page.tsx",
    defaultLabel: "Open job",
    perJob: true,
  },
  jobBuilder: {
    build: (p) => `/v2/jobs/${encodeSegment(p.jobId!)}/builder`,
    sourceFile: "src/app/v2/jobs/[jobId]/builder/page.tsx",
    defaultLabel: "Open builder",
    perJob: true,
  },
  jobEvidence: {
    build: (p) => `/v2/jobs/${encodeSegment(p.jobId!)}/evidence`,
    sourceFile: "src/app/v2/jobs/[jobId]/evidence/page.tsx",
    defaultLabel: "Open evidence",
    perJob: true,
  },
  jobSnags: {
    build: (p) => `/v2/jobs/${encodeSegment(p.jobId!)}/snags`,
    sourceFile: "src/app/v2/jobs/[jobId]/snags/page.tsx",
    defaultLabel: "Open snags",
    perJob: true,
  },
  jobItps: {
    build: (p) => `/v2/jobs/${encodeSegment(p.jobId!)}/itps`,
    sourceFile: "src/app/v2/jobs/[jobId]/itps/page.tsx",
    defaultLabel: "Open ITPs",
    perJob: true,
  },
  jobObservations: {
    build: (p) => `/v2/jobs/${encodeSegment(p.jobId!)}/observations`,
    sourceFile: "src/app/v2/jobs/[jobId]/observations/page.tsx",
    defaultLabel: "Open observation",
    perJob: true,
  },
} as const satisfies Record<string, RouteDef>;

export type ActionRouteKey = keyof typeof ACTION_ROUTES;

export interface ResolvedAction {
  actionHref?: string;
  actionLabel: string;
  actionState: ExceptionActionState;
  actionReason?: string;
}

/**
 * Resolve a canonical action for an exception item. Returns `available` with a
 * safe href for a known route, or `unavailable` with a reason (and an optional
 * safe fallback href) when it can't be satisfied. Never throws, never returns
 * an unsafe href as `available`.
 */
export function resolveAction(
  key: ActionRouteKey,
  params: { jobId?: string } = {},
  opts: { label?: string; fallbackHref?: string } = {},
): ResolvedAction {
  const def = ACTION_ROUTES[key];
  const safeFallback = isSafeActionHref(opts.fallbackHref) ? opts.fallbackHref : undefined;

  // When the primary target can't be used, degrade to a SAFE fallback href as
  // `fallback` (still clickable, just a less-specific parent surface) or — if
  // there's no safe fallback — `unavailable` (no clickable link at all).
  const degrade = (reason: string): ResolvedAction =>
    safeFallback
      ? { actionHref: safeFallback, actionLabel: opts.label ?? def?.defaultLabel ?? "Open", actionState: "fallback", actionReason: reason }
      : { actionHref: undefined, actionLabel: opts.label ?? def?.defaultLabel ?? "Open", actionState: "unavailable", actionReason: reason };

  if (!def) return degrade(`No route registered for "${String(key)}".`);
  if (def.perJob && !params.jobId) return degrade("This item isn’t linked to a specific job.");
  const href = def.build(params);
  if (!isSafeActionHref(href)) return degrade("Computed link wasn’t a safe internal path.");

  return { actionHref: href, actionLabel: opts.label ?? def.defaultLabel, actionState: "available" };
}

/** A safe href to the per-job hub (`/v2/jobs/{id}`), or undefined. Used as the
 *  fallback target for per-job section items. */
export function jobHubHref(jobId: string | undefined): string | undefined {
  if (!jobId) return undefined;
  return resolveAction("jobHub", { jobId }).actionHref;
}
