// Company-wide ITP (Inspection Test Plan) templates.
//
// A template is a reusable inspection plan: "MSB energisation", "Smoke
// alarm install", "Final test & tag". Each template owns ordered points
// — each point is a piece of evidence the inspector needs to record:
// a photo, a value (with optional unit + pass-criterion), or a sign-off.
//
// Storage: itp-templates.json   (company-scoped — not per-job)
//   {
//     templates: [{
//       id, name, category?, description?,
//       points: [{
//         id, label, type: 'photo' | 'value' | 'signoff' | 'note',
//         unit?, required?: boolean, witnessRole?: 'builder' | 'admin' | 'lh',
//         min?: number, max?: number,     // value pass-criterion (numeric)
//         archived?, order?
//       }],
//       archived?, createdAt, createdBy, updatedAt
//     }]
//   }
//
// Routes:
//
//   GET    /api/itp-templates                List visible templates
//          ?includeArchived=1                Admin-only opt-in
//
//   POST   /api/itp-templates                Create. Admin only.
//          body: { name, category?, description?, points }
//
//   PATCH  /api/itp-templates?id=Y           Rename / re-point. Admin only.
//          body: { name?, category?, description?, points? }
//
//   DELETE /api/itp-templates?id=Y           Archive (soft). Admin only.
//
//   POST   /api/itp-templates?id=Y&action=duplicate
//                                            Copy as a new template named
//                                            "<name> (copy)". Useful for
//                                            "make a job-specific tweak".
//
// Validation: every point has a type + label. Type-specific fields
// (unit, min, max) only honoured for type='value'. witnessRole defaults
// 'admin' on signoff.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isStaffRole, isAdminRole } = require('./_lib/auth');
const { nanoid } = require('./_lib/validation');

const KEY = 'itp-templates.json';
const VALID_POINT_TYPES = new Set(['photo', 'value', 'signoff', 'note']);
const VALID_WITNESS     = new Set(['builder', 'admin', 'lh']);
const MAX_POINTS        = 100;
const MAX_TEMPLATES     = 500;

function _str(v, max = 80) {
  return v == null ? '' : String(v).trim().slice(0, max);
}

function validatePoint(raw, idx) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: `points[${idx}] must be an object` };
  const label = _str(raw.label, 200);
  if (!label) return { ok: false, error: `points[${idx}].label required` };
  const type = VALID_POINT_TYPES.has(raw.type) ? raw.type : 'photo';
  const out = {
    id: raw.id ? String(raw.id) : nanoid('ip_'),
    label, type,
    required: raw.required !== false, // default true
  };
  if (type === 'value') {
    if (raw.unit) out.unit = _str(raw.unit, 16);
    if (raw.min !== undefined && raw.min !== null) {
      const n = Number(raw.min);
      if (Number.isFinite(n)) out.min = n;
    }
    if (raw.max !== undefined && raw.max !== null) {
      const n = Number(raw.max);
      if (Number.isFinite(n)) out.max = n;
    }
  }
  if (type === 'signoff') {
    out.witnessRole = VALID_WITNESS.has(raw.witnessRole) ? raw.witnessRole : 'admin';
  }
  if (raw.archived) {
    out.archived = true;
    if (raw.archivedAt) out.archivedAt = _str(raw.archivedAt, 40);
    if (raw.archivedBy) out.archivedBy = _str(raw.archivedBy, 80);
  }
  if (typeof raw.order === 'number' && Number.isFinite(raw.order)) out.order = raw.order;
  return { ok: true, point: out };
}

