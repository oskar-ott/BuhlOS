// Pure cache-policy predicates for the Phil offline read cache (#135 Layer 2).
//
// `public/sw.js` is a plain service-worker script that cannot import app
// modules, so it transcribes these predicates inline. THIS module is the single
// readable, unit-tested source of truth for the decisions; the SW copy must stay
// in lockstep with it (and any change to sw.js bumps SW_VERSION —
// scripts/check-sw-cache-version.js enforces the bump, and
// sw-cache-policy.test.ts asserts the SW text still carries the guard tokens).
//
// The one decision that actually closes a bug lives here: shouldCachePhilPage
// blocks the auth-redirect leak (#575 P1b). The FIFO-overflow helper backs the
// growth bounds for both the page cache and the asset cache (#575 P2).

export interface PhilPageCacheDecision {
  /** pathname of the original navigation request, e.g. "/phil/my-day". */
  requestPath: string;
  /** the response's final URL after any followed redirects (`response.url`). */
  responseUrl: string;
  /** the worker's own origin (`self.location.origin`). */
  origin: string;
  /** `response.ok` — a 2xx status. */
  ok: boolean;
  /** `response.redirected` — true if a redirect was followed to get here. */
  redirected: boolean;
}

/**
 * Only cache a `/phil/*` navigation response that is a successful, NON-redirected,
 * same-origin, same-path document.
 *
 * #575 P1b: with an invalid session, middleware redirects `/phil/my-day` →
 * `/v2/login`. A navigation `fetch()` FOLLOWS that redirect, so `response.ok` is
 * true — caching naively would store the login page under `/phil/my-day` and
 * later serve it offline as the worker's day screen. Both guards catch it
 * independently: `redirected` is true, and the final pathname is `/v2/login`,
 * not the requested path. We refuse unless every condition holds — fail closed,
 * never cache something that isn't the page that was asked for.
 */
export function shouldCachePhilPage(input: PhilPageCacheDecision): boolean {
  if (!input.ok) return false;
  if (input.redirected) return false;
  let finalUrl: URL;
  try {
    finalUrl = new URL(input.responseUrl);
  } catch {
    return false;
  }
  if (finalUrl.origin !== input.origin) return false;
  return finalUrl.pathname === input.requestPath;
}

/**
 * How many of the oldest entries to evict so a cache of `count` entries fits
 * within `max`. `caches.keys()` is insertion-ordered, so deleting this many from
 * the front is FIFO eviction. Pure: returns 0 when already within bounds.
 */
export function overflowCount(count: number, max: number): number {
  if (max <= 0) return count;
  return Math.max(0, count - max);
}
