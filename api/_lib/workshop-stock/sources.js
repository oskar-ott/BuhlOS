'use strict';

// Where Workshop Stock may look a product up — an ALLOWLIST, never "the web".
//
// Two kinds of source:
//   • manufacturer — the maker's own site. A code found on the maker's own
//     product page, for that maker's brand, is the strongest public evidence.
//   • supplier     — an Australian electrical wholesaler / trade retailer. Their
//     listings often carry the maker's code, but also their OWN SKU and their own
//     pack sizes; evidence from them is weighed accordingly (verify.js).
//
// The search provider is told to search ONLY these domains, and the page fetcher
// refuses any other host (including on every redirect hop). The owner can
// replace the list without a deploy-time code change through
// STOCK_LOOKUP_DOMAINS (see parseDomainsEnv) — e.g. to add a regional wholesaler.
// Pure.

const DEFAULT_SOURCES = Object.freeze([
  // manufacturers (brand keys as codes.brandKey produces them)
  { domain: 'clipsal.com', kind: 'manufacturer', brands: ['clipsal', 'schneider'] },
  { domain: 'se.com', kind: 'manufacturer', brands: ['schneider', 'clipsal'] },
  { domain: 'hpm.com.au', kind: 'manufacturer', brands: ['hpm'] },
  { domain: 'legrand.com.au', kind: 'manufacturer', brands: ['legrand', 'hpm'] },
  { domain: 'nhp.com.au', kind: 'manufacturer', brands: ['nhp'] },
  { domain: 'hager.com.au', kind: 'manufacturer', brands: ['hager'] },
  { domain: 'abb.com', kind: 'manufacturer', brands: ['abb'] },
  { domain: 'olex.com.au', kind: 'manufacturer', brands: ['olex'] },
  { domain: 'pierlite.com', kind: 'manufacturer', brands: ['pierlite'] },
  { domain: 'sal.net.au', kind: 'manufacturer', brands: ['sal'] },
  // Australian electrical wholesalers / trade retailers
  { domain: 'rexel.com.au', kind: 'supplier', brands: [] },
  { domain: 'jrt.com.au', kind: 'supplier', brands: [] },
  { domain: 'lh.com.au', kind: 'supplier', brands: [] },
  { domain: 'ebranch.online', kind: 'supplier', brands: [] },
  { domain: 'middys.com.au', kind: 'supplier', brands: [] },
  { domain: 'haymans.com.au', kind: 'supplier', brands: [] },
  { domain: 'cnw.com.au', kind: 'supplier', brands: [] },
  { domain: 'idealelectrical.com.au', kind: 'supplier', brands: [] },
  { domain: 'sparkydirect.com.au', kind: 'supplier', brands: [] },
]);

const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

/**
 * STOCK_LOOKUP_DOMAINS="clipsal.com=manufacturer:clipsal|schneider,rexel.com.au=supplier"
 * Returns the parsed list, or null when unset/blank. Malformed entries are skipped.
 */
function parseDomainsEnv(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const out = [];
  for (const part of raw.split(',')) {
    const [d, spec = 'supplier'] = part.trim().toLowerCase().split('=');
    if (!d || !DOMAIN_RE.test(d)) continue;
    const [kind, brands = ''] = spec.split(':');
    if (kind !== 'manufacturer' && kind !== 'supplier') continue;
    out.push({ domain: d, kind, brands: brands.split('|').map((b) => b.trim()).filter(Boolean) });
  }
  return out.length ? out : null;
}

function sourceList(env = process.env) {
  return parseDomainsEnv(env.STOCK_LOOKUP_DOMAINS) || DEFAULT_SOURCES;
}

/** The allowlisted source a hostname belongs to (exact domain or a subdomain of it), or null. */
function sourceForHost(hostname, sources = sourceList()) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h || !DOMAIN_RE.test(h)) return null;
  let best = null;
  for (const s of sources) {
    if (h === s.domain || h.endsWith('.' + s.domain)) {
      if (!best || s.domain.length > best.domain.length) best = s;
    }
  }
  return best;
}

/** Search domains, manufacturer domains for `brandKey` first (the provider caps the list). */
function searchDomains(brand, sources = sourceList()) {
  const makers = sources.filter((s) => s.kind === 'manufacturer' && brand && s.brands.includes(brand));
  const rest = sources.filter((s) => !makers.includes(s) && (s.kind === 'supplier' || !brand));
  return [...makers, ...rest].map((s) => s.domain).slice(0, 20);
}

module.exports = { DEFAULT_SOURCES, parseDomainsEnv, sourceList, sourceForHost, searchDomains };
