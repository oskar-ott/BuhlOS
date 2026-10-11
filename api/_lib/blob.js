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

// ── Verified reads — the read a DECISION is made on ─────────────────────────
// readBlob above is the fast read: the CDN, plus a 5s instance cache. Right
// after an overwrite the CDN can keep serving the PREVIOUS version for up to
// ~60s, even cache-busted. That is fine for a screen that refreshes; it is not
// fine for a read that is about to be written back or sent to payroll:
//   · the #157 compare-and-swap read the "current" revision through the same
//     CDN, so a stale handler read and a stale conflict-check read agreed with
//     each other and the conflict never tripped — documented live in
//     api/_lib/leave.js (2026-07-25: "the 'conflict' never trips");
//   · a day approved on the strength of a stale read can write the OLD hours
//     back over a correction made seconds earlier, with no error anywhere.
// readBlobVerified asks the store itself (head(), or an exact-match list() —
// API-fresh, never cached) for the blob's byte size and last-PUT time, fetches
// the body, and holds one against the other (source-freshness contentVerdict).
// It retries while the CDN is still serving another version and REFUSES
// (StaleReadError) rather than hand back content it could not confirm.

/** Thrown when a verified read could not confirm the current version within
 *  its retry budget. Carries code 'stale_write' on purpose: every write path
 *  already maps that code to a retryable 409 ("changed moments ago — retry"),
 *  which is exactly what this is. */
class StaleReadError extends Error {
  constructor(key, detail) {
    super(`could not confirm the latest version of ${key} — it changed moments ago; retry`);
    this.code = 'stale_write';
    this.name = 'StaleReadError';
    this.key = key;
    this.expectedRev = null;
    this.currentRev = null;
    this.detail = detail || null;
    this.retryAfterMs = (detail && detail.retryAfterMs) || null;
  }
}

function _sdk() {
  return require('@vercel/blob');
}

function _isBlobNotFound(e) {
  if (!e) return false;
  const NotFound = _sdk().BlobNotFoundError;
  if (typeof NotFound === 'function' && e instanceof NotFound) return true;
  return !!(e.constructor && e.constructor.name === 'BlobNotFoundError');
}

/**
 * API-fresh metadata for one key — { url, pathname, size, uploadedAt } — or
 * null when the blob genuinely does not exist. head() when this instance knows
 * the store host (one metadata call, a simple operation); otherwise an
 * exact-match list(), which also teaches the host. Never the CDN, never the
 * instance cache. Throws BlobReadError when the store can't answer.
 */
// A stalled store call may not hang the write it guards (same bound as the
// payroll read's content fetch): a timed-out head() falls back to list(), and a
// timed-out body fetch counts as unreadable and is retried.
const VERIFIED_CALL_TIMEOUT_MS = 8_000;
function _timeoutSignal() {
  try {
    return AbortSignal.timeout(VERIFIED_CALL_TIMEOUT_MS);
  } catch {
    return undefined;
  }
}

async function blobMeta(key) {
  const doHead = _overrides.head || _sdk().head;
  if (_publicHost && typeof doHead === 'function') {
    const url = `https://${_publicHost}/${_encodeKey(key)}`;
    try {
      const h = await doHead(url, { token: token(), abortSignal: _timeoutSignal() });
      if (h) {
        return { url: h.url || url, pathname: h.pathname || key, size: h.size, uploadedAt: h.uploadedAt };
      }
    } catch (e) {
      if (_isBlobNotFound(e)) return null;
      // Any other head() failure is not a verdict — ask list() instead.
    }
  }
  const doList = _overrides.list || list;
  let blobs;
  try {
    ({ blobs } = await doList({ prefix: key, token: token() }));
  } catch (e) {
    throw new BlobReadError(key, `list: ${e && e.message}`);
  }
  const match = (blobs || []).find((b) => b.pathname === key);
  if (!match) return null;
  _learnPublicHost(match.url, match.pathname);
  return { url: match.url, pathname: match.pathname, size: match.size, uploadedAt: match.uploadedAt };
}

/** One cache-busted body fetch: { doc, bytes } (bytes = the exact byte length
 *  served, for the size check), or { error } on HTTP error / bad JSON / network
 *  failure. A response without text() (some test doubles) parses via json(). */
async function _fetchBody(url) {
  const doFetch = _overrides.fetch || fetch;
  let r;
  try {
    r = await doFetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), {
      cache: 'no-store',
      signal: _timeoutSignal(),
    });
  } catch (e) {
    return { error: `fetch: ${e && e.message}` };
  }
  if (!r || !r.ok) return { error: `http ${r ? r.status : '?'}` };
  try {
    if (typeof r.text === 'function') {
      const body = await r.text();
      return { doc: JSON.parse(body), bytes: Buffer.byteLength(body, 'utf8') };
    }
    return { doc: await r.json() };
  } catch (e) {
    return { error: `json: ${e && e.message}` };
  }
}

