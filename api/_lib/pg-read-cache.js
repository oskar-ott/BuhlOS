// Process-local cache for the Postgres READ overlays (J6/J7 jobs, J10/J11 task
// status). Kills the per-request round-trip tax the dark-read cutovers pay from
// the Vercel function region to the Sydney Supabase project: the tenant-id
// lookup and the mirror walk were re-run on EVERY overlaid read, and each
// round-trip costs real wall-clock (measured on prod 2026-07-03: the J6 overlay
// alone added ~4s to every admin /api/jobs read — see the /jobs-read-status
// probe latency).
//
// WHY CACHING HERE IS SAFE (the load-bearing argument): the overlays are
// parity-gated against the FRESH Blob spine on every request — a job (or task
// status) is served from Postgres only when the PG copy is byte-faithful to the
// Blob copy read in THIS request. A stale cached mirror therefore can never
// change what a reader sees: if Blob moved on, the parity hash fails and that
// job falls back to Blob (output correct, only the diagnostics say "blob").
// Staleness costs PG-serving *coverage* for up to the TTL, never correctness.
//
// Scope rules:
//   * tenant ids are immutable → cached per slug for the process lifetime
//     (negative lookups are NOT cached, so a fresh tenant is found immediately);
//   * mirror reads are memoised for PG_READ_TTL_MS (60s) — long enough to cover
//     a job-hub section-nav burst, short enough that dual-write freshness
//     returns quickly;
//   * PG_READ_CACHE_DISABLE=1 turns the whole thing off (operator escape hatch,
//     mirroring BLOB_CACHE_DISABLE in ./blob.js).
//
// The READINESS PROBES must never read through this cache (they exist to
// measure live parity/latency) — probe callers pass `pgCache: null` explicitly.
// Unit tests inject their own `getDb`, which the overlay modules treat as
// "caller owns the database" and default the cache OFF unless the test passes
// its own instance via `pgCache`.

const PG_READ_TTL_MS = 60_000;
const CACHE_DISABLED = () => process.env.PG_READ_CACHE_DISABLE === '1';

// Bound the memo so a pathological key-space can't grow it unbounded (today the
// keys are one structure walk per tenant + one task-state entry per job).
const MEMO_MAX = 500;

function createPgReadCache() {
  const tenants = new Map(); // slug → tenant uuid (process lifetime)
  const memo = new Map();    // key → { value, expiresAt }

  return {
    /**
     * Tenant uuid for a slug, cached for the process lifetime. A missing
     * tenant returns null and is NOT cached (fail-open to the next lookup).
     */
    async tenantId(sql, slug) {
      if (!CACHE_DISABLED() && tenants.has(slug)) return tenants.get(slug);
      const rows = await sql`select id from public.tenants where slug = ${slug}`;
      const id = rows && rows.length ? rows[0].id : null;
      if (id != null && !CACHE_DISABLED()) tenants.set(slug, id);
      return id;
    },

    /**
     * Memoise an async PG read for PG_READ_TTL_MS. Cached values (including
     * null) are returned as-is inside the window; errors are never cached.
     */
    async memoize(key, fn, ttlMs = PG_READ_TTL_MS) {
      if (CACHE_DISABLED()) return fn();
      const hit = memo.get(key);
      if (hit && hit.expiresAt > Date.now()) return hit.value;
      const value = await fn();
      if (memo.size >= MEMO_MAX) {
        const oldest = memo.keys().next().value;
        if (oldest !== undefined) memo.delete(oldest);
      }
      memo.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    },

    /** Test/ops hook — drop everything. */
    _reset() {
      tenants.clear();
      memo.clear();
    },
  };
}

// The one shared instance production code uses.
const defaultPgReadCache = createPgReadCache();

module.exports = { createPgReadCache, defaultPgReadCache, PG_READ_TTL_MS };
