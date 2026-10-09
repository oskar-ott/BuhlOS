'use strict';

// In-process API calls for the office (BuhlOS admin) server pages.
//
// The office pages used to fetch their OWN deployment's /api/* over HTTP, so one
// page view woke the Next page function PLUS one function per API file (the
// Today screen: eight) — each hop a network round trip, a JSON encode/decode,
// and (on a quiet app) its own cold start. Owner, 2026-10-09: "the mobile app
// is slow, especially the admin side". The field app got the same fix in #981
// (api/_lib/phil-page-data.js) with hand-written twins; here the page runs the
// REAL handler instead — same file, same auth (the session cookie is passed
// through), same scoping, same response — so there is nothing to keep in sync.
//
// inProcessFetch(url, init) is a drop-in for fetch(): it returns a WHATWG
// Response, so the pages' existing `res.ok` / `res.json()` / schema-parse code
// is unchanged. Only GETs to the handlers listed below run in-process; anything
// else (unknown path, non-GET, a handler that throws before answering) falls
// back to the ordinary network fetch, so the worst case is today's behaviour.
//
// Every call logs one `[perf]` line (path without query values, ms, status) so
// production runtime logs show where a slow screen spends its time.

// Static requires so the bundler includes exactly these handlers; each loads
// lazily on first use.
const HANDLERS = {
  'time-entries': () => require('../time-entries'),
  'time-entries-overview': () => require('../time-entries-overview'),
  jobs: () => require('../jobs'),
  'today-pulse': () => require('../today-pulse'),
  'admin-stats': () => require('../admin-stats'),
  auth: () => require('../auth'),
  employees: () => require('../employees'),
  licences: () => require('../licences'),
  'cost-rates': () => require('../cost-rates'),
  'payroll-runs': () => require('../payroll-runs'),
  'job-hours': () => require('../job-hours'),
  evidence: () => require('../evidence'),
};

/** `/api/<name>` → the handler key, or null. */
function handlerKeyOf(pathname) {
  const m = /^\/api\/([a-z0-9-]+)\/?$/.exec(pathname || '');
  return m && Object.prototype.hasOwnProperty.call(HANDLERS, m[1]) ? m[1] : null;
}

/** URLSearchParams → the Vercel-style req.query (repeated keys become arrays). */
function queryObject(searchParams) {
  const q = {};
  for (const [k, v] of searchParams) {
    if (Object.prototype.hasOwnProperty.call(q, k)) q[k] = [].concat(q[k], v);
    else q[k] = v;
  }
  return q;
}

/** Lower-cased plain header object from a fetch() `headers` init. */
function headerObject(h) {
  const out = {};
  if (!h) return out;
  const entries = typeof h.forEach === 'function' && !Array.isArray(h)
    ? (() => { const a = []; h.forEach((v, k) => a.push([k, v])); return a; })()
    : Array.isArray(h) ? h : Object.entries(h);
  for (const [k, v] of entries) out[String(k).toLowerCase()] = String(v);
  return out;
}

/**
 * Run one handler with a minimal Vercel-shaped req/res and capture its answer.
 * Resolves when the handler responds (json/send/end); a handler that returns
 * without responding is a 500, as it would hang over HTTP.
 */
function invoke(handler, req) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const headers = {};
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      setHeader(k, v) { headers[String(k).toLowerCase()] = String(v); return this; },
      getHeader(k) { return headers[String(k).toLowerCase()]; },
      json(body) {
        if (!headers['content-type']) headers['content-type'] = 'application/json';
        return finish(JSON.stringify(body));
      },
      send(body) {
        if (body !== null && typeof body === 'object' && !Buffer.isBuffer(body)) return this.json(body);
        return finish(body == null ? '' : body);
      },
      end(body) { return finish(body == null ? '' : body); },
    };
    function finish(body) {
      if (!settled) {
        settled = true;
        resolve({ status: res.statusCode, headers, body });
      }
      return res;
    }
    Promise.resolve()
      .then(() => handler(req, res))
      .then(() => {
        if (!settled) {
          settled = true;
          resolve({ status: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'handler did not respond' }) });
        }
      })
      .catch((err) => {
        if (!settled) reject(err);
      });
  });
}

/** Path + query KEYS only for the perf line — no ids, dates or names in logs. */
function perfLabel(url) {
  const keys = [...new Set([...url.searchParams.keys()])].sort();
  return url.pathname + (keys.length ? `?${keys.join('&')}` : '');
}

/**
 * fetch()-compatible: run GET /api/<handler> in this process, else fall back to
 * the network. `url` may be absolute (`${base}/api/x?y=1`) or a path.
 */
async function inProcessFetch(input, init = {}, deps = {}) {
  const realFetch = deps.fetch || fetch;
  const log = deps.log || ((line) => console.log(line));
  const url = new URL(String(input), 'http://in-process.local');
  const method = String(init.method || 'GET').toUpperCase();
  const key = method === 'GET' ? handlerKeyOf(url.pathname) : null;
  const loaders = deps.handlers || HANDLERS;
  if (!key || !loaders[key]) return realFetch(input, init);

  const started = Date.now();
  const headers = headerObject(init.headers);
  if (!headers.host && url.host !== 'in-process.local') headers.host = url.host;
  if (!headers['x-forwarded-proto'] && url.protocol) headers['x-forwarded-proto'] = url.protocol.replace(':', '');
  try {
    const handler = loaders[key]();
    const out = await invoke(handler, {
      method,
      url: url.pathname + url.search,
      query: queryObject(url.searchParams),
      headers,
      body: undefined,
    });
    log(`[perf] in-process ${perfLabel(url)} ${Date.now() - started}ms ${out.status}`);
    const nullBody = out.status === 204 || out.status === 205 || out.status === 304;
    return new Response(nullBody ? null : out.body, { status: out.status, headers: out.headers });
  } catch (err) {
    log(`[perf] in-process ${perfLabel(url)} failed after ${Date.now() - started}ms — falling back to fetch (${(err && err.message) || err})`);
    return realFetch(input, init);
  }
}

module.exports = { inProcessFetch, handlerKeyOf, queryObject, invoke, HANDLER_KEYS: Object.keys(HANDLERS) };
