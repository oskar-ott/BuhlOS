// Shared blob read/write helpers.
// Centralises the list+fetch+put pattern so API routes stay thin.
//
// Performance layer (added in the perf pass): readBlob has two heavy
// network operations per call — a `list({prefix})` against Vercel Blob
// (find the canonical URL for the key) and then a `fetch(url)` to pull
// the JSON. On an admin page load the shell's fan-out hits dozens of
// keys; the biggest cost is per-job data.json + tags.json reads via
// /api/jobs?withStats=1 and /api/snags-all (both walk every job).
//
// Two optimisations live here:
//
//   1. Short-TTL in-memory cache. Each readBlob result is cached for
//      BLOB_TTL_MS by key. Subsequent reads within the window skip
//      both list + fetch. Cache lives in module scope so it survives
//      between requests handled by the same warm Vercel function
//      instance (the common case for back-to-back admin nav).
//
//   2. In-flight dedupe (request coalescing). When N concurrent
//      readBlob calls hit the same key, only the first issues network
//      calls — the rest await the same promise. Kills duplicate-
//      fan-out cost when /api/jobs?withStats=1 reads users.json
//      while computeJobStats also wants users for crew counts.
//
// writeBlob invalidates the key on the local instance so a write
// followed by an immediate read sees the new state. Cross-instance
// staleness is bounded by BLOB_TTL_MS.
const { put, list, del } = require('@vercel/blob');

const token = () => process.env.BLOB_READ_WRITE_TOKEN;

// 5-second TTL keeps cross-instance staleness tight while still
// catching back-to-back reads from the same admin page load (sidebar
// counts + page render + nested per-job stats all happen in a few
// hundred ms). Bypass available via process.env.BLOB_CACHE_DISABLE=1
// for explicit no-cache contexts (cron jobs that need fresh reads).
const BLOB_TTL_MS = 5000;
const BLOB_CACHE_DISABLED = process.env.BLOB_CACHE_DISABLE === '1';

// LRU-ish cap so the cache can't grow unbounded for organisations
// with hundreds of per-job blobs. When the cap is hit we evict the
// oldest entries first.
const BLOB_CACHE_MAX = 200;

const _cache = new Map();    // key → { value, expiresAt }
const _inflight = new Map(); // key → Promise<value>

function _cacheGet(key) {
  if (BLOB_CACHE_DISABLED) return undefined;
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    _cache.delete(key);
    return undefined;
  }
  // Touch on hit so LRU eviction keeps hot keys.
  _cache.delete(key);
  _cache.set(key, entry);
  return entry.value;
}

function _cacheSet(key, value) {
  if (BLOB_CACHE_DISABLED) return;
  if (_cache.size >= BLOB_CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) _cache.delete(oldest);
  }
  _cache.set(key, { value, expiresAt: Date.now() + BLOB_TTL_MS });
}

function _cacheInvalidate(key) {
  _cache.delete(key);
}

// A genuine transient read failure (Blob present but unfetchable, an HTTP
// error, or a thrown list/fetch) is DISTINCT from a blob that is genuinely
// absent. #576: returning the caller's fallback for BOTH made a transient blip
// indistinguishable from "empty", so a read-modify-write writer could persist
// the fallback over a populated document and silently wipe it. The raw read now
// THROWS on transient failure and returns the fallback ONLY for genuine
// absence; callers decide whether to degrade (readBlob) or fail closed
// (readBlobStrict / writeBlob of a guarded store).
class BlobReadError extends Error {
  constructor(key, reason) {
    super(`blob read failed for ${key}: ${reason}`);
    this.code = 'blob_read_failed';
    this.key = key;
    this.reason = reason;
  }
}

// ── Deterministic-URL fast path ─────────────────────────────────────────
// Every writeBlob puts with addRandomSuffix:false, so a key's public URL is
// exactly `https://<storeHost>/<encoded key>`. The store host is NOT derivable
// from the token (verified: the token's embedded id differs from the URL host),
// so it is LEARNED once per warm instance — from the first list() match or
// put() result whose URL cleanly matches its pathname — and every later read
// skips the list() round-trip entirely.
//
// Why this matters: list() is an API call to the store's ORIGIN region while
// the GET is served by the CDN edge. Measured from Sydney (syd1 functions):
// list ~0.9s, put ~1.4s, edge GET ~10-70ms. The old list-then-fetch shape made
// EVERY blob read pay the cross-region list; pages that fan out over a dozen
// keys paid it a dozen times.
//
// Correctness never depends on the fast path: a 404 on the derived URL falls
// through to the ORIGINAL list() verification — so blobs written elsewhere
// WITH random suffixes (e.g. legend-crop PNG uploads) still resolve, and
// "genuine absence → fallback" is still decided by list(), never by a bare
// 404 (#576 discipline).
let _publicHost = null;

