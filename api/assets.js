// Global assets (vehicles, keys, tools, PPE) assigned to people.
// Storage: assets/<assetId>.json for record + assets/<assetId>/history.json for transfers.
// One file per asset so transfers stay atomic; history lives next to the record.

const { list } = require('@vercel/blob');
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');
const {
  requireFields, trimStr, trimStrOrNull,
  newId, nowIso, ASSET_TYPES,
} = require('./_lib/validation');

const token = () => process.env.BLOB_READ_WRITE_TOKEN;

function recordKey(id) { return `assets/${id}.json`; }
function historyKey(id) { return `assets/${id}/history.json`; }

// List all asset record blobs (not history files). Record pathnames match assets/<id>.json — exactly one slash.
async function listAllAssets() {
  try {
    const { blobs } = await list({ prefix: 'assets/', token: token() });
    const records = [];
    for (const b of blobs) {
      const rest = b.pathname.slice('assets/'.length);
      if (!rest.endsWith('.json')) continue;
      if (rest.includes('/')) continue; // history files live under assets/<id>/...
      try {
        const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
        if (r.ok) records.push(await r.json());
      } catch {}
    }
    return records;
  } catch (e) {
    console.error('listAllAssets error', e.message);
    return [];
  }
}

async function readHistory(id) {
  const data = await readBlob(historyKey(id), { entries: [] });
  return Array.isArray(data.entries) ? data.entries : [];
}

async function appendHistory(id, entry) {
  const entries = await readHistory(id);
  entries.push(entry);
  await writeBlob(historyKey(id), { entries });
}

function sanitizeAsset(input, base = {}) {
  return {
    id: base.id,
    name: trimStr(input.name ?? base.name, 200),
    type: ASSET_TYPES.includes(input.type) ? input.type : (base.type || 'other'),
    identifier: trimStrOrNull(input.identifier ?? base.identifier, 200),
    notes: trimStrOrNull(input.notes ?? base.notes, 2000),
    currentHolderId: base.currentHolderId ?? null,
    assignedAt: base.assignedAt ?? null,
    expectedReturn: base.expectedReturn ?? null,
    createdAt: base.createdAt,
    updatedAt: nowIso(),
    archived: base.archived ?? false,
  };
}

function visibleToUser(asset, user) {
  if (user.role === 'admin') return true;
  if (user.role === 'tradie') return asset.currentHolderId === user.id;
  return false;
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res, { roles: ['admin', 'tradie'] });
  if (!user) return;

  const { id } = req.query || {};

  // GET single — includes history (admin sees always, tradie only if they hold it)
  if (req.method === 'GET' && id) {
    const asset = await readBlob(recordKey(id), null);
    if (!asset) return res.status(404).json({ error: 'asset not found' });
    if (!visibleToUser(asset, user)) return res.status(403).json({ error: 'forbidden' });
    const history = await readHistory(id);
    return res.status(200).json({ asset, history });
  }

  // GET list
  if (req.method === 'GET') {
    const all = await listAllAssets();
    const visible = all.filter(a => !a.archived && visibleToUser(a, user));
    visible.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return res.status(200).json({ assets: visible });
  }

  // Writes — admin only beyond this point
  if (user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });

  if (req.method === 'POST') {
    const body = req.body || {};
    const err = requireFields(body, ['name']);
    if (err) return res.status(400).json({ error: err });
    if (body.type && !ASSET_TYPES.includes(body.type)) {
      return res.status(400).json({ error: 'invalid type' });
    }
    const assetId = newId('asset');
    const now = nowIso();
    const asset = sanitizeAsset(body, { id: assetId, createdAt: now });
    asset.id = assetId;
    await writeBlob(recordKey(assetId), asset);
    await writeBlob(historyKey(assetId), { entries: [{
      from: null, to: null, at: now, byUserId: user.id, note: 'Asset created',
    }]});
    return res.status(200).json({ asset });
  }

  if (req.method === 'PUT') {
    if (!id) return res.status(400).json({ error: 'id required' });
    const existing = await readBlob(recordKey(id), null);
    if (!existing) return res.status(404).json({ error: 'asset not found' });
    const body = req.body || {};
    // PUT cannot change currentHolderId — use /transfer
    const updated = sanitizeAsset(body, existing);
    updated.id = id;
    await writeBlob(recordKey(id), updated);
    return res.status(200).json({ asset: updated });
  }

  if (req.method === 'DELETE') {
    if (!id) return res.status(400).json({ error: 'id required' });
    const existing = await readBlob(recordKey(id), null);
    if (!existing) return res.status(404).json({ error: 'asset not found' });
    existing.archived = true;
    existing.updatedAt = nowIso();
    await writeBlob(recordKey(id), existing);
    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
};
