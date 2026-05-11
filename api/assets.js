// Assets — company-owned items (vehicles, keys, tools, accessories, PPE)
// assigned to people. Separate from jobs and timesheets.
//
// Storage:
//   assets/<id>.json            — the asset record (one file per asset)
//   assets/<id>/history.json    — append-only transfer log for that asset
//
// Why two files instead of one with embedded history: history grows
// unbounded as the asset moves between people, and most reads of the
// asset don't need it. Keeping history in a sibling blob means the
// list view stays fast (one file per asset, no nested array bloat)
// and detail-view reads pay only for the history they show.
//
// Permissions (matches the rest of BuhlOS):
//   admin       — full access (list all, edit, transfer anywhere, archive)
//   leadingHand — same surface as tradie (sees + transfers held assets);
//                 LH-level admin powers would be a future expansion
//   tradie      — sees ONLY the assets where currentHolderId === their id;
//                 can transfer something they currently hold to another
//                 tradie (or back to storage)
//   client      — 403 everywhere

const { put, list } = require('@vercel/blob');
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');

const VALID_TYPES = ['vehicle', 'key', 'tool', 'accessory', 'ppe', 'other'];

function newAssetId() {
  return 'a_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function newHistoryId() {
  return 'h_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function sanitiseAsset(body, existing) {
  // Coerce + clamp inputs. Existing fields pass through if the caller
  // didn't supply them so PUT acts like a real patch.
  const next = existing ? { ...existing } : {};
  if (body.name !== undefined) {
    const t = String(body.name || '').trim().slice(0, 120);
    if (!t) return { error: 'name must be a non-empty string' };
    next.name = t;
  }
  if (body.type !== undefined) {
    if (!VALID_TYPES.includes(body.type)) return { error: 'type must be one of: ' + VALID_TYPES.join(', ') };
    next.type = body.type;
  }
  if (body.identifier !== undefined) next.identifier = String(body.identifier || '').trim().slice(0, 120) || null;
  if (body.notes      !== undefined) next.notes      = String(body.notes      || '').trim().slice(0, 2000) || null;
  if (body.expectedReturn !== undefined) {
    // ISO date or null. Null = open-ended.
    if (body.expectedReturn === null || body.expectedReturn === '') next.expectedReturn = null;
    else {
      const s = String(body.expectedReturn);
      if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return { error: 'expectedReturn must be an ISO date (YYYY-MM-DD) or null' };
      next.expectedReturn = s;
    }
  }

  // Phase 12 (brief §12): hired-gear fields. owned (default) vs hired,
  // hire end-date, day-rate ex-GST. Used by the dead-rent flag on
  // the admin assets register.
  if (body.ownership !== undefined) {
    if (body.ownership === '' || body.ownership === null) next.ownership = 'owned';
    else if (body.ownership !== 'owned' && body.ownership !== 'hired') {
      return { error: 'ownership must be "owned" or "hired"' };
    } else {
      next.ownership = body.ownership;
    }
  }
  if (body.hireEndDate !== undefined) {
    if (body.hireEndDate === null || body.hireEndDate === '') next.hireEndDate = null;
    else {
      const s = String(body.hireEndDate);
      if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return { error: 'hireEndDate must be an ISO date (YYYY-MM-DD) or null' };
      next.hireEndDate = s;
    }
  }
  if (body.hireRateExGst !== undefined) {
    if (body.hireRateExGst === null || body.hireRateExGst === '') next.hireRateExGst = null;
    else {
      const n = Number(body.hireRateExGst);
      if (!Number.isFinite(n) || n < 0) return { error: 'hireRateExGst must be a non-negative number' };
      next.hireRateExGst = Math.round(n * 100) / 100;
    }
  }
  if (body.hireSupplier !== undefined) next.hireSupplier = String(body.hireSupplier || '').trim().slice(0, 120) || null;

  // Default ownership to 'owned' on new records so the dead-rent
  // calculator doesn't accidentally flag a missing field.
  if (existing && existing.ownership === undefined && next.ownership === undefined) {
    next.ownership = 'owned';
  }
  if (!existing && next.ownership === undefined) {
    next.ownership = 'owned';
  }

  return { asset: next };
}

