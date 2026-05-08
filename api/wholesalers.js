// Saved wholesalers register — admin-managed list of electrical suppliers.
// Used by the Materials List "Pricing email" modal so the admin can pick a
// recipient instead of typing the address every time.
//
// Storage: wholesalers.json — { wholesalers: [{ id, name, email, branch, notes, createdAt }] }
//
//   GET    /api/wholesalers           → list
//   POST   /api/wholesalers           → add { name, email, branch, notes }
//   PATCH  /api/wholesalers?id=...    → edit
//   DELETE /api/wholesalers?id=...    → remove
//
// Permissions:
//   admin/leadingHand: full
//   tradie:            read-only (in case Materials access expands later)
//   client:            403

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');

const KEY = 'wholesalers.json';

function newId() {
  return 'wh_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;
  if (user.role === 'client') return res.status(403).json({ error: 'forbidden' });

  if (req.method === 'GET') {
    const data = await readBlob(KEY, { wholesalers: [] });
    return res.status(200).json(data);
  }

  // Mutations: admin or LH only
  if (user.role !== 'admin' && user.role !== 'leadingHand') {
    return res.status(403).json({ error: 'admin/LH only' });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    if (!body.name || !String(body.name).trim()) return res.status(400).json({ error: 'name required' });
    const data = await readBlob(KEY, { wholesalers: [] });
    data.wholesalers = data.wholesalers || [];
    if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.email).trim())) {
      return res.status(400).json({ error: 'invalid email' });
    }
    const wh = {
      id:        newId(),
      name:      String(body.name).trim(),
      email:     body.email ? String(body.email).trim() : '',
      branch:    body.branch ? String(body.branch).trim() : '',
      notes:     body.notes ? String(body.notes).trim() : '',
      createdAt: new Date().toISOString(),
      createdBy: user.username,
    };
    data.wholesalers.push(wh);
    await writeBlob(KEY, data);
    return res.status(201).json({ wholesaler: wh });
  }

  if (req.method === 'PATCH') {
    const id = req.query && req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    const body = req.body || {};
    const data = await readBlob(KEY, { wholesalers: [] });
    const idx = (data.wholesalers || []).findIndex(w => w.id === id);
    if (idx < 0) return res.status(404).json({ error: 'not found' });
    if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.email).trim())) {
      return res.status(400).json({ error: 'invalid email' });
    }
    for (const k of ['name', 'email', 'branch', 'notes']) {
      if (body[k] !== undefined) data.wholesalers[idx][k] = String(body[k] || '').trim();
    }
    data.wholesalers[idx].updatedAt = new Date().toISOString();
    await writeBlob(KEY, data);
    return res.status(200).json({ wholesaler: data.wholesalers[idx] });
  }

  if (req.method === 'DELETE') {
    const id = req.query && req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    const data = await readBlob(KEY, { wholesalers: [] });
    const before = (data.wholesalers || []).length;
    data.wholesalers = (data.wholesalers || []).filter(w => w.id !== id);
    if (data.wholesalers.length === before) return res.status(404).json({ error: 'not found' });
    await writeBlob(KEY, data);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
