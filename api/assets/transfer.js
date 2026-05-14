// POST /api/assets/transfer
// Admin can transfer any asset to any user (or null = back to storage).
// Tradie can transfer only an asset they currently hold to another tradie.

const { readBlob, writeBlob, setNoCache } = require('../_lib/blob');
const { requireAuth } = require('../_lib/auth');
const { trimStr, trimStrOrNull, isIsoOrNull, nowIso } = require('../_lib/validation');

function recordKey(id) { return `assets/${id}.json`; }
function historyKey(id) { return `assets/${id}/history.json`; }

async function appendHistory(id, entry) {
  const data = await readBlob(historyKey(id), { entries: [] });
  const entries = Array.isArray(data.entries) ? data.entries : [];
  entries.push(entry);
  await writeBlob(historyKey(id), { entries });
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const user = await requireAuth(req, res, { roles: ['admin', 'tradie'] });
  if (!user) return;

  const body = req.body || {};
  const assetId = trimStr(body.assetId, 100);
  if (!assetId) return res.status(400).json({ error: 'assetId required' });

  const asset = await readBlob(recordKey(assetId), null);
  if (!asset || asset.archived) return res.status(404).json({ error: 'asset not found' });

  const rawTo = body.toUserId;
  const toUserId = (rawTo === null || rawTo === undefined || rawTo === '')
    ? null
    : trimStrOrNull(rawTo, 100);

  if (user.role === 'tradie') {
    if (asset.currentHolderId !== user.id) {
      return res.status(403).json({ error: 'you do not hold this asset' });
    }
    if (!toUserId) {
      return res.status(403).json({ error: 'tradies cannot return assets to storage' });
    }
    const users = await readBlob('users.json', { users: [] });
    const target = (users.users || []).find(u => u.id === toUserId);
    if (!target || target.role !== 'tradie') {
      return res.status(400).json({ error: 'target must be a tradie' });
    }
  } else if (toUserId) {
    const users = await readBlob('users.json', { users: [] });
    const target = (users.users || []).find(u => u.id === toUserId);
    if (!target) return res.status(400).json({ error: 'target user not found' });
  }

  if (!isIsoOrNull(body.expectedReturn)) {
    return res.status(400).json({ error: 'expectedReturn must be ISO datetime or null' });
  }

  const at = nowIso();
  const from = asset.currentHolderId;
  asset.currentHolderId = toUserId;
  asset.assignedAt = toUserId ? at : null;
  asset.expectedReturn = toUserId ? (body.expectedReturn || null) : null;
  asset.updatedAt = at;

  await writeBlob(recordKey(assetId), asset);
  await appendHistory(assetId, {
    from: from || null,
    to: toUserId,
    at,
    byUserId: user.id,
    note: trimStrOrNull(body.note, 1000),
  });

  return res.status(200).json({ asset });
};
