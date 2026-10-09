'use strict';

// External product verification for a NEW workshop item — the service boundary.
//
//   search (search.js, allowlisted domains)  → candidate listings
//   fetch  (safe-fetch.js, ≤3 pages, allowlisted, public addresses only)
//   read   (page-extract.js — structured data, title, visible text)
//   judge  (verify.js — exact code rules, brand, colour/rating conflicts)
//
// Result statuses (what the worker sees):
//   manufacturer_code_matched  a retrieved page confirms the exact code
//   possible_match             evidence, but something is unconfirmed or conflicts
//   no_match                   nothing found for this code
//   unavailable                the search/pages couldn't be reached right now
//   not_configured             no search provider configured (ANTHROPIC_API_KEY)
//   not_checked                no usable code to check against
// Every failure is a status, never an exception: a lookup can only ever ADD
// information to the add-stock form. Manual saving never waits on it.
//
// Pure orchestration: every external call is an injected dependency, so tests
// run the real decision logic with no network.

const { cleanCode, codeKey, brandKey, isWeakCode } = require('./codes');
const { sourceList, sourceForHost, searchDomains } = require('./sources');
const { verifyPage, verifyListing } = require('./verify');
const { extractPageFacts } = require('./page-extract');

const MAX_PAGES = 3;
const BUDGET_MS = 20_000;

const RANK = { manufacturer_code_matched: 3, possible_match: 2, no_match: 1 };

/** Drop tracking/session noise so one product page isn't fetched twice. Pure. */
function canonicalUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = '';
    u.pathname = u.pathname.replace(/;jsessionid=[^/]*/i, '').replace(/;sid=[^/]*/i, '');
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|gclid|fbclid|sid$|sessionid)/i.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return null;
  }
}

/** An image the browser may load: https, on an allowlisted host. Else null. */
function safeImageUrl(raw, base, sources) {
  if (!raw) return null;
  try {
    const u = new URL(raw, base);
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
    if (!sourceForHost(u.hostname, sources)) return null;
    const s = u.toString();
    return s.length <= 1000 ? s : null;
  } catch {
    return null;
  }
}

function summarise(sourceRows) {
  return sourceRows.map((s) => ({ url: s.url, title: s.title, domain: s.domain, kind: s.kind, opened: s.opened, verdict: s.verdict, error: s.error || null }));
}

/**
 * @param {{ brand?, manufacturerCode, colourFinish?, variantDetails? }} wanted
 * @param {{ search: Function, fetchPage: Function, now?: () => number, sources?: object[], configured?: boolean }} deps
 */
