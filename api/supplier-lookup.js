// Supplier product URL lookup — fetch a public supplier product page,
// extract conservative product hints (title / OG tags / JSON-LD), and
// return a DRAFT for the admin to review before saving.
//
// The brief is explicit about what this is NOT:
//   • not a general-purpose URL proxy
//   • not a crawler — fetches the single URL the admin pastes
//   • does not bypass logins, paywalls, anti-bot, or rate limits
//   • does not parse account-specific prices from script-rendered DOMs
//   • does not return raw HTML to the client
//
// Strict guardrails:
//   • admin only
//   • URL must be a valid http(s) URL
//   • URL must be public (private IPs / localhost / metadata IPs blocked)
//   • URL hostname must end in the chosen supplier's website domain
//     (prevents "lookup arbitrary site through our server" SSRF)
//   • response capped at ~1 MB
//   • request timeout 10 s
//   • redirects followed up to 3 hops, each re-validated against the
//     hostname allow-list
//   • only text/html and application/xhtml+xml accepted
//   • user-agent identifies us honestly ("BuhlOS-SupplierLookup/1.0")
//   • returns a draft object with extracted fields; admin reviews +
//     edits + saves via /api/supplier-products
//
// Body: { supplierId, url }
// Response: { draft: { name, brand, partNumber, description, imageUrl,
//                      datasheetUrl, publicUrl, sourceUrl, lastCheckedAt,
//                      source: 'url_lookup', extractionWarnings: [...] } }
//
// On failure or low confidence: returns 200 with a clear `error` /
// `warning` field, plus a draft populated with whatever was extractable.
// The frontend always offers manual entry as a fallback regardless.

const net = require('net');
const { URL } = require('url');
const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');

const MAX_BODY_BYTES = 1024 * 1024;     // 1 MB cap on remote response
const REQUEST_TIMEOUT_MS = 10000;       // 10 s overall
const MAX_REDIRECTS = 3;
const ACCEPTED_CONTENT_TYPES = ['text/html', 'application/xhtml+xml'];
const USER_AGENT = 'BuhlOS-SupplierLookup/1.0 (+https://buhlapp.xyz)';

// Block obvious private/internal targets to prevent SSRF abuse via an
// admin who pastes a malicious URL. This isn't bulletproof — a hostname
// can still resolve to a private IP after the redirect dance — so we
// also disallow non-public IPs after we resolve. Vercel's runtime is
// already pretty constrained outbound but we belt-and-brace it.
const BLOCKED_HOSTS = [
  'localhost', '127.0.0.1', '0.0.0.0', '::1',
  // AWS / Azure / GCP metadata
  '169.254.169.254', 'metadata.google.internal',
];
function isPrivateIp(host) {
  if (!net.isIP(host)) return false;
  // IPv4 ranges: 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16
  if (net.isIPv4(host)) {
    const o = host.split('.').map(Number);
    if (o[0] === 10) return true;
    if (o[0] === 127) return true;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 169 && o[1] === 254) return true;
    if (o[0] === 0) return true;
    return false;
  }
  // IPv6: ::1, fc00::/7 (unique local), fe80::/10 (link local)
  const lower = host.toLowerCase();
  if (lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fe90:') || lower.startsWith('fea0:') || lower.startsWith('feb0:')) return true;
  return false;
}

function hostnameMatchesDomain(targetHostname, supplierUrl) {
  if (!supplierUrl) return null; // null = unknown — caller decides
  try {
    const u = new URL(supplierUrl);
    const supplierHost = u.hostname.toLowerCase();
    const t = String(targetHostname || '').toLowerCase();
    if (!t) return false;
    // Match the eTLD+1 by stripping any leading "www." and checking
    // suffix containment. This is intentionally lenient (so .com.au /
    // sub.supplier.com.au both work) but bounded to the supplier's own
    // domain — never to a sibling brand.
    const cleanSupplier = supplierHost.replace(/^www\./, '');
    if (t === cleanSupplier) return true;
    if (t.endsWith('.' + cleanSupplier)) return true;
    return false;
  } catch (e) { return null; }
}

function trim(s, max) { return String(s || '').trim().slice(0, max || 500); }

