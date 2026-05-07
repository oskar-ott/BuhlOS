// Per-job email contact list. Used as the "To" picker on the snag-email composer.
// Storage:  jobs/<jobId>/contacts.json  ->  { contacts: [{ id, name, email, role, addedBy, addedAt }] }
// Roles that can WRITE:  admin, leadingHand, tradie (canWrite gate).
// Clients are read-only (they can see the list but can't add/delete).
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');

function newId() {
  return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const user = await requireAuth(req, res, { jobId });
  if (!user) return;

  const KEY = `jobs/${jobId}/contacts.json`;

  if (req.method === 'GET') {
    const data = await readBlob(KEY, { contacts: [] });
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
    const { name, email, role } = req.body || {};
    const trimmedName = (name || '').trim();
    const trimmedEmail = (email || '').trim().toLowerCase();
    if (!trimmedName) return res.status(400).json({ error: 'name required' });
    if (!isValidEmail(trimmedEmail)) return res.status(400).json({ error: 'valid email required' });
    try {
      const data = await readBlob(KEY, { contacts: [] });
      const existing = (data.contacts || []).find(c => c.email.toLowerCase() === trimmedEmail);
      if (existing) return res.status(400).json({ error: 'email already in list' });
      const contact = {
        id: newId(),
        name: trimmedName,
        email: trimmedEmail,
        role: (role || '').trim() || undefined,
        addedBy: user.username,
        addedAt: new Date().toISOString(),
      };
      data.contacts = data.contacts || [];
      data.contacts.push(contact);
      await writeBlob(KEY, data);
      return res.status(200).json({ contact });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'PUT') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
    const { id, name, email, role } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      const data = await readBlob(KEY, { contacts: [] });
      const c = (data.contacts || []).find(x => x.id === id);
      if (!c) return res.status(404).json({ error: 'contact not found' });
      if (name !== undefined) {
        const t = String(name).trim();
        if (!t) return res.status(400).json({ error: 'name required' });
        c.name = t;
      }
      if (email !== undefined) {
        const t = String(email).trim().toLowerCase();
        if (!isValidEmail(t)) return res.status(400).json({ error: 'valid email required' });
        if (data.contacts.find(x => x.id !== id && x.email.toLowerCase() === t)) {
          return res.status(400).json({ error: 'email already in list' });
        }
        c.email = t;
      }
      if (role !== undefined) c.role = String(role).trim() || undefined;
      await writeBlob(KEY, data);
      return res.status(200).json({ contact: c });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'DELETE') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
    const id = (req.query && req.query.id) || '';
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      const data = await readBlob(KEY, { contacts: [] });
      data.contacts = (data.contacts || []).filter(c => c.id !== id);
      await writeBlob(KEY, data);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).end();
};
