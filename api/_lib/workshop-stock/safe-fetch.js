'use strict';

// Fetch ONE allowlisted public product page, safely (Workshop Stock lookup).
//
// This is not a proxy and not a crawler. The guardrails, all enforced here:
//   • https only, default port only, no user:pass@ in the URL
//   • the host must belong to the source allowlist (sources.js) — checked on the
//     first URL AND on every redirect hop (max 3), so an allowlisted page cannot
//     bounce the server somewhere else
//   • the address is checked AT CONNECT TIME through a custom DNS lookup: every
//     resolved address must be public (no loopback, private, link-local, CGNAT,
//     multicast, reserved, documentation, metadata or IPv4-mapped/NAT64 forms of
//     those). Checking inside the socket's own lookup — not before it — closes the
//     DNS-rebinding gap of "resolve, check, then fetch by name".
//   • bounded: 8 s overall, 1.5 MB after decompression (a compressed bomb is cut
//     off by the same counter), HTML content types only
//   • no cookies sent or kept; an honest User-Agent
// The body is returned as text for page-extract.js, which treats it as
// untrusted data; nothing from it is ever executed or followed automatically.

const https = require('https');
const dns = require('dns');
const net = require('net');
const zlib = require('zlib');
const { sourceForHost } = require('./sources');

const TIMEOUT_MS = 8_000;
const MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'BuhlOS-WorkshopStock/1.0 (+https://buhlos.com; product code check)';
const HTML_TYPES = ['text/html', 'application/xhtml+xml'];

class SafeFetchError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// ── address policy ────────────────────────────────────────────────────────────

const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const V6_BLOCKS = [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
  ['2001:db8::', 32], ['100::', 64], ['2001::', 23], ['2002::', 16],
];
const blockList = new net.BlockList();
for (const [a, p] of V4_BLOCKS) blockList.addSubnet(a, p, 'ipv4');
for (const [a, p] of V6_BLOCKS) blockList.addSubnet(a, p, 'ipv6');

function embeddedV4(ip) {
  const lower = ip.toLowerCase();
  // ::ffff:a.b.c.d / ::ffff:7f00:1 (IPv4-mapped) and 64:ff9b::a.b.c.d (NAT64)
  const m = /^(?:::ffff:|64:ff9b::)(.+)$/.exec(lower) || /^::ffff:0:(.+)$/.exec(lower);
  if (!m) return null;
  const tail = m[1];
  if (net.isIPv4(tail)) return tail;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

/** True when an address must never be contacted. Pure. */
function isBlockedAddress(ip) {
  if (typeof ip !== 'string') return true;
  if (net.isIPv4(ip)) return blockList.check(ip, 'ipv4') || ip === '255.255.255.255';
  if (net.isIPv6(ip)) {
    const v4 = embeddedV4(ip);
    if (v4) return isBlockedAddress(v4);
    if (/^64:ff9b:/i.test(ip)) return true;
    return blockList.check(ip, 'ipv6');
  }
  return true;
}

// ── URL policy ────────────────────────────────────────────────────────────────

/** Validate a URL against the fetch policy. Returns { url, source } or throws SafeFetchError. */
function checkUrl(raw, sources) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new SafeFetchError('url_invalid');
  }
  if (u.protocol !== 'https:') throw new SafeFetchError('scheme_not_allowed');
  if (u.username || u.password) throw new SafeFetchError('credentials_in_url');
  if (u.port && u.port !== '443') throw new SafeFetchError('port_not_allowed');
  const host = u.hostname.toLowerCase();
  if (!host || net.isIP(host.replace(/^\[|\]$/g, ''))) throw new SafeFetchError('ip_host_not_allowed');
  const source = sourceForHost(host, sources);
  if (!source) throw new SafeFetchError('host_not_allowlisted');
  u.hash = '';
  return { url: u, source };
}

