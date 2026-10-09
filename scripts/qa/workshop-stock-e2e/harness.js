#!/usr/bin/env node
'use strict';

// Workshop Stock — local browser end-to-end harness. TEST-ONLY: never deployed,
// never pointed at a hosted database. docs/workshop-stock.md → "Testing".
//
// Serves the REAL api/workshop-stock.js handler on http://localhost:3101 against
// a LOCAL Postgres that has the migrations applied. Production code runs for
// everything — session check, the flag gate, Zod bodies, upload sniffing,
// quantity parsing, catalogue matching, the ledger and its triggers,
// idempotency, the undo policy, audit verbs, lookup orchestration, the
// SSRF-guarded page fetch, page extraction and code verification. Only these
// edges are replaced:
//
//   • Vercel Blob — users.json / jobs.json are synthetic people and jobs held in
//     memory; product photos are kept in memory.
//   • The Anthropic HTTP call — `@anthropic-ai/sdk` is swapped for a stand-in
//     whose messages.create answers like the API: a photo request returns the
//     model JSON the test queued (POST /__harness/vision); a web-search request
//     returns search-result blocks for the fixture listings below. The real
//     readProductPhoto / searchListings code builds the request and parses the
//     response. NO model is called and no real key is read.
//   • The network under the page fetch — fetchAllowlistedPage runs for real,
//     with a fixture transport (fixture DNS answer + gzip fixture HTML) in place
//     of https.request / dns.lookup.
//
// Run (see the doc for the whole sequence):
//   WORKSHOP_STOCK_E2E_DB_URL=postgres://…@localhost:5432/stock_test \
//   SESSION_SECRET=<same as next dev> node scripts/qa/workshop-stock-e2e/harness.js

const http = require('http');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { Readable } = require('stream');
const { EventEmitter } = require('events');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const at = (rel) => require.resolve(path.join(ROOT, rel));

const DB_URL = process.env.WORKSHOP_STOCK_E2E_DB_URL || '';
const PORT = Number(process.env.WORKSHOP_STOCK_E2E_PORT || 3101);

function die(msg) {
  console.error(`[stock-harness] ${msg}`);
  process.exit(1);
}
if (!DB_URL) die('set WORKSHOP_STOCK_E2E_DB_URL to a LOCAL Postgres with the migrations applied');
let dbHost = '';
try { dbHost = new URL(DB_URL).hostname; } catch { die('WORKSHOP_STOCK_E2E_DB_URL is not a URL'); }
if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(dbHost)) die('refusing: this harness only runs against a database on localhost');
if (String(process.env.SESSION_SECRET || '').length < 16) die('set SESSION_SECRET (16+ chars) — the same value next dev uses');

// The handler's environment: a local database only, the flag on, no real AI key.
delete process.env.SUPABASE_ALLOW_PRODUCTION_WRITES;
Object.assign(process.env, {
  SUPABASE_ENV: 'local',
  SUPABASE_PROJECT_REF: 'localstack',
  SUPABASE_DB_URL: DB_URL,
  FLAG_WORKSHOP_STOCK: '1',
  ANTHROPIC_API_KEY: 'harness-stand-in-never-sent',
  BLOB_READ_WRITE_TOKEN: 'harness-stand-in-never-sent',
});
delete process.env.STOCK_LOOKUP_DISABLED;

