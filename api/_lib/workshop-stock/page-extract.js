'use strict';

// Product facts from ONE fetched HTML page (Workshop Stock lookup). Pure.
//
// The page is untrusted data. Nothing here executes it, follows its links, or
// hands its text to a model: we read the structured product data a retailer or
// maker publishes for search engines (JSON-LD Product, OpenGraph), the title and
// main heading, and a bounded copy of the visible text — then verify.js compares
// those against the code we hold, deterministically. Raw HTML never leaves the
// server and is never stored.

const MAX_TEXT = 120_000;
const MAX_FIELD = 300;

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d{1,6});/g, (_, n) => {
      const c = Number(n);
      return c > 31 && c < 0x10ffff ? String.fromCodePoint(c) : ' ';
    })
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => {
      const c = parseInt(h, 16);
      return c > 31 && c < 0x10ffff ? String.fromCodePoint(c) : ' ';
    });
}

function clip(v, max = MAX_FIELD) {
  if (v === null || v === undefined) return null;
  // eslint-disable-next-line no-control-regex
  const s = decodeEntities(String(v)).replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

function visibleText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

function asArray(v) {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function typeIs(node, name) {
  return asArray(node && node['@type']).some((t) => String(t).toLowerCase() === name);
}

function brandName(b) {
  if (!b) return null;
  if (typeof b === 'string') return clip(b, 80);
  if (typeof b === 'object') return clip(b.name, 80);
  return null;
}

function imageUrl(img) {
  const first = asArray(img)[0];
  if (!first) return null;
  if (typeof first === 'string') return clip(first, 1000);
  if (typeof first === 'object') return clip(first.url || first.contentUrl, 1000);
  return null;
}

/** Walk a parsed JSON-LD value (depth- and size-bounded) collecting Product nodes. */
function collectProducts(value, out, depth = 0) {
  if (depth > 6 || out.length >= 10 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value.slice(0, 50)) collectProducts(v, out, depth + 1);
    return;
  }
  if (typeIs(value, 'product') || typeIs(value, 'productmodel') || typeIs(value, 'individualproduct')) {
    const offers = asArray(value.offers)[0];
    out.push({
      name: clip(value.name),
      brand: brandName(value.brand) || brandName(value.manufacturer),
      sku: clip(value.sku, 80),
      mpn: clip(value.mpn, 80),
      model: typeof value.model === 'string' ? clip(value.model, 80) : clip(value.model && value.model.name, 80),
      productID: clip(value.productID, 80),
      gtin: clip(value.gtin14 || value.gtin13 || value.gtin12 || value.gtin8 || value.gtin, 20),
      color: clip(value.color, 60),
      description: clip(value.description, 600),
      image: imageUrl(value.image),
      offerSku: offers && typeof offers === 'object' ? clip(offers.sku, 80) : null,
    });
  }
  if (value['@graph']) collectProducts(value['@graph'], out, depth + 1);
  if (value.mainEntity) collectProducts(value.mainEntity, out, depth + 1);
}

function jsonLdProducts(html) {
  const out = [];
  const re = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  let blocks = 0;
  while ((m = re.exec(html)) && blocks < 20) {
    blocks += 1;
    const raw = m[1].trim().slice(0, 200_000);
    try {
      collectProducts(JSON.parse(raw), out);
    } catch {
      /* malformed JSON-LD is common — skip that block */
    }
  }
  return out;
}

function metaTags(html) {
  const meta = {};
  const re = /<meta\s+([^>]{1,2000})>/gi;
  let m;
  let n = 0;
  while ((m = re.exec(html)) && n < 300) {
    n += 1;
    const attrs = m[1];
    const key = /(?:property|name|itemprop)\s*=\s*["']([^"']{1,80})["']/i.exec(attrs);
    const content = /content\s*=\s*["']([^"']{0,2000})["']/i.exec(attrs);
    if (key && content && !(key[1].toLowerCase() in meta)) meta[key[1].toLowerCase()] = clip(content[1], 600);
  }
  return meta;
}

/**
 * @param {string} html
 * @returns {{ title, h1, products: Array<object>, og: { title, image, description }, meta: object, text: string }}
 */
function extractPageFacts(html) {
  const s = String(html || '').slice(0, 2_000_000);
  const title = clip((/<title[^>]*>([\s\S]{0,2000}?)<\/title>/i.exec(s) || [])[1]);
  const h1 = clip((/<h1[^>]*>([\s\S]{0,3000}?)<\/h1>/i.exec(s) || [])[1]);
  const meta = metaTags(s);
  return {
    title,
    h1,
    products: jsonLdProducts(s),
    og: { title: meta['og:title'] || null, image: meta['og:image'] || null, description: meta['og:description'] || null },
    meta: { mpn: meta['product:mpn'] || meta.mpn || null, brand: meta['product:brand'] || meta.brand || null, sku: meta['product:retailer_item_id'] || meta.sku || null },
    text: visibleText(s),
  };
}

module.exports = { extractPageFacts, visibleText, decodeEntities };
