'use strict';

// Sliding-window rate limiter (#514) — generalises the per-IP `rateLimitOk`
// pattern already inlined in access-requests.js / password-resets.js into a
// reusable, per-KEY limiter so the field PIN login can throttle failed attempts
// per USERNAME (a shared-site IP must not lock out a whole crew).
//
// HONEST LIMITATION: the counter is an in-memory Map that lives PER SERVERLESS
// INSTANCE and resets on cold start. It SLOWS an online brute-force of an
// exposed four-digit PIN; it is NOT a cluster-wide hard lockout. A durable
// counter (a blob/Postgres store) is the next step if a hard guarantee is
// needed — see docs and the #514 PR. bcrypt + small team scale remain the
// primary mitigations; this raises the cost of guessing.

/**
 * Create an isolated limiter. `now` is injectable on every method for tests.
 * @param {{ windowMs: number, max: number }} opts
 */
function createRateLimiter({ windowMs, max }) {
  /** @type {Map<string, number[]>} key → attempt timestamps within the window */
  const hits = new Map();

  function recentFor(key, now) {
    const pruned = (hits.get(key) || []).filter((ts) => now - ts < windowMs);
    if (pruned.length) hits.set(key, pruned);
    else hits.delete(key);
    return pruned;
  }

  return {
    /** True when `key` has already reached `max` attempts in the window. Does
     *  NOT record an attempt (pure check + prune). */
    isLimited(key, now = Date.now()) {
      if (!key) return false;
      return recentFor(key, now).length >= max;
    },
    /** Record one (failed) attempt for `key`. */
    record(key, now = Date.now()) {
      if (!key) return;
      const recent = recentFor(key, now);
      recent.push(now);
      hits.set(key, recent);
    },
    /** Seconds until the oldest in-window attempt ages out (0 when not limited). */
    retryAfterSec(key, now = Date.now()) {
      if (!key) return 0;
      const recent = recentFor(key, now);
      if (recent.length < max) return 0;
      return Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000));
    },
    /** Forget `key` entirely (e.g. on a successful login). */
    clear(key) {
      hits.delete(key);
    },
    /** Test-only: number of tracked keys. */
    _size() {
      return hits.size;
    },
  };
}

module.exports = { createRateLimiter };
