// Supplier product references — saved entries pointing back to a
// supplier's product (manual entry or extracted from an allowed public
// URL via api/supplier-lookup.js).
//
// Storage: suppliers/<supplierId>/products.json
//   One file per supplier so list-reads stay cheap and supplier-scoped
//   lookups (the common case from the supplier detail drawer) don't
//   touch unrelated suppliers' data.
//
// Endpoints:
//   GET    ?supplierId=...               list products for a supplier
//   POST   ?supplierId=...               add product reference (manual or extracted)
//   PATCH  ?supplierId=...&id=...        edit product reference
//   DELETE ?supplierId=...&id=...        soft-delete (archived=true)
//
// Permissions:
//   admin       — full read + write
//   leadingHand — read-only on referenced products
//   tradie      — 403 (procurement-side, not a field surface)
//   client      — 403
//
// Important: prices stored here are reference values only. They MUST
// carry `lastCheckedAt` + `source` + `sourceUrl` so admin knows whether
// the price is recent, manually entered, or extracted from a page.

const { put, list } = require('@vercel/blob');
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');

const VALID_SOURCES = ['manual', 'url_lookup', 'import'];
const VALID_UNITS = ['ea', 'm', 'pkt', 'box', 'roll', 'pair', 'set', 'kg', 'l'];

function newId() {
  return 'sprod_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function trim(s, max) { return String(s || '').trim().slice(0, max || 500); }
function isValidUrl(s) {
  if (!s) return true;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) { return false; }
}

function sanitiseProduct(body, existing, user) {
  const now = new Date().toISOString();
  const out = existing ? { ...existing } : {
    id: newId(), archived: false, createdAt: now, createdBy: user.username,
  };
  if (body.name !== undefined) {
    const t = trim(body.name, 200);
    if (!t) return { error: 'name required' };
    out.name = t;
  }
  if (!out.name) return { error: 'name required' };

  if (body.brand       !== undefined) out.brand       = trim(body.brand, 100)       || null;
  if (body.partNumber  !== undefined) out.partNumber  = trim(body.partNumber, 100)  || null;
  if (body.category    !== undefined) out.category    = trim(body.category, 100)    || null;
  if (body.description !== undefined) out.description = trim(body.description, 2000) || null;
  if (body.publicUrl   !== undefined) {
    const u = trim(body.publicUrl, 1000);
    if (u && !isValidUrl(u)) return { error: 'publicUrl must be a valid http(s) URL' };
    out.publicUrl = u || null;
  }
  if (body.imageUrl !== undefined) {
    const u = trim(body.imageUrl, 1000);
    if (u && !isValidUrl(u)) return { error: 'imageUrl must be a valid http(s) URL' };
    out.imageUrl = u || null;
  }
  if (body.datasheetUrl !== undefined) {
    const u = trim(body.datasheetUrl, 1000);
    if (u && !isValidUrl(u)) return { error: 'datasheetUrl must be a valid http(s) URL' };
    out.datasheetUrl = u || null;
  }
  if (body.unit !== undefined) {
    const u = trim(body.unit, 20).toLowerCase();
    out.unit = u && VALID_UNITS.includes(u) ? u : (u || null);
  }
  if (body.price !== undefined) {
    if (body.price === null || body.price === '') {
      out.price = null;
    } else {
      const p = Number(body.price);
      if (!Number.isFinite(p) || p < 0) return { error: 'price must be a non-negative number or null' };
      out.price = Math.round(p * 100) / 100;
    }
  }
  if (body.priceNote !== undefined) out.priceNote = trim(body.priceNote, 200) || null;

  if (body.source !== undefined) {
    if (!VALID_SOURCES.includes(body.source)) return { error: 'invalid source' };
    out.source = body.source;
  } else if (!out.source) {
    out.source = 'manual';
  }
  if (body.sourceUrl !== undefined) {
    const u = trim(body.sourceUrl, 1000);
    if (u && !isValidUrl(u)) return { error: 'sourceUrl must be a valid http(s) URL' };
    out.sourceUrl = u || null;
  }
  // lastCheckedAt: explicit if provided, otherwise stamp the current time
  // when the source is url_lookup so admin can see when the page was last
  // visited. Manual entries don't stamp lastCheckedAt unless asked.
  if (body.lastCheckedAt !== undefined) {
    out.lastCheckedAt = body.lastCheckedAt || null;
  } else if (out.source === 'url_lookup' && !out.lastCheckedAt) {
    out.lastCheckedAt = now;
  }
  if (body.archived !== undefined) out.archived = !!body.archived;

  out.updatedAt = now;
  out.updatedBy = user.username;
  return { product: out };
}

function pathFor(supplierId) {
  return 'suppliers/' + supplierId + '/products.json';
}
async function readProducts(supplierId) {
  return (await readBlob(pathFor(supplierId), { products: [] })) || { products: [] };
}
async function writeProducts(supplierId, data) {
  await writeBlob(pathFor(supplierId), data);
}

// Confirm the supplier exists before letting anyone touch products on it.
async function supplierExists(supplierId) {
  const data = await readBlob('suppliers.json', { suppliers: [] });
  return (data.suppliers || []).some(s => s.id === supplierId);
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;
  if (user.role === 'client') return res.status(403).json({ error: 'forbidden' });
  if (user.role === 'tradie') return res.status(403).json({ error: 'admin/LH only' });

  const supplierId = (req.query && req.query.supplierId) || '';
  if (!supplierId) return res.status(400).json({ error: 'supplierId required' });
  if (!(await supplierExists(supplierId))) return res.status(404).json({ error: 'supplier not found' });

  if (req.method === 'GET') {
    const data = await readProducts(supplierId);
    const includeArchived = (req.query && req.query.archived) === '1';
    const list = (data.products || [])
      .filter(p => includeArchived ? true : !p.archived)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return res.status(200).json({ products: list });
  }

  // Mutations: admin only
  if (user.role !== 'admin') return res.status(403).json({ error: 'admin only' });

  if (req.method === 'POST') {
    const body = req.body || {};
    const parsed = sanitiseProduct(body, null, user);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    parsed.product.supplierId = supplierId;
    const data = await readProducts(supplierId);
    data.products = data.products || [];
    data.products.push(parsed.product);
    await writeProducts(supplierId, data);
    return res.status(201).json({ product: parsed.product });
  }

  const id = (req.query && req.query.id) || '';
  if (!id) return res.status(400).json({ error: 'id required' });

  if (req.method === 'PATCH') {
    const data = await readProducts(supplierId);
    const idx = (data.products || []).findIndex(p => p.id === id);
    if (idx < 0) return res.status(404).json({ error: 'product not found' });
    const parsed = sanitiseProduct(req.body || {}, data.products[idx], user);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    data.products[idx] = parsed.product;
    await writeProducts(supplierId, data);
    return res.status(200).json({ product: parsed.product });
  }

  if (req.method === 'DELETE') {
    const data = await readProducts(supplierId);
    const idx = (data.products || []).findIndex(p => p.id === id);
    if (idx < 0) return res.status(404).json({ error: 'product not found' });
    // Soft-delete so material records that linked to this product
    // reference don't orphan.
    data.products[idx].archived = true;
    data.products[idx].updatedAt = new Date().toISOString();
    data.products[idx].updatedBy = user.username;
    await writeProducts(supplierId, data);
    return res.status(200).json({ product: data.products[idx] });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
