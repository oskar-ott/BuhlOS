// Per-job contacts. Two distinct uses now coexist in one file:
//
//   1. Categorised contacts (category: 'project' | 'supplier')
//      • Project contact: PM, Site manager, Builder, etc.
//      • Supplier contact: a wholesaler/supplier the LH calls on this job
//        with a description of what's being supplied.
//      Admin-only writes (the brief). Tradies + LHs on the job get
//      read-only. Clients always 403.
//
//   2. Legacy email-list contacts (no `category` set)
//      • Added on the fly by the snag-email composer's "Pick from saved
//        contacts" picker. Shape: { id, name, email, role, addedBy, addedAt }.
//      • Writes here still go through canWrite (admin/LH/tradie on job),
//        because that flow already exists and changing the rule would
//        break the snag-email picker. They're invisible to the new
//        admin Contacts tab.
//
// Storage:  jobs/<jobId>/contacts.json -> { contacts: [...] }
// Chose embedded in the per-job sibling blob (matching tags/temps/photos/
// materials-list/data conventions) — not in jobs.json — to keep the
// global jobs registry small and avoid concurrent-write conflicts when
// admin edits contacts while the job blob is being mutated for other
// reasons. (One-line comment per the brief's storage-choice ask.)

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite, isAdminRole } = require('./_lib/auth');

const CATEGORIES = ['project', 'supplier'];

function newId() {
  return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}
function trimOrNull(v, max) {
  if (v === undefined || v === null) return undefined; // signal "no change"
  const t = String(v || '').trim().slice(0, max || 200);
  return t || null;
}

// Distinguish a "categorised" contact from a legacy email-list contact.
function isCategorised(c) {
  return c && typeof c === 'object' && CATEGORIES.includes(c.category);
}

