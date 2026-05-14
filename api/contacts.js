// Per-job contacts (project people + suppliers).
// Stored in jobs/<jobId>/contacts.json — sibling-blob pattern matching tags/temps/hours.
// Clients are blocked outright, even when otherwise assigned to the job.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');
const {
  requireFields, trimStr, trimStrOrNull,
  newId, nowIso, CONTACT_CATEGORIES,
} = require('./_lib/validation');

function key(jobId) { return `jobs/${jobId}/contacts.json`; }

function sanitize(input, base = {}) {
  const category = CONTACT_CATEGORIES.includes(input.category)
    ? input.category
    : (base.category || 'project');
  if (category === 'project') {
    return {
      id: base.id,
      category: 'project',
      name: trimStr(input.name ?? base.name, 200),
      role: trimStrOrNull(input.role ?? base.role, 200),
      company: trimStrOrNull(input.company ?? base.company, 200),
      phone: trimStrOrNull(input.phone ?? base.phone, 50),
      email: trimStrOrNull(input.email ?? base.email, 200),
      notes: trimStrOrNull(input.notes ?? base.notes, 2000),
      createdAt: base.createdAt,
      updatedAt: nowIso(),
    };
  }
  return {
    id: base.id,
    category: 'supplier',
    name: trimStr(input.name ?? base.name, 200),
    description: trimStr(input.description ?? base.description, 1000),
    contactPerson: trimStrOrNull(input.contactPerson ?? base.contactPerson, 200),
    phone: trimStrOrNull(input.phone ?? base.phone, 50),
    email: trimStrOrNull(input.email ?? base.email, 200),
    createdAt: base.createdAt,
    updatedAt: nowIso(),
  };
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const user = await requireAuth(req, res, { jobId });
  if (!user) return;

  // Clients are blocked outright — even if otherwise assigned, contacts are internal.
  if (user.role === 'client') return res.status(403).json({ error: 'forbidden' });

  const KEY = key(jobId);

  if (req.method === 'GET') {
    const data = await readBlob(KEY, { contacts: [] });
    return res.status(200).json({ contacts: Array.isArray(data.contacts) ? data.contacts : [] });
  }

  // Writes — admin only
  if (user.role !== 'admin' || !canWrite(user, jobId)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const data = await readBlob(KEY, { contacts: [] });
  data.contacts = Array.isArray(data.contacts) ? data.contacts : [];

  if (req.method === 'POST') {
    const body = req.body || {};
    if (!CONTACT_CATEGORIES.includes(body.category)) {
      return res.status(400).json({ error: 'invalid category' });
    }
    const required = body.category === 'supplier' ? ['name', 'description'] : ['name'];
    const err = requireFields(body, required);
    if (err) return res.status(400).json({ error: err });
    const id = newId('contact');
    const now = nowIso();
    const contact = sanitize(body, { id, createdAt: now });
    contact.id = id;
    data.contacts.push(contact);
    await writeBlob(KEY, data);
    return res.status(200).json({ contact });
  }

  if (req.method === 'PUT') {
    const { id } = req.query || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const idx = data.contacts.findIndex(c => c.id === id);
    if (idx === -1) return res.status(404).json({ error: 'contact not found' });
    const body = req.body || {};
    const updated = sanitize(body, data.contacts[idx]);
    updated.id = id;
    if (updated.category === 'supplier' && !updated.description) {
      return res.status(400).json({ error: 'description required for suppliers' });
    }
    if (!updated.name) return res.status(400).json({ error: 'name required' });
    data.contacts[idx] = updated;
    await writeBlob(KEY, data);
    return res.status(200).json({ contact: updated });
  }

  if (req.method === 'DELETE') {
    const { id } = req.query || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const before = data.contacts.length;
    data.contacts = data.contacts.filter(c => c.id !== id);
    if (data.contacts.length === before) {
      return res.status(404).json({ error: 'contact not found' });
    }
    await writeBlob(KEY, data);
    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
};