async function lookupProduct(wanted, deps) {
  const now = deps.now || (() => Date.now());
  const started = now();
  const code = cleanCode(wanted.manufacturerCode);
  const base = { provider: 'anthropic_web_search', checkedAt: new Date(started).toISOString(), code };
  if (!code) return { ...base, status: 'not_checked', reasons: ['No manufacturer code to check — type it from the label to check online'], candidate: null, sources: [] };
  if (deps.configured === false) return { ...base, status: 'not_configured', reasons: ['The online product check isn\'t set up'], candidate: null, sources: [] };

  const sources = deps.sources || sourceList();
  const bKey = brandKey(wanted.brand);
  let found;
  try {
    found = await deps.search({ brand: wanted.brand || null, manufacturerCode: code }, { domains: searchDomains(bKey, sources) });
  } catch (e) {
    return { ...base, status: 'unavailable', reasons: ['Couldn\'t search online right now — save it and check later'], errorCode: (e && e.code) || 'search_failed', candidate: null, sources: [] };
  }

  // Keep allowlisted https listings only (the provider was told the same; we check again).
  const seen = new Set();
  const listings = [];
  for (const l of found.listings || []) {
    const url = canonicalUrl(l.url);
    if (!url || seen.has(url)) continue;
    let host;
    try { host = new URL(url); } catch { continue; }
    if (host.protocol !== 'https:') continue;
    const source = sourceForHost(host.hostname, sources);
    if (!source) continue;
    seen.add(url);
    listings.push({ ...l, url, source });
  }
  if (!listings.length) {
    return { ...base, status: 'no_match', reasons: ['No listing found for this code on the maker and wholesaler sites we check'], candidate: null, sources: [], searches: found.searches || 0 };
  }

  // Open the most promising pages first: the maker's own site for this brand,
  // then listings whose title already shows the code.
  const wantKey = codeKey(code);
  const titleHasCode = (l) => verifyListing({ manufacturerCode: code }, l).verdict !== 'no_match';
  listings.sort((a, b) => {
    const am = a.source.kind === 'manufacturer' && (!bKey || a.source.brands.includes(bKey)) ? 1 : 0;
    const bm = b.source.kind === 'manufacturer' && (!bKey || b.source.brands.includes(bKey)) ? 1 : 0;
    if (am !== bm) return bm - am;
    return Number(titleHasCode(b)) - Number(titleHasCode(a));
  });

  const rows = [];
  for (const l of listings) {
    const row = { url: l.url, title: l.title, domain: l.source.domain, kind: l.source.kind, opened: false, verdict: 'no_match', result: null };
    const canOpen = rows.filter((r) => r.opened || r.error).length < MAX_PAGES && now() - started < BUDGET_MS;
    if (canOpen) {
      try {
        const page = await deps.fetchPage(l.url, { sources });
        const facts = extractPageFacts(page.body);
        const source = page.source || l.source;
        row.opened = true;
        row.url = page.finalUrl || l.url;
        row.result = verifyPage(wanted, facts, source);
        row.verdict = row.result.verdict;
        if (row.result.candidate) row.result.candidate.imageUrl = safeImageUrl(row.result.candidate.imageUrl, row.url, sources);
      } catch (e) {
        row.error = (e && e.code) || 'fetch_failed';
      }
    }
    if (!row.opened) {
      row.result = verifyListing(wanted, l);
      row.verdict = row.result.verdict;
    }
    rows.push(row);
  }

  const ranked = rows.filter((r) => r.result && r.verdict !== 'no_match')
    .sort((a, b) => (RANK[b.verdict] - RANK[a.verdict]) || (Number(b.opened) - Number(a.opened)) || (Number(b.kind === 'manufacturer') - Number(a.kind === 'manufacturer')));
  if (!ranked.length) {
    const anyOpened = rows.some((r) => r.opened);
    return {
      ...base,
      status: 'no_match',
      reasons: [anyOpened ? 'The pages found don\'t show this exact code' : 'Listings were found but couldn\'t be opened to check the code'],
      candidate: null,
      sources: summarise(rows),
      searches: found.searches || 0,
    };
  }

  const best = ranked[0];
  let status = best.verdict;
  const reasons = [...(best.result.reasons || [])];

  // Sources that disagree on a printed fact for the SAME exact code: show it.
  const exactOpened = ranked.filter((r) => r.opened && r.result.codeMatch === 'exact');
  const colours = new Set(exactOpened.map((r) => (r.result.candidate && r.result.candidate.colour ? String(r.result.candidate.colour).toLowerCase() : null)).filter(Boolean));
  if (colours.size > 1) {
    status = 'possible_match';
    reasons.push(`Sources disagree on the colour (${[...colours].join(' / ')})`);
  }
  if (status === 'manufacturer_code_matched' && isWeakCode(code)) status = 'possible_match';

  return {
    ...base,
    status,
    reasons,
    candidate: {
      ...best.result.candidate,
      sourceUrl: best.url,
      sourceTitle: best.title || null,
      sourceDomain: best.domain,
      sourceKind: best.kind,
      evidence: best.opened ? 'page' : 'listing',
      codeAsWritten: best.result.candidate ? best.result.candidate.code : null,
      matchedOn: best.result.where || null,
    },
    conflicts: best.result.conflicts || [],
    unconfirmed: best.result.unconfirmed || [],
    sources: summarise(rows),
    searches: found.searches || 0,
    codeKey: wantKey,
  };
}

module.exports = { lookupProduct, canonicalUrl, safeImageUrl, MAX_PAGES };