// Validate categorised payload — returns { contact } or { error }.
function buildCategorised(body, existing, user) {
  const now = new Date().toISOString();
  const out = existing ? { ...existing } : {
    id: newId(),
    createdAt: now,
    createdBy: user.username,
  };
  const category = body.category !== undefined ? String(body.category).trim() : (existing && existing.category);
  if (!CATEGORIES.includes(category)) return { error: 'category must be "project" or "supplier"' };
  out.category = category;

  // Name is required on every category. Empty string blocked.
  if (body.name !== undefined) {
    const t = String(body.name || '').trim().slice(0, 200);
    if (!t) return { error: 'name required' };
    out.name = t;
  }
  if (!out.name) return { error: 'name required' };

  // Optional shared fields. trimOrNull returns undefined for "untouched",
  // null/string for "set" — we keep undefined fields off the record.
  const phone   = trimOrNull(body.phone,        60);
  const email   = body.email !== undefined ? String(body.email || '').trim() : undefined;
  const notes   = trimOrNull(body.notes,      2000);
  if (phone   !== undefined) out.phone   = phone;
  if (email   !== undefined) {
    const t = String(email).trim();
    if (t && !isValidEmail(t)) return { error: 'email is not valid' };
    out.email = t || null;
  }
  if (notes   !== undefined) out.notes   = notes;

  if (category === 'project') {
    const role    = trimOrNull(body.role,    120);
    const company = trimOrNull(body.company, 200);
    if (role    !== undefined) out.role    = role;
    if (company !== undefined) out.company = company;
    // 'description' / 'contactPerson' make no sense for project contacts
    // — strip them defensively in case the client posted the wrong shape.
    delete out.description;
    delete out.contactPerson;
  } else {
    // supplier
    const contactPerson = trimOrNull(body.contactPerson, 200);
    const description   = body.description !== undefined ? String(body.description || '').trim().slice(0, 1000) : undefined;
    if (contactPerson !== undefined) out.contactPerson = contactPerson;
    if (description !== undefined) {
      if (!description) return { error: 'description required for supplier contacts (what they\'re supplying)' };
      out.description = description;
    }
    if (!out.description) return { error: 'description required for supplier contacts (what they\'re supplying)' };
    // 'role' / 'company' make no sense for supplier (name IS the company)
    delete out.role;
    delete out.company;
  }
  out.updatedAt = now;
  out.updatedBy = user.username;
  return { contact: out };
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  // Server-side gate — clients get 403 even if they're assigned to this
  // job. Contacts include internal supplier numbers and PM details that
  // shouldn't surface in the client portal under any circumstance.
  const user = await requireAuth(req, res, { jobId });
  if (!user) return;
  if (user.role === 'client') return res.status(403).json({ error: 'forbidden' });

  const KEY = `jobs/${jobId}/contacts.json`;

  // ── GET ─────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const data = await readBlob(KEY, { contacts: [] });
    const cat = (req.query && req.query.category) || '';
    if (cat === 'project' || cat === 'supplier') {
      // Filter to a single category — used by the admin Contacts tab so
      // each section renders independently without legacy email-list
      // contacts leaking in.
      const contacts = (data.contacts || []).filter(c => c && c.category === cat);
      return res.status(200).json({ contacts, category: cat });
    }
    return res.status(200).json(data);
  }

  // ── POST ────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body || {};
    const wantsCategorised = body.category !== undefined && body.category !== '';

    if (wantsCategorised) {
      // New categorised contact — admin only.
      if (!isAdminRole(user.role)) return res.status(403).json({ error: 'admin only — only admins manage project/supplier contacts' });
      const built = buildCategorised(body, null, user);
      if (built.error) return res.status(400).json({ error: built.error });
      try {
        const data = await readBlob(KEY, { contacts: [] });
        data.contacts = data.contacts || [];
        data.contacts.push(built.contact);
        await writeBlob(KEY, data);
        return res.status(200).json({ contact: built.contact });
      } catch (e) { return res.status(500).json({ error: e.message }); }
    }

    // Legacy email-list path (no category). Preserved for the snag-email
    // composer's "add contact" flow. Same role gate as before.
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
    const { name, email, role } = body;
    const trimmedName = (name || '').trim();
    const trimmedEmail = (email || '').trim().toLowerCase();
    if (!trimmedName) return res.status(400).json({ error: 'name required' });
    if (!isValidEmail(trimmedEmail)) return res.status(400).json({ error: 'valid email required' });
    try {
      const data = await readBlob(KEY, { contacts: [] });
      const existing = (data.contacts || []).find(c => c.email && c.email.toLowerCase() === trimmedEmail && !c.category);
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

  // ── PUT ─────────────────────────────────────────────────────────────
  if (req.method === 'PUT') {
    const body = req.body || {};
    const id = body.id || (req.query && req.query.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      const data = await readBlob(KEY, { contacts: [] });
      const idx = (data.contacts || []).findIndex(x => x.id === id);
      if (idx < 0) return res.status(404).json({ error: 'contact not found' });
      const existing = data.contacts[idx];
      const isCat = isCategorised(existing);

      // Categorised contact edits are admin-only. Legacy ones keep the
      // original canWrite gate so the snag-email composer still works.
      if (isCat) {
        if (!isAdminRole(user.role)) return res.status(403).json({ error: 'admin only' });
        const built = buildCategorised(body, existing, user);
        if (built.error) return res.status(400).json({ error: built.error });
        data.contacts[idx] = built.contact;
        await writeBlob(KEY, data);
        return res.status(200).json({ contact: built.contact });
      } else {
        if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
        const c = existing;
        if (body.name !== undefined) {
          const t = String(body.name).trim();
          if (!t) return res.status(400).json({ error: 'name required' });
          c.name = t;
        }
        if (body.email !== undefined) {
          const t = String(body.email).trim().toLowerCase();
          if (!isValidEmail(t)) return res.status(400).json({ error: 'valid email required' });
          if (data.contacts.find(x => x.id !== id && !x.category && x.email && x.email.toLowerCase() === t)) {
            return res.status(400).json({ error: 'email already in list' });
          }
          c.email = t;
        }
        if (body.role !== undefined) c.role = String(body.role).trim() || undefined;
        await writeBlob(KEY, data);
        return res.status(200).json({ contact: c });
      }
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── DELETE ──────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const id = (req.query && req.query.id) || '';
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      const data = await readBlob(KEY, { contacts: [] });
      const target = (data.contacts || []).find(x => x.id === id);
      if (!target) return res.status(404).json({ error: 'contact not found' });
      // Categorised contacts: admin-only delete. Legacy: canWrite.
      if (isCategorised(target)) {
        if (!isAdminRole(user.role)) return res.status(403).json({ error: 'admin only' });
      } else {
        if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
      }
      data.contacts = data.contacts.filter(c => c.id !== id);
      await writeBlob(KEY, data);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).end();
};