// ~9.5s worst case before refusing. Long enough for the common seconds-scale
// CDN race; a refusal past it is retryable (the caller's 409 says so).
let VERIFIED_RETRY_DELAYS_MS = [500, 1000, 2000, 3000, 3000];
function __setVerifiedReadDelaysForTests(delays) {
  VERIFIED_RETRY_DELAYS_MS = Array.isArray(delays) ? delays : [];
}
const _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read `key` and PROVE it is the current version. Resolves
 * { value, meta } — value null (and meta null) only for a blob that genuinely
 * does not exist (the store's own answer, never a CDN 404). Throws
 * StaleReadError when the CDN kept serving another version (or a just-created
 * blob kept 404ing) for the whole retry budget, and BlobReadError when the
 * store itself couldn't be asked.
 */
async function readBlobVerified(key) {
  const { contentVerdict, CDN_SETTLE_MS } = require('./source-freshness');
  let last = null;
  for (let attempt = 0; attempt <= VERIFIED_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await _sleep(VERIFIED_RETRY_DELAYS_MS[attempt - 1]);
    // Metadata every attempt: a write landing mid-retry moves the target.
    const meta = await blobMeta(key);
    if (!meta) return { value: null, meta: null };
    const body = await _fetchBody(meta.url);
    if (body.error) {
      last = { problem: 'unreadable', reason: body.error, uploadedAt: meta.uploadedAt };
      continue;
    }
    const v = contentVerdict(meta, body, Date.now());
    if (v.current) {
      if (v.sizeMismatch) {
        console.warn(
          `verified read: accepting settled ${key} whose served byte size ${body.bytes} ≠ stored ${meta.size}`,
        );
      }
      _cacheSet(key, body.doc); // the freshest version this instance knows
      return { value: body.doc, meta };
    }
    last = {
      problem: 'stale',
      reason: v.reason,
      gapMs: v.gapMs,
      bytes: body.bytes,
      size: meta.size,
      uploadedAt: meta.uploadedAt,
    };
  }
  const putMs = last && last.uploadedAt instanceof Date ? last.uploadedAt.getTime() : Date.parse((last && last.uploadedAt) || '');
  const retryAfterMs = Number.isFinite(putMs) ? Math.max(1_000, putMs + CDN_SETTLE_MS - Date.now()) : null;
  console.error(
    `verified read refused: ${key} — ${last && last.problem}` +
      (last && last.problem === 'stale'
        ? ` (${last.reason}; served ${last.bytes} bytes vs stored ${last.size}; stamp gap ${last.gapMs}ms)`
        : last && last.reason ? ` (${last.reason})` : ''),
  );
  throw new StaleReadError(key, { ...last, retryAfterMs });
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
  //
  // Verified compare-and-swap (2026-10-09, the hours-integrity pass):
  //   · opts.current — the caller already holds the current document from a
  //     VERIFIED read (readBlobVerified) and made its decision on exactly that
  //     version; it is the CAS baseline and nothing is re-read. The residual
  //     race is the put's own latency (~1.4s): Blob has no conditional put.
  //   · opts.verifyCurrent — read the CAS baseline through readBlobVerified
  //     instead of the CDN, so a stale handler read can no longer agree with an
  //     equally stale conflict-check read (api/_lib/leave.js, 2026-07-25). A
  //     read that can't be confirmed fails the write closed (StaleReadError →
  //     the caller's retryable 409) — never a silent overwrite.
  const { applyGuards, auditRejection, guardFor } = require('./blob-guards');
  const guard = guardFor(key);
  const shrinkGuarded = !!(guard && (guard.shrinkField || guard.shrinkCount));
  const wantFresh = opts.expectedRev !== undefined && opts.expectedRev !== null;
  const failClosed = shrinkGuarded || wantFresh;
  const callerHoldsCurrent = Object.prototype.hasOwnProperty.call(opts, 'current');
  let current = null;
  try {
    if (callerHoldsCurrent) {
      current = opts.current === undefined ? null : opts.current;
    } else if (wantFresh && opts.verifyCurrent) {
      _cacheInvalidate(key);
      current = (await readBlobVerified(key)).value; // API-checked → a real CAS
    } else if (wantFresh) {
      _cacheInvalidate(key);
      current = await _doReadBlob(key, null); // fresh + strict → tight CAS
    } else if (shrinkGuarded) {
      current = await readBlobStrict(key, null); // cache-ok + strict
    } else {
      current = await readBlob(key, null); // lenient: fallback on transient
    }
  } catch (err) {
    if ((err instanceof BlobReadError || err instanceof StaleReadError) && failClosed) {
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
  readBlobVerified,
  blobMeta,
  writeBlob,
  deleteBlob,
  setNoCache,
  blobUploadedAt,
  BlobReadError,
  StaleReadError,
  // Test-only seams (production never calls these):
  __setTestOverrides,
  __setVerifiedReadDelaysForTests,
  __learnPublicHost: _learnPublicHost,
  __getPublicHost: () => _publicHost,
  __encodeKey: _encodeKey,
};