function fakeModule(resolved, exports) {
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
const copy = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

// ── synthetic people + jobs (Blob stand-in) ──────────────────────────────────

const PEOPLE = {
  worker: { id: 'u_e2e_worker', username: 'e2e-worker', name: 'Sam Tester', role: 'electrician' },
  worker2: { id: 'u_e2e_worker2', username: 'e2e-worker2', name: 'Jo Tester', role: 'apprentice' },
  office: { id: 'u_e2e_office', username: 'e2e-office', name: 'Olive Tester', role: 'office' },
};
const blobMem = new Map();
function seedBlob() {
  blobMem.clear();
  blobMem.set('users.json', { users: Object.values(PEOPLE).map((p) => ({ ...p, passwordHash: 'x' })) });
  blobMem.set('jobs.json', { jobs: [{ id: 'j_e2e_1', name: 'TEST Birdwood St fit-off', code: 'E2E-001', status: 'active' }] });
}
seedBlob();
class BlobReadError extends Error {}
const readMem = async (k, fallback) => (blobMem.has(k) ? copy(blobMem.get(k)) : fallback);
fakeModule(at('api/_lib/blob.js'), {
  readBlob: readMem,
  readBlobFresh: readMem,
  readBlobStrict: readMem,
  writeBlob: async (k, d) => { blobMem.set(k, copy(d)); },
  deleteBlob: async (k) => { blobMem.delete(k); },
  setNoCache: (res) => res.setHeader('Cache-Control', 'no-store'),
  blobUploadedAt: async () => null,
  BlobReadError,
});

// ── the Anthropic stand-in ───────────────────────────────────────────────────

const visionQueue = [];
const calls = { vision: [], search: [] };
const config = { searchFail: null };

// Fixture listings returned by the stand-in web search, keyed by the code that
// is searched for. Hosts are on the production allowlist (sources.js); the
// pages behind them are FIXTURE_PAGES — synthetic test content.
const FIXTURE_LISTINGS = {
  '2025WE': [
    { url: 'https://www.clipsal.com/products/2025we', title: '2025WE | Clipsal', snippet: 'Catalogue number 2025WE double switched socket outlet' },
    { url: 'https://www.rexel.com.au/p/CLI2025WE', title: 'Clipsal 2025WE Double Power Point White', snippet: 'Clipsal 2025WE' },
  ],
};
const FIXTURE_PAGES = {
  'https://www.clipsal.com/products/2025we': `<!doctype html><html><head><title>2025WE | Clipsal</title>
<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Product', name: 'Double Switched Socket Outlet 10A 250V', mpn: '2025WE',
    brand: { '@type': 'Brand', name: 'Clipsal' }, color: 'White', image: 'https://www.clipsal.com/img/2025we.png',
    description: 'Double switched socket outlet, 10A, 250V, white.',
  })}</script></head><body><h1>Double Switched Socket Outlet 10A 250V</h1><p>Catalogue number: 2025WE</p></body></html>`,
  'https://www.rexel.com.au/p/CLI2025WE': `<!doctype html><html><head><title>Clipsal 2025WE Double Power Point White</title></head>
<body><h1>Clipsal 2025WE Double Power Point White</h1><p>Supplier listing.</p></body></html>`,
};

function hostAllowed(url, domains) {
  const h = new URL(url).hostname;
  return (domains || []).some((d) => h === d || h.endsWith(`.${d}`));
}

function apiError(status, message) {
  return Object.assign(new Error(message), { status });
}

const FakeAnthropic = class {
  constructor(opts) {
    if (!opts || opts.apiKey !== process.env.ANTHROPIC_API_KEY) throw new Error('harness: unexpected client options');
    this.beta = { messages: { create: (params) => this.create(params) } };
  }

  async create(params) {
    const tool = (params.tools || [])[0];
    if (tool && tool.name === 'web_search') return this.search(params, tool);
    return this.vision(params);
  }

  async vision(params) {
    const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
    const image = content.find((b) => b.type === 'image');
    if (!image || !image.source || !image.source.data) throw apiError(400, 'harness: no image in the photo request');
    if (!params.output_config || !params.output_config.format || params.output_config.format.type !== 'json_schema') throw apiError(400, 'harness: photo read without a strict schema');
    calls.vision.push({ model: params.model, imageBytes: Buffer.from(image.source.data, 'base64').length, at: new Date().toISOString() });
    const next = visionQueue.shift();
    if (!next) throw apiError(529, 'harness: no reading queued');
    if (next.fail) throw apiError(next.fail, 'harness: queued failure');
    if (next.refusal) return { id: 'msg_harness', type: 'message', role: 'assistant', model: params.model, stop_reason: 'refusal', content: [], usage: { input_tokens: 1200, output_tokens: 0 } };
    return {
      id: 'msg_harness', type: 'message', role: 'assistant', model: params.model, stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(next.raw) }],
      usage: { input_tokens: 1500, output_tokens: 220 },
    };
  }

  async search(params, tool) {
    const prompt = String(params.messages[0].content);
    calls.search.push({ prompt, allowedDomains: tool.allowed_domains, maxUses: tool.max_uses, at: new Date().toISOString() });
    if (config.searchFail) throw apiError(config.searchFail, 'harness: search failure');
    const code = (/manufacturer code "([^"]+)"/.exec(prompt) || [])[1] || '';
    const results = (FIXTURE_LISTINGS[code.toUpperCase()] || []).filter((l) => hostAllowed(l.url, tool.allowed_domains));
    return {
      id: 'msg_harness', type: 'message', role: 'assistant', model: params.model, stop_reason: 'end_turn',
      content: [
        { type: 'server_tool_use', id: 'srvtoolu_harness', name: 'web_search', input: { query: code } },
        { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_harness', content: results.map((r) => ({ type: 'web_search_result', url: r.url, title: r.title, page_age: null, encrypted_content: 'x' })) },
        { type: 'text', text: results.length ? 'Found it.' : 'not found', citations: results.map((r) => ({ type: 'web_search_result_location', url: r.url, title: r.title, cited_text: r.snippet, encrypted_index: 'x' })) },
      ],
      usage: { input_tokens: 900, output_tokens: 40, server_tool_use: { web_search_requests: 1 } },
    };
  }
};
FakeAnthropic.default = FakeAnthropic;
fakeModule(require.resolve('@anthropic-ai/sdk', { paths: [path.join(ROOT, 'api/_lib/workshop-stock')] }), FakeAnthropic);