function _encodeKey(key) {
  return String(key).split('/').map(encodeURIComponent).join('/');
}

function _learnPublicHost(url, pathname) {
  try {
    const u = new URL(url);
    if (u.pathname === '/' + _encodeKey(pathname)) _publicHost = u.hostname;
  } catch {
    /* learning is best-effort — never let it break a read/write */
  }
}

// Test-only injection seam: blob.js is loaded via createRequire in tests, so
// vi.mock can't reach its SDK imports. Production never calls this.
let _overrides = {};
function __setTestOverrides(o) { _overrides = o || {}; _publicHost = null; }

async function _doReadBlob(key, fallback) {
  const doFetch = _overrides.fetch || fetch;
  const doList = _overrides.list || list;

  // Fast path: derived public URL, no list() round-trip. Cache-busting query
  // stays so any CDN in front of Blob returns fresh data on a cache miss; the
  // in-memory cache above is what prevents repeated network calls in the
  // common case.
  if (_publicHost) {
    let r;
    try {
      r = await doFetch(`https://${_publicHost}/${_encodeKey(key)}?t=${Date.now()}`, { cache: 'no-store' });
    } catch (e) {
      throw new BlobReadError(key, `fetch: ${e && e.message}`);
    }
    if (r.ok) {
      try {
        return await r.json();
      } catch (e) {
        throw new BlobReadError(key, `json: ${e && e.message}`);
      }
    }
    if (r.status !== 404) throw new BlobReadError(key, `http ${r.status}`);
    // 404 → fall through: legacy random-suffix blob or genuine absence —
    // only list() can tell them apart.
  }

  let blobs;
  try {
    ({ blobs } = await doList({ prefix: key, token: token() }));
  } catch (e) {
    throw new BlobReadError(key, `list: ${e && e.message}`);
  }
  const match = blobs.find(b => b.pathname === key);
  if (!match) return fallback; // genuine absence — the ONLY fallback path
  _learnPublicHost(match.url, match.pathname);
  let r;
  try {
    r = await doFetch(match.url + '?t=' + Date.now(), { cache: 'no-store' });
  } catch (e) {
    throw new BlobReadError(key, `fetch: ${e && e.message}`);
  }
  if (!r.ok) throw new BlobReadError(key, `http ${r.status}`);
  try {
    return await r.json();
  } catch (e) {
    throw new BlobReadError(key, `json: ${e && e.message}`);
  }
}

