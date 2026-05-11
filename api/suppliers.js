// Suppliers — the rich wholesaler/supplier register.
//
// This sits alongside the simpler api/wholesalers.js (used by the
// materials-list pricing-email modal as a quick name+email list).
// wholesalers.js is intentionally preserved so materials-list keeps
// working. The new suppliers register is what an admin actually
// reaches for: branches, contacts, account info, categories,
// preferred flag, product references, web-lookup history.
//
// Storage: suppliers.json — { suppliers: [...] }
//   Each record embeds branches[] and contacts[] inline because
//   they're never queried independently and rarely number more than a
//   handful per supplier. Keeps reads cheap.
//
//   POST    body { name, type, websiteUrl?, preferred?, categories?, notes?,
//                  accountNumber?, paymentTerms?, branches?, contacts? }
//   PATCH   ?id=...   patch any field; admin only
//   POST    ?id=...&action=add-branch       body: {branch}
//   POST    ?id=...&action=update-branch    body: {branchId, ...patch}
//   POST    ?id=...&action=delete-branch    body: {branchId}
//   POST    ?id=...&action=add-contact      body: {contact}
//   POST    ?id=...&action=update-contact   body: {contactId, ...patch}
//   POST    ?id=...&action=delete-contact   body: {contactId}
//   DELETE  ?id=...   soft-delete (status=archived); admin only
//
// Permissions:
//   admin       — full read/write incl. account number + payment terms
//   leadingHand — read (no account/payment fields surfaced)
//   tradie      — read-only summary (name, website, public contacts only)
//   client      — 403
//
// Account number + paymentTerms are stripped for non-admin reads.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');

const KEY = 'suppliers.json';

const VALID_TYPES = ['wholesaler', 'supplier', 'manufacturer', 'distributor', 'other'];
const VALID_STATUS = ['active', 'archived'];
const CATEGORY_OPTIONS = [
  'Cable', 'Power', 'Lighting', 'Switchgear',
  'Data / Communications', 'Security', 'Fire',
  'Mechanical / Ventilation', 'Tools', 'Consumables', 'Other',
];

function newId(p) {
  return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function isValidEmail(s) {
  return !s || (typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()));
}
function isValidUrl(s) {
  if (!s) return true;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) { return false; }
}
function trim(s, max) {
  return String(s || '').trim().slice(0, max || 500);
}

// Strip admin-only fields when serving to non-admins. We DO NOT remove
// them from the persisted record — only from the response.
function publicFor(role, s) {
  if (role === 'admin') return s;
  const out = { ...s };
  delete out.accountNumber;
  delete out.paymentTerms;
  // Notes can sometimes contain account-specific info; LH sees, tradie doesn't.
  if (role === 'tradie') {
    delete out.notes;
    // Branches: keep names + addresses. Drop free-text notes.
    out.branches = (out.branches || []).map(b => {
      const { notes, ...rest } = b;
      return rest;
    });
    // Contacts: keep name + role + phone + email + branch. Drop notes.
    out.contacts = (out.contacts || []).map(c => {
      const { notes, ...rest } = c;
      return rest;
    });
  }
  return out;
}

function sanitiseBranch(body) {
  const b = body || {};
  if (!b.name || !String(b.name).trim()) return { error: 'branch name required' };
  if (b.email && !isValidEmail(b.email)) return { error: 'invalid branch email' };
  return { branch: {
    id: b.id || newId('branch_'),
    name:    trim(b.name, 120),
    address: trim(b.address, 300) || null,
    phone:   trim(b.phone, 60) || null,
    email:   b.email ? trim(b.email, 200).toLowerCase() : null,
    notes:   trim(b.notes, 1000) || null,
  } };
}

function sanitiseContact(body, branchIds) {
  const c = body || {};
  if (!c.name || !String(c.name).trim()) return { error: 'contact name required' };
  if (c.email && !isValidEmail(c.email)) return { error: 'invalid contact email' };
  // branchId is optional; if set it must reference a real branch.
  let branchId = null;
  if (c.branchId) {
    branchId = String(c.branchId);
    if (!branchIds.includes(branchId)) return { error: 'branchId does not match any branch on this supplier' };
  }
  return { contact: {
    id: c.id || newId('scon_'),
    name:  trim(c.name, 120),
    role:  trim(c.role, 120) || null,
    phone: trim(c.phone, 60) || null,
    email: c.email ? trim(c.email, 200).toLowerCase() : null,
    branchId,
    notes: trim(c.notes, 1000) || null,
  } };
}

