'use strict';

// Search provider for Workshop Stock product lookup — the ONE place that talks
// to a search service, so it can be swapped without touching the rest.
//
// Provider: Anthropic's server-side web search tool (a real search engine run on
// Anthropic's side — results carry real URLs and titles), reached with the same
// ANTHROPIC_API_KEY the field receipt reader already uses. No new vendor, no
// scraping of a search engine, no credentials invented. Constrained hard:
//   • allowed_domains = the source allowlist (sources.js) — the search cannot
//     return anything else
//   • max_uses 2 searches per lookup ($10 per 1,000 searches + tokens)
//   • the query names only the brand and the code, both already validated to a
//     strict alphabet (codes.js) — photo text never reaches the prompt verbatim
//   • the model's prose is IGNORED. We harvest the search-result blocks (URL,
//     title, page age) and the verbatim cited snippets, nothing it "concludes".
//     Verification is deterministic code over pages we fetch ourselves
//     (safe-fetch.js → page-extract.js → verify.js).
// A search snippet is preliminary evidence only; verify.js never lets a listing
// alone produce "manufacturer code matched".

const { cleanCode, squash } = require('./codes');

// The same house model as the photo readers (invoices/vision-extract.js) unless
// STOCK_LOOKUP_MODEL overrides it.
const LOOKUP_MODEL = process.env.STOCK_LOOKUP_MODEL || require('../invoices/vision-extract').VISION_MODEL;
const SEARCH_TOOL_TYPE = process.env.STOCK_LOOKUP_SEARCH_TOOL || 'web_search_20250305';
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_SEARCHES = 2;
const MAX_LISTINGS = 12;

class SearchUnavailableError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function enabled(env = process.env) {
  return Boolean(env.ANTHROPIC_API_KEY) && env.STOCK_LOOKUP_DISABLED !== '1';
}

let _client = null;
function client() {
  if (!_client) {
    const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 });
  }
  return _client;
}

function cleanBrandForQuery(brand) {
  const s = squash(brand, 40);
  return s && /^[A-Za-z0-9][A-Za-z0-9 &.'-]{0,39}$/.test(s) ? s : null;
}

/**
 * Pull listings out of a Messages API response. Pure — exported for tests.
 * @returns {{ listings: Array<{ url, title, pageAge, snippets: string[] }>, searches: number, errors: string[] }}
 */
function harvest(msg) {
  const byUrl = new Map();
  const errors = [];
  let searches = 0;
  for (const block of (msg && msg.content) || []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'server_tool_use' && block.name === 'web_search') searches += 1;
    if (block.type === 'web_search_tool_result') {
      if (Array.isArray(block.content)) {
        for (const r of block.content) {
          if (!r || r.type !== 'web_search_result' || typeof r.url !== 'string') continue;
          if (!byUrl.has(r.url) && byUrl.size < MAX_LISTINGS) {
            byUrl.set(r.url, { url: r.url.slice(0, 1000), title: squash(r.title, 300), pageAge: squash(r.page_age, 60), snippets: [] });
          }
        }
      } else if (block.content && typeof block.content === 'object' && block.content.error_code) {
        errors.push(String(block.content.error_code).slice(0, 40));
      }
    }
    if (block.type === 'text' && Array.isArray(block.citations)) {
      for (const c of block.citations) {
        if (!c || c.type !== 'web_search_result_location' || typeof c.url !== 'string') continue;
        const l = byUrl.get(c.url);
        const snippet = squash(c.cited_text, 200);
        if (l && snippet && l.snippets.length < 3) l.snippets.push(snippet);
      }
    }
  }
  return { listings: [...byUrl.values()], searches, errors };
}

/**
 * Search the allowlisted domains for a product code.
 * @param {{ brand?: string|null, manufacturerCode: string }} wanted
 * @param {{ domains: string[], client?: object }} opts
 * @throws {SearchUnavailableError} when the provider cannot be reached / refuses
 */
async function searchListings(wanted, { domains, client: injected } = {}) {
  const code = cleanCode(wanted.manufacturerCode);
  if (!code) throw new SearchUnavailableError('no_code');
  const brand = cleanBrandForQuery(wanted.brand);
  const c = injected || client();
  const prompt =
    `Find the product listing for the Australian electrical product with manufacturer code "${code}"` +
    (brand ? ` by ${brand}` : '') +
    '. Search for the exact code. Then reply with one short sentence naming the page you found, or "not found".';
  let msg;
  try {
    msg = await c.beta.messages.create({
      model: LOOKUP_MODEL,
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      tools: [{
        type: SEARCH_TOOL_TYPE,
        name: 'web_search',
        max_uses: MAX_SEARCHES,
        allowed_domains: domains,
        user_location: { type: 'approximate', country: 'AU', timezone: 'Australia/Sydney' },
      }],
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (e) {
    const status = e && typeof e.status === 'number' ? e.status : 0;
    throw new SearchUnavailableError(status === 429 ? 'rate_limited' : status === 400 ? 'search_rejected' : status ? `http_${status}` : 'unreachable');
  }
  if (!msg || msg.stop_reason === 'refusal') throw new SearchUnavailableError('declined');
  const out = harvest(msg);
  if (!out.listings.length && out.errors.length) throw new SearchUnavailableError(out.errors[0]);
  out.usage = msg.usage
    ? { input: msg.usage.input_tokens, output: msg.usage.output_tokens, searches: (msg.usage.server_tool_use && msg.usage.server_tool_use.web_search_requests) || out.searches, model: msg.model || LOOKUP_MODEL }
    : null;
  return out;
}

module.exports = { searchListings, harvest, enabled, SearchUnavailableError, LOOKUP_MODEL, SEARCH_TOOL_TYPE, MAX_SEARCHES };