function validateTemplate(raw, existing) {
  const name = _str(raw.name, 120);
  if (!name) return { ok: false, error: 'name required' };
  const pointsRaw = Array.isArray(raw.points) ? raw.points : [];
  if (pointsRaw.length > MAX_POINTS) {
    return { ok: false, error: `too many points (max ${MAX_POINTS})` };
  }
  const seenIds = new Set();
  const points = [];
  for (let i = 0; i < pointsRaw.length; i++) {
    const v = validatePoint(pointsRaw[i], i);
    if (!v.ok) return v;
    if (seenIds.has(v.point.id)) return { ok: false, error: `points[${i}].id duplicate` };
    seenIds.add(v.point.id);
    points.push(v.point);
  }
  const out = {
    id: existing ? existing.id : nanoid('tpl_'),
    name,
    category:    _str(raw.category, 60),
    description: _str(raw.description, 1000),
    points,
    archived:    existing ? existing.archived : false,
    createdAt:   existing ? existing.createdAt : new Date().toISOString(),
    createdBy:   existing ? existing.createdBy : '',
    updatedAt:   new Date().toISOString(),
  };
  return { ok: true, template: out };
}

async function readTemplates() {
  const data = await readBlob(KEY, { templates: [] });
  return Array.isArray(data && data.templates) ? data.templates : [];
}
async function writeTemplates(templates) {
  await writeBlob(KEY, { templates });
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const me = await requireAuth(req, res);
  if (!me) return;

  // ── GET — list ────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    if (!isStaffRole(me.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const includeArchived = req.query && req.query.includeArchived === '1';
    if (includeArchived && !isAdminRole(me.role)) {
      return res.status(403).json({ error: 'admin only for archived view' });
    }
    const templates = await readTemplates();
    const visible = includeArchived ? templates : templates.filter(t => !t.archived);
    return res.status(200).json({ count: visible.length, templates: visible });
  }

  // All mutating paths: admin only (company-wide library).
  if (!isAdminRole(me.role)) return res.status(403).json({ error: 'forbidden' });

  // ── POST — create or duplicate ────────────────────────────────────────
  if (req.method === 'POST') {
    const action = (req.query && req.query.action) || '';
    const templates = await readTemplates();

    if (action === 'duplicate') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id required' });
      const src = templates.find(t => t.id === id);
      if (!src) return res.status(404).json({ error: 'template not found' });
      const copy = JSON.parse(JSON.stringify(src));
      copy.id = nanoid('tpl_');
      copy.name = (src.name + ' (copy)').slice(0, 120);
      copy.points = (copy.points || []).map(p => ({ ...p, id: nanoid('ip_') }));
      copy.archived = false;
      copy.createdAt = new Date().toISOString();
      copy.createdBy = me.username;
      copy.updatedAt = copy.createdAt;
      templates.push(copy);
      await writeTemplates(templates);
      return res.status(201).json({ template: copy });
    }

    // Default POST — create from scratch.
    if (templates.length >= MAX_TEMPLATES) {
      return res.status(400).json({ error: `library full (max ${MAX_TEMPLATES})` });
    }
    const v = validateTemplate(req.body || {}, null);
    if (!v.ok) return res.status(400).json({ error: v.error });
    v.template.createdBy = me.username;
    templates.push(v.template);
    await writeTemplates(templates);
    return res.status(201).json({ template: v.template });
  }

  // ── PATCH — rename / re-point ─────────────────────────────────────────
  if (req.method === 'PATCH') {
    const id = req.query && req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    const templates = await readTemplates();
    const idx = templates.findIndex(t => t.id === id);
    if (idx < 0) return res.status(404).json({ error: 'template not found' });
    const v = validateTemplate({ ...templates[idx], ...(req.body || {}) }, templates[idx]);
    if (!v.ok) return res.status(400).json({ error: v.error });
    templates[idx] = v.template;
    await writeTemplates(templates);
    return res.status(200).json({ template: v.template });
  }

  // ── DELETE — soft archive ─────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const id = req.query && req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    const templates = await readTemplates();
    const t = templates.find(x => x.id === id);
    if (!t) return res.status(404).json({ error: 'template not found' });
    t.archived = true;
    t.archivedAt = new Date().toISOString();
    t.archivedBy = me.username;
    t.updatedAt = t.archivedAt;
    await writeTemplates(templates);
    return res.status(200).json({ ok: true, template: t });
  }

  res.status(405).end();
};
