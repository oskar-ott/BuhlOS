// ITP (Inspection & Test Plan) templates and per-job submissions.
//
// Templates are global and stored at `itp/templates.json`. Submissions are
// per-job and stored at `jobs/<jobId>/itp.json`.
//
// Routes
//   GET  /api/itp?scope=templates              → list templates
//   POST /api/itp?scope=templates              → create/update template (admin)
//   GET  /api/itp?jobId=X                      → list submissions for a job
//   POST /api/itp?jobId=X&action=submit        → worker submits an ITP
//   POST /api/itp?jobId=X&action=review&id=Y   → admin approves/rejects
//
// Template shape:
//   { id, name, trade, active, items:[{ id, label, type, required }] }
// Submission shape:
//   { id, jobId, areaId, stageId, stageName, templateId,
//     status:'draft'|'submitted'|'approved'|'rejected',
//     answers:{}, submittedBy, submittedAt, reviewedBy, reviewedAt,
//     reviewNote }

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, getCurrentUser, canWrite } = require('./_lib/auth');
const { readList, appendRecord, updateRecord } = require('./_lib/listblob');

const TEMPLATES_KEY = 'itp/templates.json';

// Seed template kept inline so a fresh deployment has at least one usable
// checklist. The seed is written through to the templates blob on first read
// so it can be edited/extended via the API.
const SEED_TEMPLATE = {
  id: 'itp_testing_basic',
  name: 'Testing basic',
  trade: 'electrical',
  active: true,
  items: [
    { id: 'polarity',         label: 'Polarity checked',         type: 'pass_fail', required: true  },
    { id: 'earth_continuity', label: 'Earth continuity checked', type: 'pass_fail', required: true  },
    { id: 'insulation',       label: 'Insulation resistance',    type: 'text',      required: false },
    { id: 'rcd_trip',         label: 'RCD trip test',            type: 'pass_fail', required: true  },
    { id: 'notes',            label: 'Notes',                    type: 'text',      required: false },
  ],
};

async function loadTemplates() {
  const data = await readBlob(TEMPLATES_KEY, null);
  if (!data || !Array.isArray(data.templates) || data.templates.length === 0) {
    // Seed
    const seeded = { templates: [SEED_TEMPLATE] };
    try { await writeBlob(TEMPLATES_KEY, seeded); } catch {}
    return seeded.templates;
  }
  return data.templates;
}

async function saveTemplates(list) {
  await writeBlob(TEMPLATES_KEY, { templates: list });
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const scope  = (req.query && req.query.scope) || '';
  const jobId  = (req.query && req.query.jobId) || '';
  const action = (req.query && req.query.action) || '';
  const id     = (req.query && req.query.id) || '';

  // ── TEMPLATES (global) ─────────────────────────────────────────────
  if (scope === 'templates') {
    const me = await getCurrentUser(req);
    if (!me) return res.status(401).json({ error: 'not authenticated' });
    if (me.role === 'client') return res.status(403).json({ error: 'forbidden' });

    if (req.method === 'GET') {
      const templates = (await loadTemplates()).filter(t => t && t.active !== false);
      return res.status(200).json({ templates });
    }
    if (me.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    if (req.method === 'POST' || req.method === 'PUT') {
      const body = req.body || {};
      if (!body.name) return res.status(400).json({ error: 'name required' });
      const items = Array.isArray(body.items) ? body.items : [];
      const list = await loadTemplates();
      const idx = body.id ? list.findIndex(t => t.id === body.id) : -1;
      const now = new Date().toISOString();
      const t = {
        id: body.id || ('itp_' + Date.now().toString(36)),
        name: String(body.name).trim(),
        trade: body.trade || 'electrical',
        active: body.active === false ? false : true,
        items: items.map((it, i) => ({
          id: String(it.id || ('item_' + i)),
          label: String(it.label || '').trim(),
          type: ['pass_fail', 'text', 'number'].includes(it.type) ? it.type : 'pass_fail',
          required: !!it.required,
        })).filter(it => it.label),
        updatedAt: now,
      };
      if (idx >= 0) list[idx] = { ...list[idx], ...t };
      else list.push({ ...t, createdAt: now });
      await saveTemplates(list);
      return res.status(200).json({ template: t });
    }
    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'id required' });
      const list = await loadTemplates();
      const idx = list.findIndex(t => t.id === id);
      if (idx === -1) return res.status(404).json({ error: 'template not found' });
      list[idx].active = false;
      await saveTemplates(list);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).end();
  }

  // ── SUBMISSIONS (per-job) ──────────────────────────────────────────
  if (!jobId) return res.status(400).json({ error: 'jobId or scope=templates required' });

  const user = await requireAuth(req, res, { jobId });
  if (!user) return;
  if (user.role === 'client') return res.status(403).json({ error: 'forbidden' });

  const SUB_KEY = `jobs/${jobId}/itp.json`;
  const FIELD = 'submissions';

  if (req.method === 'GET') {
    const submissions = (await readList(SUB_KEY, FIELD)).filter(s => s && s.status !== 'deleted');
    return res.status(200).json({ submissions });
  }

  if (req.method === 'POST' && action === 'submit') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
    const body = req.body || {};
    if (!body.templateId || !body.areaId || !body.stageId || !body.stageName) {
      return res.status(400).json({ error: 'templateId, areaId, stageId, stageName required' });
    }
    const templates = await loadTemplates();
    const tpl = templates.find(t => t.id === body.templateId && t.active !== false);
    if (!tpl) return res.status(404).json({ error: 'template not found' });
    // Required-item validation
    const answers = (body.answers && typeof body.answers === 'object') ? body.answers : {};
    const missing = tpl.items.filter(it => it.required &&
      (answers[it.id] === undefined || answers[it.id] === '' || answers[it.id] === null));
    if (missing.length) {
      return res.status(400).json({ error: 'itp_required', missing: missing.map(m => m.id) });
    }
    const record = {
      jobId, areaId: body.areaId, stageId: body.stageId, stageName: body.stageName,
      templateId: tpl.id,
      status: 'submitted',
      answers,
      submittedBy: user.id, submittedByName: user.username,
      submittedAt: new Date().toISOString(),
      reviewedBy: null, reviewedAt: null, reviewNote: null,
    };
    const { record: saved, list } = await appendRecord(SUB_KEY, FIELD, record, user, 'itp_sub');
    return res.status(200).json({ submission: saved, submissions: list });
  }

  if (req.method === 'POST' && action === 'review') {
    if (user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    if (!id) return res.status(400).json({ error: 'id required' });
    const body = req.body || {};
    const decision = body.decision; // 'approve' | 'reject'
    if (!['approve', 'reject'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be approve or reject' });
    }
    // Self-review block (defensive — also covered by stage workflow)
    const list = await readList(SUB_KEY, FIELD);
    const existing = list.find(s => s.id === id);
    if (!existing) return res.status(404).json({ error: 'submission not found' });
    if (existing.submittedBy && existing.submittedBy === user.id) {
      return res.status(409).json({ error: 'self_review_blocked' });
    }
    const patch = {
      status: decision === 'approve' ? 'approved' : 'rejected',
      reviewedBy: user.id, reviewedByName: user.username,
      reviewedAt: new Date().toISOString(),
      reviewNote: body.note || null,
    };
    const { record } = await updateRecord(SUB_KEY, FIELD, id, patch, user);
    return res.status(200).json({ submission: record });
  }

  return res.status(405).end();
};