async function readBlob(key, fallback = null) {
  // 1. Cache hit?
  const cached = _cacheGet(key);
  if (cached !== undefined) return cached;
  // 2. Another concurrent reader for this key?
  const inflight = _inflight.get(key);
  if (inflight) return inflight;
  // 3. We're the first — issue the read, share the promise.
  const p = (async () => {
    try {
      let value;
      try {
        value = await _doReadBlob(key, fallback);
      } catch (e) {
        // Degrade gracefully for the ~100 read paths that pass a fallback:
        // return it, but DON'T cache it — a transient blip must not poison the
        // 5s cache, because writeBlob's current-document read would then see the
        // fallback and the shrink guard would have nothing to compare against
        // (#576). The next read simply retries the network.
        if (e instanceof BlobReadError) {
          console.error('readBlob degraded (transient)', key, e.reason);
          return fallback;
        }
        throw e;
      }
      _cacheSet(key, value);
      return value;
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, p);
  return p;
}

// Cache-skipping read. Use for endpoints where a write on another Vercel
// function instance must be visible to a follow-up read without waiting for
// BLOB_TTL_MS — e.g. gear asset detail / history fetched right after a
// transfer or report. The list view in api/assets.js already bypasses the
// cache by fetching each blob URL directly; this gives the GET-by-id path
// the same property without globally disabling the cache.
async function readBlobFresh(key, fallback = null) {
  _cacheInvalidate(key);
  let value;
  try {
    value = await _doReadBlob(key, fallback);
  } catch (e) {
    if (e instanceof BlobReadError) {
      console.error('readBlobFresh degraded (transient)', key, e.reason);
      return fallback; // degrade, don't cache (see readBlob)
    }
    throw e;
  }
  _cacheSet(key, value);
  return value;
}

// Strict read: returns the fallback ONLY for genuine absence and PROPAGATES a
// BlobReadError on transient failure. Use where "absent" must not be confused
// with "couldn't read" — notably writeBlob's current-document read for a guarded
// store, which then fails the write CLOSED rather than risk overwriting a
// populated document with a shrunken/empty one (#576). Cache-aware: a cached
// real value (or genuine-absence fallback) is reused; transient fallbacks are
// never cached, so a cache hit is always trustworthy.
async function readBlobStrict(key, fallback = null) {
  const cached = _cacheGet(key);
  if (cached !== undefined) return cached;
  const value = await _doReadBlob(key, fallback); // throws BlobReadError on transient
  _cacheSet(key, value);
  return value;
}

async function writeBlob(key, data, opts = {}) {
  // #157 write guards: per-store validation, shrink refusal, revision
  // stamping + optional stale-write rejection. The current document is read
  // through this module's own cache (cheap); when the caller passes
  // expectedRev we read FRESH so the conflict check is as tight as Vercel
  // Blob allows (no CAS — this narrows the race, it can't eliminate it).
  // A rejected write throws BEFORE the put and must never touch the cache.
  // #576: for a GUARDED store (shrink/count guard) or an expectedRev (CAS)
  // write, read the current document STRICTLY and FAIL THE WRITE CLOSED if it
  // can't be confirmed — a transient read failure must never let a
  // read-modify-write persist a shrunken/empty body over a populated one.
  // Unguarded stores keep the lenient behaviour (current → null on error), so
  // there is no added blast radius for the long tail.
  const { applyGuards, auditRejection, guardFor } = require('./blob-guards');
  const guard = guardFor(key);
  const shrinkGuarded = !!(guard && (guard.shrinkField || guard.shrinkCount));
  const wantFresh = opts.expectedRev !== undefined && opts.expectedRev !== null;
  const failClosed = shrinkGuarded || wantFresh;
  let current = null;
  try {
    if (wantFresh) {
      _cacheInvalidate(key);
      current = await _doReadBlob(key, null); // fresh + strict → tight CAS
    } else if (shrinkGuarded) {
      current = await readBlobStrict(key, null); // cache-ok + strict
    } else {
      current = await readBlob(key, null); // lenient: fallback on transient
    }
  } catch (err) {
    if (err instanceof BlobReadError && failClosed) {
      auditRejection(key, err, opts.actor); // record the fail-closed abort (best-effort)
      throw err;
    }
    current = null; // unguarded store → guards run without shrink/rev context
  }
  let stamped;
  try {
    stamped = applyGuards(key, data, current, opts);
  } catch (err) {
    auditRejection(key, err, opts.actor);
    throw err;
  }
  data = stamped;

  const serialized = JSON.stringify(data);
  const putResult = await (_overrides.put || put)(key, serialized, {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    token: token(),
  });
  // A successful put teaches this instance the store's public host, so every
  // subsequent readBlob takes the deterministic-URL fast path with no list().
  if (putResult && putResult.url) _learnPublicHost(putResult.url, key);
  // Set the local cache to the just-written data so subsequent reads
  // on this instance see fresh state without going back to Vercel
  // Blob's read endpoint, which has multi-second propagation lag
  // after a put — observable as back-to-back POSTs reading stale
  // snapshots even with cache-busted URLs. The JSON-roundtrip clone
  // protects against accidental post-write mutations by the caller.
  // Cross-instance staleness is still bounded by BLOB_TTL_MS — this
  // change just makes same-instance writes fully read-after-write
  // consistent. Was previously _cacheInvalidate(key).
  _cacheSet(key, JSON.parse(serialized));
}

async function deleteBlob(key) {
  try {
    const { blobs } = await list({ prefix: key, token: token() });
    const match = blobs.find(b => b.pathname === key);
    if (match) await del(match.url, { token: token() });
  } catch (e) {
    console.error('deleteBlob error', key, e.message);
  }
  _cacheInvalidate(key);
}

function setNoCache(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Cache-Control', 'no-store,no-cache,must-revalidate,max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
}

// Cheap freshness probe: the blob's `uploadedAt` (an ISO string) WITHOUT
// fetching its content. Uses list({prefix}) — metadata only — and deliberately
// does NOT go through readBlob's 5s content cache (which would mask a fresh
// write). Returns null when the key is absent or list fails (caller treats null
// as "can't confirm" → rebuild/fallback). Used by the jobs-summary read path to
// validate a derived projection against its source jobs.json without paying the
// multi-MB monolith fetch on the hot path.
async function blobUploadedAt(key) {
  try {
    const { blobs } = await list({ prefix: key, token: token() });
    const match = blobs.find(b => b.pathname === key);
    if (!match || match.uploadedAt == null) return null;
    // Normalise to an ISO string so callers compare like-for-like regardless of
    // whether the SDK hands back a Date or a string.
    return typeof match.uploadedAt === 'string'
      ? match.uploadedAt
      : new Date(match.uploadedAt).toISOString();
  } catch {
    return null;
  }
}

module.exports = {
  readBlob,
  readBlobFresh,
  readBlobStrict,
  writeBlob,
  deleteBlob,
  setNoCache,
  blobUploadedAt,
  BlobReadError,
  // Test-only seams (production never calls these):
  __setTestOverrides,
  __learnPublicHost: _learnPublicHost,
  __getPublicHost: () => _publicHost,
  __encodeKey: _encodeKey,
};