function sanitiseSupplier(body, existing, user) {
  const now = new Date().toISOString();
  const out = existing
    ? { ...existing }
    : { id: newId('sup_'), createdAt: now, createdBy: user.username, branches: [], contacts: [], status: 'active' };

  if (body.name !== undefined) {
    const t = trim(body.name, 200);
    if (!t) return { error: 'name required' };
    out.name = t;
  }
  if (!out.name) return { error: 'name required' };

  if (body.type !== undefined) {
    if (!VALID_TYPES.includes(body.type)) return { error: 'type must be one of: ' + VALID_TYPES.join(', ') };
    out.type = body.type;
  } else if (!out.type) {
    out.type = 'wholesaler';
  }

  if (body.websiteUrl !== undefined) {
    const u = trim(body.websiteUrl, 500);
    if (u && !isValidUrl(u)) return { error: 'websiteUrl must be a valid http(s) URL' };
    out.websiteUrl = u || null;
  }
  if (body.preferred !== undefined) out.preferred = !!body.preferred;
  if (body.accountNumber !== undefined) out.accountNumber = trim(body.accountNumber, 60) || null;
  if (body.paymentTerms  !== undefined) out.paymentTerms  = trim(body.paymentTerms, 60)  || null;
  if (body.notes         !== undefined) out.notes         = trim(body.notes, 4000)       || null;
  if (body.categories !== undefined) {
    const cats = Array.isArray(body.categories) ? body.categories : [];
    out.categories = cats.map(c => String(c || '').trim()).filter(Boolean).slice(0, 20);
  }
  if (body.status !== undefined) {
    if (!VALID_STATUS.includes(body.status)) return { error: 'invalid status' };
    out.status = body.status;
  }
  out.updatedAt = now;
  out.updatedBy = user.username;
  return { supplier: out };
}