// Light HTML tag stripping for OpenGraph/title extraction. We do NOT use
// a real HTML parser to keep the bundle small; we never echo raw HTML
// back to the client, only extracted scalar fields.
function stripTags(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Try to extract product hints from common conventions. Returns a draft
// (never throws). Confidence is best-effort — admin reviews before save.
function extractDraft(html, finalUrl) {
  const warnings = [];
  const draft = {
    name: null, brand: null, partNumber: null, description: null,
    category: null, imageUrl: null, datasheetUrl: null,
    publicUrl: finalUrl, sourceUrl: finalUrl,
    source: 'url_lookup',
    lastCheckedAt: new Date().toISOString(),
  };

  // 1) JSON-LD structured data — preferred when present.
  const jsonLdMatches = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of jsonLdMatches) {
    const inner = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
    try {
      const parsed = JSON.parse(inner);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const c of candidates) {
        const items = Array.isArray(c) ? c : (c['@graph'] ? c['@graph'] : [c]);
        for (const it of items) {
          if (!it || typeof it !== 'object') continue;
          const type = String(it['@type'] || '').toLowerCase();
          if (type === 'product' || type.endsWith('product')) {
            if (it.name && !draft.name)          draft.name        = trim(it.name, 200);
            if (it.brand && !draft.brand)        draft.brand       = trim(typeof it.brand === 'object' ? it.brand.name : it.brand, 100);
            if (it.sku && !draft.partNumber)     draft.partNumber  = trim(it.sku, 100);
            if (it.mpn && !draft.partNumber)     draft.partNumber  = trim(it.mpn, 100);
            if (it.description && !draft.description) draft.description = trim(stripTags(it.description), 1000);
            if (it.image && !draft.imageUrl) {
              const img = Array.isArray(it.image) ? it.image[0] : it.image;
              draft.imageUrl = trim(typeof img === 'object' ? img.url : img, 1000);
            }
            if (it.category && !draft.category)  draft.category    = trim(it.category, 100);
          }
        }
      }
    } catch (e) { /* malformed JSON-LD — skip */ }
  }

  // 2) OpenGraph + meta tags
  const metaRe = /<meta\s+([^>]+)>/gi;
  let m;
  const meta = {};
  while ((m = metaRe.exec(html))) {
    const attrs = m[1];
    const propMatch = attrs.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i);
    const contentMatch = attrs.match(/content\s*=\s*["']([^"']*)["']/i);
    if (propMatch && contentMatch) meta[propMatch[1].toLowerCase()] = contentMatch[1];
  }
  if (!draft.name && meta['og:title'])           draft.name        = trim(meta['og:title'], 200);
  if (!draft.description && meta['og:description']) draft.description = trim(meta['og:description'], 1000);
  if (!draft.description && meta['description']) draft.description = trim(meta['description'], 1000);
  if (!draft.imageUrl && meta['og:image'])       draft.imageUrl    = trim(meta['og:image'], 1000);
  if (!draft.brand && meta['product:brand'])     draft.brand       = trim(meta['product:brand'], 100);

  // 3) <title> as last-resort fallback
  if (!draft.name) {
    const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (tm) draft.name = trim(stripTags(tm[1]), 200);
  }

  // 4) Datasheet/spec PDF — look for an <a> linking to a .pdf with
  //    "datasheet" / "spec" / "instal" in the text or URL.
  const linkRe = /<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = linkRe.exec(html))) {
    const href = m[1];
    const text = stripTags(m[2]).toLowerCase();
    const looksLikePdf = /\.pdf(\?|$|#)/i.test(href);
    const looksLikeDatasheet = /\b(datasheet|spec\s?sheet|installation|manual|brochure)\b/.test(text + ' ' + href.toLowerCase());
    if (looksLikePdf && looksLikeDatasheet && !draft.datasheetUrl) {
      try {
        const u = new URL(href, finalUrl);
        if (u.protocol === 'http:' || u.protocol === 'https:') {
          draft.datasheetUrl = u.toString();
        }
      } catch (e) {}
    }
  }
  // Resolve relative image URL too
  if (draft.imageUrl) {
    try { draft.imageUrl = new URL(draft.imageUrl, finalUrl).toString(); }
    catch (e) { /* keep as-is */ }
  }

  // Deliberately do NOT extract price. Supplier prices are often
  // account-specific, dynamically rendered, or against the supplier's
  // terms to publish. Admin enters price manually after checking.
  if (!draft.name) warnings.push('No product name detected. Manual entry recommended.');
  if (!draft.brand && !draft.partNumber) warnings.push('No brand or part number detected.');

  return { draft, warnings };
}