async function readAsset(id) {
  return await readBlob('assets/' + id + '.json', null);
}
async function writeAsset(asset) {
  await writeBlob('assets/' + asset.id + '.json', asset);
}
async function readHistory(id) {
  return (await readBlob('assets/' + id + '/history.json', { entries: [] })) || { entries: [] };
}
async function appendHistory(id, entry) {
  const log = await readHistory(id);
  log.entries = log.entries || [];
  log.entries.push(entry);
  await writeBlob('assets/' + id + '/history.json', log);
}

// List all assets (admin sees this set; tradie filters down to their own).
async function listAllAssets() {
  try {
    const { blobs } = await list({ prefix: 'assets/', token: process.env.BLOB_READ_WRITE_TOKEN });
    // Only the per-asset record files at the top level — exclude /history.json under each.
    const flat = (blobs || []).filter(b =>
      b.pathname.startsWith('assets/') &&
      b.pathname.endsWith('.json') &&
      !b.pathname.endsWith('/history.json')
    );
    const records = await Promise.all(flat.map(async b => {
      try {
        const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
        if (!r.ok) return null;
        return await r.json();
      } catch (e) { return null; }
    }));
    return records.filter(Boolean);
  } catch (e) {
    console.error('listAllAssets failed:', e.message);
    return [];
  }
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;
  if (user.role === 'client') return res.status(403).json({ error: 'forbidden' });

  // ── Transfer subroute — accepts POST with action=transfer or path-like
  //   ?transfer=1 / pathname ending in /transfer. We expose it as a query
  //   action since the rest of the API uses query-based routing.
  const action = (req.query && req.query.action) || '';

  // ── GET — list or single (with history) ─────────────────────────────
  if (req.method === 'GET') {
    const { id } = req.query || {};
    if (id) {
      const a = await readAsset(id);
      if (!a) return res.status(404).json({ error: 'not found' });
      // Visibility: admin sees all; tradie/LH sees only what they hold.
      if (user.role !== 'admin' && a.currentHolderId !== user.id) {
        return res.status(403).json({ error: 'no access to this asset' });
      }
      const history = await readHistory(id);
      // Enrich history with user names so the UI doesn't need a second
      // round-trip just to display "Sam → Jack" rows. Cheap: one users.json
      // read per asset detail open.
      const usersBlob = await readBlob('users.json', { users: [] });
      const nameById = {};
      (usersBlob.users || []).forEach(u => { nameById[u.id] = u.username; });
      const enriched = (history.entries || []).map(e => ({
        ...e,
        fromName: e.from ? (nameById[e.from] || '(unknown user)') : 'Storage',
        toName:   e.to   ? (nameById[e.to]   || '(unknown user)') : 'Storage',
        byName:   e.byUserId ? (nameById[e.byUserId] || '(unknown user)') : '—',
      })).sort((x, y) => (y.at || '').localeCompare(x.at || '')); // newest first
      const holderName = a.currentHolderId ? (nameById[a.currentHolderId] || '(unknown user)') : null;
      return res.status(200).json({ asset: { ...a, currentHolderName: holderName }, history: enriched });
    }
    const all = (await listAllAssets()).filter(a => !a.archived || (req.query && req.query.archived === '1'));
    const visible = user.role === 'admin'
      ? all
      : all.filter(a => a.currentHolderId === user.id);
    // Same name enrichment as single-asset for the list view.
    const usersBlob = await readBlob('users.json', { users: [] });
    const nameById = {};
    (usersBlob.users || []).forEach(u => { nameById[u.id] = u.username; });
    const enriched = visible.map(a => ({
      ...a,
      currentHolderName: a.currentHolderId ? (nameById[a.currentHolderId] || '(unknown user)') : null,
    }));
    return res.status(200).json({ assets: enriched });
  }

  // ── POST — create new asset OR transfer ────────────────────────────
  if (req.method === 'POST') {
    if (action === 'transfer') {
      const body = req.body || {};
      const { assetId, toUserId, expectedReturn, note } = body;
      if (!assetId) return res.status(400).json({ error: 'assetId required' });
      const a = await readAsset(assetId);
      if (!a) return res.status(404).json({ error: 'asset not found' });

      // Tradie/LH may only transfer something they currently hold.
      if (user.role !== 'admin') {
        if (a.currentHolderId !== user.id) {
          return res.status(403).json({ error: "you can only transfer an asset you currently hold" });
        }
        // Destination must be a real tradie/LH (or null = back to storage).
        // Validated below.
      }

      // Resolve destination user if non-null
      let toUser = null;
      if (toUserId) {
        const usersBlob = await readBlob('users.json', { users: [] });
        toUser = (usersBlob.users || []).find(u => u.id === toUserId);
        if (!toUser) return res.status(404).json({ error: 'destination user not found' });
        if (toUser.role === 'client') return res.status(400).json({ error: 'cannot assign asset to a client' });
        // Tradies can't assign to admin (would surrender ownership chain
        // without an audit reason). Admin transfer can go anywhere.
        if (user.role !== 'admin' && toUser.role === 'admin') {
          return res.status(403).json({ error: 'transfer to admin must be done by admin' });
        }
      }

      const now = new Date().toISOString();
      // Validate expectedReturn shape
      let er = a.expectedReturn || null;
      if (expectedReturn !== undefined) {
        if (expectedReturn === null || expectedReturn === '') er = null;
        else if (/^\d{4}-\d{2}-\d{2}/.test(String(expectedReturn))) er = String(expectedReturn);
        else return res.status(400).json({ error: 'expectedReturn must be ISO date YYYY-MM-DD or null' });
      } else if (toUserId === null) {
        // Returning to storage clears the expected-return date.
        er = null;
      }

      const prev = { from: a.currentHolderId || null, to: toUserId || null };
      a.currentHolderId = toUserId || null;
      a.assignedAt = toUserId ? now : null;
      a.expectedReturn = er;
      a.updatedAt = now;
      await writeAsset(a);
      await appendHistory(assetId, {
        id: newHistoryId(),
        from: prev.from,
        to:   prev.to,
        at:   now,
        byUserId: user.id,
        byRole:   user.role,
        byName:   user.username,
        note: note ? String(note).trim().slice(0, 500) : null,
      });
      return res.status(200).json({ asset: a });
    }

    // Create new asset — admin only
    if (user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    const body = req.body || {};
    if (!body.name || !String(body.name).trim()) return res.status(400).json({ error: 'name required' });
    if (!body.type || !VALID_TYPES.includes(body.type)) {
      return res.status(400).json({ error: 'type required (one of: ' + VALID_TYPES.join(', ') + ')' });
    }
    const parsed = sanitiseAsset(body, {});
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const now = new Date().toISOString();
    const asset = {
      id: newAssetId(),
      name: parsed.asset.name,
      type: parsed.asset.type,
      identifier: parsed.asset.identifier || null,
      notes: parsed.asset.notes || null,
      // Admin can create-and-assign in one move by passing currentHolderId.
      // Otherwise the asset is in storage (currentHolderId = null).
      currentHolderId: body.currentHolderId || null,
      assignedAt: body.currentHolderId ? now : null,
      expectedReturn: parsed.asset.expectedReturn || null,
      archived: false,
      createdAt: now,
      updatedAt: now,
      createdBy: user.id,
    };
    await writeAsset(asset);
    if (asset.currentHolderId) {
      await appendHistory(asset.id, {
        id: newHistoryId(),
        from: null,
        to:   asset.currentHolderId,
        at:   now,
        byUserId: user.id,
        byRole:   user.role,
        byName:   user.username,
        note: 'created and assigned',
      });
    }
    return res.status(201).json({ asset });
  }

  // ── PUT — edit metadata (admin only). Holder changes go via transfer.
  if (req.method === 'PUT') {
    if (user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    const id = (req.query && req.query.id) || '';
    if (!id) return res.status(400).json({ error: 'id required' });
    const existing = await readAsset(id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    const body = req.body || {};
    // Block currentHolderId on PUT — must use transfer so the audit log
    // is always populated. If the admin wants to change the holder, they
    // do it through POST ?action=transfer.
    if (body.currentHolderId !== undefined && body.currentHolderId !== existing.currentHolderId) {
      return res.status(400).json({ error: 'use POST ?action=transfer to change the holder' });
    }
    const parsed = sanitiseAsset(body, existing);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const next = { ...parsed.asset, updatedAt: new Date().toISOString() };
    await writeAsset(next);
    return res.status(200).json({ asset: next });
  }

  // ── DELETE — soft-delete (admin only). Sets archived:true; record + history kept.
  if (req.method === 'DELETE') {
    if (user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    const id = (req.query && req.query.id) || '';
    if (!id) return res.status(400).json({ error: 'id required' });
    const existing = await readAsset(id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    existing.archived = true;
    existing.updatedAt = new Date().toISOString();
    await writeAsset(existing);
    return res.status(200).json({ asset: existing });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