async function readList() {
  return (await readBlob(KEY, { suppliers: [] })) || { suppliers: [] };
}
async function writeList(data) {
  await writeBlob(KEY, data);
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;
  if (user.role === 'client') return res.status(403).json({ error: 'forbidden' });

  const id = (req.query && req.query.id) || '';
  const action = (req.query && req.query.action) || '';

  // ── GET ─────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const data = await readList();
    if (id) {
      const s = (data.suppliers || []).find(x => x.id === id);
      if (!s) return res.status(404).json({ error: 'supplier not found' });
      return res.status(200).json({ supplier: publicFor(user.role, s) });
    }
    const includeArchived = (req.query && req.query.archived) === '1';
    const list = (data.suppliers || [])
      .filter(s => includeArchived ? true : s.status !== 'archived')
      .map(s => publicFor(user.role, s))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return res.status(200).json({ suppliers: list, categories: CATEGORY_OPTIONS });
  }

  // ── All mutations: admin only ───────────────────────────────────────
  if (user.role !== 'admin') return res.status(403).json({ error: 'admin only' });

  if (req.method === 'POST' && !id) {
    // Create a new supplier
    const body = req.body || {};
    const parsed = sanitiseSupplier(body, null, user);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    // Optional initial branches/contacts in the create call
    if (Array.isArray(body.branches)) {
      const cleaned = [];
      for (const b of body.branches) {
        const r = sanitiseBranch(b);
        if (r.error) return res.status(400).json({ error: 'branch: ' + r.error });
        cleaned.push(r.branch);
      }
      parsed.supplier.branches = cleaned;
    }
    if (Array.isArray(body.contacts)) {
      const cleaned = [];
      const bids = parsed.supplier.branches.map(b => b.id);
      for (const c of body.contacts) {
        const r = sanitiseContact(c, bids);
        if (r.error) return res.status(400).json({ error: 'contact: ' + r.error });
        cleaned.push(r.contact);
      }
      parsed.supplier.contacts = cleaned;
    }
    const data = await readList();
    data.suppliers = data.suppliers || [];
    data.suppliers.push(parsed.supplier);
    await writeList(data);
    return res.status(201).json({ supplier: parsed.supplier });
  }

  if (req.method === 'POST' && id) {
    // Sub-actions (add/update/delete branch or contact)
    const data = await readList();
    const s = (data.suppliers || []).find(x => x.id === id);
    if (!s) return res.status(404).json({ error: 'supplier not found' });
    s.branches = s.branches || [];
    s.contacts = s.contacts || [];
    const body = req.body || {};
    const stampUpdated = () => { s.updatedAt = new Date().toISOString(); s.updatedBy = user.username; };

    if (action === 'add-branch') {
      const r = sanitiseBranch(body.branch || body);
      if (r.error) return res.status(400).json({ error: r.error });
      s.branches.push(r.branch);
      stampUpdated();
      await writeList(data);
      return res.status(200).json({ supplier: s, branch: r.branch });
    }
    if (action === 'update-branch') {
      const bid = body.branchId || (body.branch && body.branch.id);
      if (!bid) return res.status(400).json({ error: 'branchId required' });
      const idx = s.branches.findIndex(b => b.id === bid);
      if (idx < 0) return res.status(404).json({ error: 'branch not found' });
      const r = sanitiseBranch({ ...s.branches[idx], ...(body.branch || body), id: bid });
      if (r.error) return res.status(400).json({ error: r.error });
      s.branches[idx] = r.branch;
      stampUpdated();
      await writeList(data);
      return res.status(200).json({ supplier: s, branch: r.branch });
    }
    if (action === 'delete-branch') {
      const bid = body.branchId;
      if (!bid) return res.status(400).json({ error: 'branchId required' });
      s.branches = s.branches.filter(b => b.id !== bid);
      // Unlink any contacts pointing at this branch
      s.contacts = s.contacts.map(c => c.branchId === bid ? { ...c, branchId: null } : c);
      stampUpdated();
      await writeList(data);
      return res.status(200).json({ supplier: s });
    }
    if (action === 'add-contact') {
      const r = sanitiseContact(body.contact || body, s.branches.map(b => b.id));
      if (r.error) return res.status(400).json({ error: r.error });
      s.contacts.push(r.contact);
      stampUpdated();
      await writeList(data);
      return res.status(200).json({ supplier: s, contact: r.contact });
    }
    if (action === 'update-contact') {
      const cid = body.contactId || (body.contact && body.contact.id);
      if (!cid) return res.status(400).json({ error: 'contactId required' });
      const idx = s.contacts.findIndex(c => c.id === cid);
      if (idx < 0) return res.status(404).json({ error: 'contact not found' });
      const r = sanitiseContact({ ...s.contacts[idx], ...(body.contact || body), id: cid }, s.branches.map(b => b.id));
      if (r.error) return res.status(400).json({ error: r.error });
      s.contacts[idx] = r.contact;
      stampUpdated();
      await writeList(data);
      return res.status(200).json({ supplier: s, contact: r.contact });
    }
    if (action === 'delete-contact') {
      const cid = body.contactId;
      if (!cid) return res.status(400).json({ error: 'contactId required' });
      s.contacts = s.contacts.filter(c => c.id !== cid);
      stampUpdated();
      await writeList(data);
      return res.status(200).json({ supplier: s });
    }
    return res.status(400).json({ error: 'unknown action: ' + action });
  }

  if (req.method === 'PATCH' && id) {
    const data = await readList();
    const idx = (data.suppliers || []).findIndex(x => x.id === id);
    if (idx < 0) return res.status(404).json({ error: 'supplier not found' });
    const parsed = sanitiseSupplier(req.body || {}, data.suppliers[idx], user);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    data.suppliers[idx] = parsed.supplier;
    await writeList(data);
    return res.status(200).json({ supplier: parsed.supplier });
  }

  if (req.method === 'DELETE' && id) {
    const data = await readList();
    const idx = (data.suppliers || []).findIndex(x => x.id === id);
    if (idx < 0) return res.status(404).json({ error: 'supplier not found' });
    // Soft-delete — records + history live elsewhere may still reference
    // this supplier. Hard-delete would orphan supplier-products.
    data.suppliers[idx].status = 'archived';
    data.suppliers[idx].updatedAt = new Date().toISOString();
    data.suppliers[idx].updatedBy = user.username;
    await writeList(data);
    return res.status(200).json({ supplier: data.suppliers[idx] });
  }

  return res.status(405).json({ error: 'method not allowed' });
};

module.exports.CATEGORY_OPTIONS = CATEGORY_OPTIONS;