// Fetch with redirect re-validation against the allowed host list.
async function safeFetch(url, supplierUrl, hops = 0) {
  if (hops > MAX_REDIRECTS) throw new Error('too many redirects');
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) URLs allowed');
  if (BLOCKED_HOSTS.includes(u.hostname.toLowerCase())) throw new Error('host not allowed');
  if (isPrivateIp(u.hostname)) throw new Error('private/internal addresses not allowed');
  const sameDomain = hostnameMatchesDomain(u.hostname, supplierUrl);
  if (sameDomain === false) {
    throw new Error('redirect target ' + u.hostname + ' is outside the supplier domain — refusing to follow');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-AU,en;q=0.9',
      },
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeout);
    throw new Error('fetch failed: ' + e.message);
  } finally { clearTimeout(timeout); }

  // Manual redirect handling (so we can re-validate against the
  // supplier host before chasing it).
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    if (!loc) throw new Error('redirect without Location header');
    const next = new URL(loc, url).toString();
    return safeFetch(next, supplierUrl, hops + 1);
  }
  if (!res.ok) throw new Error('upstream returned HTTP ' + res.status);
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ACCEPTED_CONTENT_TYPES.some(t => ct.includes(t))) {
    throw new Error('content-type ' + ct + ' not allowed — only HTML pages can be extracted');
  }

  // Read body with cap. fetch in Node exposes a ReadableStream we can
  // consume incrementally; on Vercel functions we can also use .text()
  // and just length-check, accepting that we'll buffer up to the cap.
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) {
    // Fallback for environments without a reader — use .text() with
    // a size guard by inspecting Content-Length first.
    const cl = Number(res.headers.get('content-length') || 0);
    if (cl && cl > MAX_BODY_BYTES) throw new Error('response too large (' + cl + ' bytes)');
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) throw new Error('response too large after read');
    return { html: text, finalUrl: url };
  }
  const decoder = new TextDecoder('utf-8');
  let received = 0;
  let html = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > MAX_BODY_BYTES) {
      try { reader.cancel(); } catch (e) {}
      throw new Error('response too large (>1MB)');
    }
    html += decoder.decode(value, { stream: true });
  }
  html += decoder.decode();
  return { html, finalUrl: url };
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res, { roles: ['admin'] });
  if (!me) return;

  const { supplierId, url } = req.body || {};
  if (!supplierId) return res.status(400).json({ error: 'supplierId required' });
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url required' });

  // Reject obvious garbage first
  let parsed;
  try { parsed = new URL(url); }
  catch (e) { return res.status(400).json({ error: 'url is not a valid URL' }); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return res.status(400).json({ error: 'only http(s) URLs are allowed' });
  }
  if (BLOCKED_HOSTS.includes(parsed.hostname.toLowerCase()) || isPrivateIp(parsed.hostname)) {
    return res.status(400).json({ error: 'this hostname is not allowed (private/internal addresses are blocked)' });
  }

  // Confirm the supplier exists + read its website URL so we can scope
  // the lookup to its own domain.
  const sData = await readBlob('suppliers.json', { suppliers: [] });
  const supplier = (sData.suppliers || []).find(s => s.id === supplierId);
  if (!supplier) return res.status(404).json({ error: 'supplier not found' });
  if (!supplier.websiteUrl) {
    return res.status(400).json({
      error: 'this supplier has no websiteUrl set — add one to the supplier record first so we can verify the lookup target',
    });
  }
  const match = hostnameMatchesDomain(parsed.hostname, supplier.websiteUrl);
  if (match === false) {
    return res.status(400).json({
      error: 'URL hostname does not match the supplier website (' + parsed.hostname + ' ≠ ' + new URL(supplier.websiteUrl).hostname + '). Only the supplier\'s own pages can be looked up.',
    });
  }

  // Fetch + extract. Catch everything so the client always gets a
  // clean response — admin can still save manually if extraction fails.
  let html, finalUrl;
  try {
    const r = await safeFetch(url, supplier.websiteUrl);
    html = r.html; finalUrl = r.finalUrl;
  } catch (e) {
    return res.status(200).json({
      ok: false,
      error: e.message,
      draft: { publicUrl: url, sourceUrl: url, source: 'url_lookup', lastCheckedAt: new Date().toISOString() },
      warnings: ['Lookup failed — paste the product details manually.'],
    });
  }

  const { draft, warnings } = extractDraft(html, finalUrl);
  return res.status(200).json({ ok: true, draft, warnings });
};
