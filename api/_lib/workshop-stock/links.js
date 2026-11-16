'use strict';

// Product links on a workshop item (owner pull 2026-11-15) — pure.
//
//   productUrl  the item's page at an online wholesaler
//   specUrl     the maker's own product / spec page, when there is one
//
// Two ways a link gets onto an item:
//   • from the SERVER's own online-check result, when a worker accepts that
//     check on a new item or the office records it on an existing one. Only a
//     page the check itself found is used: one whose code matched outright, or
//     the very listing the person accepted. Never over a link a person set.
//   • typed (or cleared) by the office — any http(s) page, not only the
//     allowlisted sites the check searches (the owner's wholesaler may not be
//     on it). Shown with rel="noopener noreferrer nofollow".

const MAX_LEN = 600;

/**
 * A link the app may store and show: http(s), a real host name, no
 * credentials, at most 600 characters. Returns the normalised URL, or null.
 */
function cleanLink(raw) {
  if (typeof raw !== 'string') return null;
  let t = raw.trim();
  if (!t) return null;
  // "www.rexel.com.au/p/123" pasted without the scheme
  if (!/^[a-z][a-z0-9+.-]*:/i.test(t) && /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$|\?|#)/i.test(t)) t = `https://${t}`;
  let u;
  try { u = new URL(t); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  // a public name: has a dot, isn't an IP literal or localhost
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.startsWith('[') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return null;
  const s = u.toString();
  return s.length <= MAX_LEN ? s : null;
}

const GOOD = { manufacturer_code_matched: 2, possible_match: 1 };

/**
 * The wholesaler page and the maker's page a check found, for the item that
 * accepted it: { productUrl, specUrl } (each null when the check found none).
 * A source row counts when its own code matched, or when it is the listing the
 * check put forward (the candidate the person accepted). Opened pages first.
 */
function linksFromLookup(result) {
  const out = { productUrl: null, specUrl: null };
  if (!result || !GOOD[result.status] || !result.candidate) return out;
  const accepted = result.candidate.sourceUrl || null;
  const rows = (Array.isArray(result.sources) ? result.sources : [])
    .filter((s) => s && typeof s.url === 'string' && (s.verdict === 'manufacturer_code_matched' || (accepted && s.url === accepted)));
  // the accepted listing itself, even if the summary rows were trimmed
  if (accepted && !rows.some((s) => s.url === accepted)) {
    rows.push({ url: accepted, kind: result.candidate.sourceKind, opened: result.candidate.evidence === 'page', verdict: result.status });
  }
  rows.sort((a, b) => (Number(b.verdict === 'manufacturer_code_matched') - Number(a.verdict === 'manufacturer_code_matched')) || (Number(Boolean(b.opened)) - Number(Boolean(a.opened))));
  for (const s of rows) {
    const url = cleanLink(s.url);
    if (!url) continue;
    if (s.kind === 'supplier' && !out.productUrl) out.productUrl = url;
    if (s.kind === 'manufacturer' && !out.specUrl) out.specUrl = url;
  }
  return out;
}

module.exports = { cleanLink, linksFromLookup, MAX_LEN };
