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
const { resolveAllowedOrigin } = require('./domains');

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

async function _doReadBlob(key, fallback) {
  try {
    const { blobs } = await list({ prefix: key, token: token() });
    const match = blobs.find(b => b.pathname === key);
    if (!match) return fallback;
    // Cache-busting query stays so any CDN in front of Blob returns
    // fresh data on a cache miss; the in-memory cache above is what
    // prevents repeated network calls in the common case.
    const r = await fetch(match.url + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return fallback;
    return await r.json();
  } catch (e) {
    console.error('readBlob error', key, e.message);
    return fallback;
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
      const value = await _doReadBlob(key, fallback);
      _cacheSet(key, value);
      return value;
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, p);
  return p;
}

async function writeBlob(key, data) {
  await put(key, JSON.stringify(data), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    token: token(),
  });
  // Invalidate on the local instance so a subsequent read in the
  // same request lifecycle sees the new state. Other warm instances
  // self-correct within BLOB_TTL_MS.
  _cacheInvalidate(key);
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

// CORS + no-cache headers for API responses.
//
// Note on credentials + origins: the previous version of this helper set
// `Access-Control-Allow-Origin: *` with `Access-Control-Allow-Credentials:
// true`. That combination is rejected by browsers (cookies are not sent
// or accepted), so it never actually authorised any cross-origin
// request — it only worked because the frontend and API live on the
// same origin today. To support the new domain split (buhlos.com /
// phil.buhlos.com / api.buhlos.com) without weakening anything, we now
// echo a specific origin from the allow-list (see _lib/domains.js).
// Same-origin callers don't send an Origin header and so won't trigger
// a CORS check at all — behaviour is unchanged for them.
function setNoCache(res, req) {
  const origin = req && req.headers ? (req.headers.origin || '') : '';
  const allowed = resolveAllowedOrigin(origin);
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', allowed);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store,no-cache,must-revalidate,max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
}

module.exports = { readBlob, writeBlob, deleteBlob, setNoCache };