// ── page fetch: production code, fixture transport ───────────────────────────

const safeFetch = require(at('api/_lib/workshop-stock/safe-fetch.js'));
const realFetchPage = safeFetch.fetchAllowlistedPage;
const pageFetches = [];
const FIXTURE_ADDRESS = '104.18.10.1'; // a public address, so the production DNS guard passes it

function fixtureRequest(url, opts, onResponse) {
  const req = new EventEmitter();
  req.destroy = (e) => { if (e) req.emit('error', e); req.emit('close'); return req; };
  req.end = () => {
    // Connect the way a socket would: through the production guarded lookup.
    opts.lookup(url.hostname, { all: true }, (err) => {
      if (err) { req.emit('error', err); return; }
      const html = FIXTURE_PAGES[url.toString()];
      pageFetches.push({ url: url.toString(), found: Boolean(html) });
      const res = Readable.from([html ? zlib.gzipSync(Buffer.from(html)) : Buffer.from('not found')]);
      res.statusCode = html ? 200 : 404;
      res.headers = html ? { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' } : { 'content-type': 'text/html' };
      onResponse(res);
    });
  };
  return req;
}
const fixtureLookup = (_host, _opts, cb) => cb(null, [{ address: FIXTURE_ADDRESS, family: 4 }]);
safeFetch.fetchAllowlistedPage = (url, opts = {}) => realFetchPage(url, { ...opts, request: fixtureRequest, lookup: fixtureLookup });

// ── photo storage stand-in (Blob) ────────────────────────────────────────────

const photoMod = require(at('api/_lib/workshop-stock/photo.js'));
const photoStore = new Map();
photoMod.storePhoto = async ({ tenantSlug, bytes, contentType }) => {
  const pathname = `workshop-stock/${tenantSlug}/photos/e2e-${crypto.randomBytes(8).toString('hex')}.${contentType === 'image/png' ? 'png' : 'jpg'}`;
  const url = `https://harness-blob.invalid/${pathname}`;
  photoStore.set(url, Buffer.from(bytes));
  return { url, pathname };
};
photoMod.fetchPhoto = async (url) => {
  const b = photoStore.get(url);
  if (!b) throw apiError(404, 'harness: photo gone');
  return b;
};
photoMod.deletePhoto = async (url) => { photoStore.delete(url); };

// ── the real handler ─────────────────────────────────────────────────────────

const handler = require(at('api/workshop-stock.js'));
const auth = require(at('api/_lib/auth.js'));
const postgres = require('postgres');
const sql = postgres(DB_URL, { max: 2, prepare: false, idle_timeout: 10 });

function vercelRes(res) {
  const out = {
    statusCode: 200,
    headersSent: false,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { res.setHeader(k, v); return this; },
    getHeader(k) { return res.getHeader(k); },
    json(body) {
      if (!res.getHeader('content-type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.statusCode = this.statusCode;
      this.headersSent = true;
      res.end(JSON.stringify(body));
      return this;
    },
    send(body) { return Buffer.isBuffer(body) || typeof body === 'string' ? this.end(body) : this.json(body); },
    end(body) { res.statusCode = this.statusCode; this.headersSent = true; res.end(body); return this; },
  };
  return out;
}

function readBody(req, limit = 6 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(apiError(413, 'too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function serveApi(url, req, res) {
  const raw = await readBody(req);
  let body;
  if (raw.length) {
    try { body = JSON.parse(raw.toString('utf8')); } catch { body = raw.toString('utf8'); }
  }
  const vreq = { method: req.method, url: req.url, query: Object.fromEntries(url.searchParams), headers: req.headers, body };
  await handler(vreq, vercelRes(res));
}

async function tenantId() {
  const rows = await sql`select id from public.tenants where slug = 'buhl'`;
  if (!rows.length) throw new Error("no 'buhl' tenant in the local database");
  return rows[0].id;
}

async function resetStock() {
  const t = await tenantId();
  await sql.begin(async (tx) => {
    // The ledger is append-only by trigger; a local superuser reset bypasses it.
    await tx`set local session_replication_role = replica`;
    await tx`delete from public.workshop_stock_movements where tenant_id = ${t}`;
    await tx`delete from public.workshop_stock_item_events where tenant_id = ${t}`;
    await tx`delete from public.workshop_stock_identifiers where tenant_id = ${t}`;
    await tx`delete from public.workshop_stock_items where tenant_id = ${t}`;
    await tx`delete from public.workshop_stock_photos where tenant_id = ${t}`;
    await tx`delete from public.workshop_stock_lookup_cache where tenant_id = ${t}`;
    await tx`delete from public.workshop_stock_usage where tenant_id = ${t}`;
  });
  visionQueue.length = 0;
  calls.vision.length = 0;
  calls.search.length = 0;
  pageFetches.length = 0;
  photoStore.clear();
  config.searchFail = null;
  seedBlob();
}

async function state() {
  const t = await tenantId();
  const items = await sql`select id, name, base_unit, balance_milli, version, estimated, location, photo_id, verification_status, archived_at from public.workshop_stock_items where tenant_id = ${t} order by created_at`;
  const movements = await sql`select id, item_id, kind, quantity_milli, balance_after_milli, counted_milli, reverses_movement_id, actor_name, idempotency_key, job_label, reason from public.workshop_stock_movements where tenant_id = ${t} order by created_at, id`;
  const photos = await sql`select id, purpose, byte_size, expires_at is not null as expires from public.workshop_stock_photos where tenant_id = ${t}`;
  const audit = [...blobMem.entries()].filter(([k]) => k.startsWith('audit/')).flatMap(([, v]) => (Array.isArray(v) ? v : (v && v.entries) || []));
  return {
    items: items.map((r) => ({ ...r, balance_milli: Number(r.balance_milli) })),
    movements: movements.map((r) => ({ ...r, quantity_milli: Number(r.quantity_milli), balance_after_milli: Number(r.balance_after_milli), counted_milli: r.counted_milli == null ? null : Number(r.counted_milli) })),
    photos,
    calls,
    pageFetches,
    visionQueued: visionQueue.length,
    blobKeys: [...blobMem.keys()],
    audit: audit.filter((e) => String(e && e.action).startsWith('workshop_stock.')).map((e) => ({ action: e.action, actor: e.actorName || e.actorId || null, targetId: e.targetId || null })),
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function control(url, req, res) {
  const raw = await readBody(req, 512 * 1024);
  const body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  switch (url.pathname) {
    case '/__harness/health':
      return sendJson(res, 200, { ok: true, tenant: await tenantId() });
    case '/__harness/reset':
      await resetStock();
      return sendJson(res, 200, { ok: true });
    case '/__harness/vision':
      for (const entry of body.queue || []) visionQueue.push(entry);
      return sendJson(res, 200, { queued: visionQueue.length });
    case '/__harness/config':
      if ('searchFail' in body) config.searchFail = body.searchFail || null;
      if ('lookup' in body) {
        if (body.lookup) delete process.env.STOCK_LOOKUP_DISABLED; else process.env.STOCK_LOOKUP_DISABLED = '1';
      }
      return sendJson(res, 200, { ok: true });
    case '/__harness/session': {
      const who = PEOPLE[url.searchParams.get('as') || ''];
      if (!who) return sendJson(res, 400, { error: 'unknown person' });
      const value = auth.signSession({ userId: who.id, role: who.role, name: who.name, username: who.username, exp: Date.now() + 6 * 3600_000 });
      return sendJson(res, 200, { name: 'buhl_session', value, person: who });
    }
    case '/__harness/state':
      return sendJson(res, 200, await state());
    default:
      return sendJson(res, 404, { error: 'unknown harness route' });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const run = url.pathname.startsWith('/__harness/') ? control(url, req, res)
    : url.pathname === '/api/workshop-stock' ? serveApi(url, req, res)
      : Promise.resolve(sendJson(res, 404, { error: 'not_found' }));
  run.catch((e) => {
    console.error('[stock-harness] request failed', e && e.message);
    if (!res.headersSent) sendJson(res, 500, { error: 'harness_error' });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[stock-harness] real /api/workshop-stock on http://localhost:${PORT} → local Postgres ${dbHost}`);
});