function guardedLookup(lookupImpl) {
  return (hostname, options, callback) => {
    const opts = typeof options === 'object' && options ? options : {};
    lookupImpl(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIPv6(addresses) ? 6 : 4 }];
      if (!list.length) return callback(new SafeFetchError('dns_empty'));
      for (const a of list) {
        if (isBlockedAddress(a.address)) return callback(new SafeFetchError('address_not_public', `refusing ${hostname}: non-public address`));
      }
      if (opts.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

function decoderFor(contentType) {
  const m = /charset=([\w-]+)/i.exec(contentType || '');
  try {
    return new TextDecoder(m ? m[1].toLowerCase() : 'utf-8', { fatal: false });
  } catch {
    return new TextDecoder('utf-8', { fatal: false });
  }
}

function requestOnce(url, { request, lookup, deadline }) {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new SafeFetchError('timeout'));
    const req = request(url, {
      method: 'GET',
      lookup: guardedLookup(lookup),
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml;q=0.9',
        'Accept-Language': 'en-AU,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      timeout: remaining,
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400) {
        res.resume();
        return resolve({ redirect: res.headers.location || null, status });
      }
      if (status !== 200) {
        res.resume();
        return reject(new SafeFetchError('http_status', `upstream ${status}`));
      }
      const contentType = String(res.headers['content-type'] || '').toLowerCase();
      if (!HTML_TYPES.some((t) => contentType.includes(t))) {
        res.resume();
        return reject(new SafeFetchError('content_type_not_allowed'));
      }
      const declared = Number(res.headers['content-length'] || 0);
      const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
      if (!encoding && declared > MAX_BYTES) {
        res.resume();
        return reject(new SafeFetchError('too_large'));
      }
      let stream = res;
      if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      else if (encoding && encoding !== 'identity') {
        res.resume();
        return reject(new SafeFetchError('encoding_not_supported'));
      }
      const chunks = [];
      let received = 0;
      let done = false;
      stream.on('data', (chunk) => {
        if (done) return;
        received += chunk.length;
        if (received > MAX_BYTES) {
          done = true;
          req.destroy();
          return reject(new SafeFetchError('too_large'));
        }
        chunks.push(chunk);
      });
      stream.on('end', () => {
        if (done) return;
        done = true;
        resolve({ status, contentType, body: decoderFor(contentType).decode(Buffer.concat(chunks)) });
      });
      stream.on('error', (e) => {
        if (done) return;
        done = true;
        reject(new SafeFetchError('read_failed', e && e.message));
      });
    });
    // Socket inactivity AND a hard wall-clock stop, so a slow-drip server cannot hold the request open.
    const wall = setTimeout(() => req.destroy(new SafeFetchError('timeout')), remaining);
    if (typeof wall.unref === 'function') wall.unref();
    req.on('close', () => clearTimeout(wall));
    req.on('timeout', () => req.destroy(new SafeFetchError('timeout')));
    req.on('error', (e) => reject(e instanceof SafeFetchError ? e : new SafeFetchError(e && e.code === 'ENOTFOUND' ? 'dns_failed' : 'fetch_failed', e && e.message)));
    req.end();
  });
}

/**
 * GET one allowlisted page. Resolves { finalUrl, source, contentType, body };
 * rejects with SafeFetchError (stable `code`) on any policy or network failure.
 * `deps` lets tests inject `request` (https.request shape) and `lookup` (dns.lookup shape).
 */
async function fetchAllowlistedPage(rawUrl, { sources, request = https.request, lookup = dns.lookup, timeoutMs = TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let { url, source } = checkUrl(rawUrl, sources);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const r = await requestOnce(url, { request, lookup, deadline });
    if (r.redirect === undefined) {
      return { finalUrl: url.toString(), source, contentType: r.contentType, body: r.body };
    }
    if (!r.redirect) throw new SafeFetchError('redirect_without_location');
    if (hop === MAX_REDIRECTS) throw new SafeFetchError('too_many_redirects');
    ({ url, source } = checkUrl(new URL(r.redirect, url).toString(), sources));
  }
  throw new SafeFetchError('too_many_redirects');
}

module.exports = { fetchAllowlistedPage, checkUrl, isBlockedAddress, SafeFetchError, MAX_BYTES, TIMEOUT_MS };
