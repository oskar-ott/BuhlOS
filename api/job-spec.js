// Product spec per job (Job Builder redesign · Wave 3 — the missing half of
// the prototype's "Spec & circuits" step; the circuits half is the shipped
// AS/NZS-3000 schedule in api/job-circuits.js).
//
// `job.productSpec` lives on the job record itself (alongside areaGroups,
// switchboards, circuits — the job-circuits precedent) so one GET
// /api/jobs?id=X carries everything; this endpoint is the ONLY writer.
// Office register only for now: Phil does not consume it yet.
//
// Schema (validated here; the typed twin is src/domains/job-spec/schema.ts):
//
//   productSpec: [{
//     id, name,          system, e.g. "Power / GPOs", "Lighting"
//     edgeNote,          per-system edge-case rule ('' = none)
//     lines: [{
//       id,
//       qty,             integer ≥ 0, or null = not counted yet (honest absence)
//       product,         brand/model/cut-out/temp — free text, required
//       supplier,        '' = we supply (default); else who supplies
//     }]
//   }]
//
// Routes:
//   GET /api/job-spec?jobId=X → { systems }  — anyone who can see the job
//   PUT /api/job-spec?jobId=X body { systems } — canManageJob. Replaces the
//       array wholesale; ids preserved for items the payload still carries by
//       id-match, minted (ps_/pl_) for new ones. Validated; caps enforced.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canManageJob, isAdminRole, isClientRole } = require('./_lib/auth');
const { nanoid } = require('./_lib/validation');

const MAX_SYSTEMS = 40;
const MAX_LINES = 200;

function _str(v, max = 80) {
  return v == null ? '' : String(v).trim().slice(0, max);
}

// Validate + normalise the systems array. Mirrors the job-circuits contract:
// wholesale replace, ids preserved when supplied, minted when absent.
function validateProductSpec(raw) {
  if (!Array.isArray(raw)) return { ok: false, error: 'systems must be an array' };
  if (raw.length > MAX_SYSTEMS) return { ok: false, error: `too many systems (max ${MAX_SYSTEMS})` };
  const out = [];
  const seenSystemIds = new Set();
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i] || {};
    const name = _str(s.name, 80);
    if (!name) return { ok: false, error: `systems[${i}].name required` };
    let id = s.id ? String(s.id) : '';
    if (!id) id = nanoid('ps_');
    if (seenSystemIds.has(id)) return { ok: false, error: `systems[${i}].id duplicate` };
    seenSystemIds.add(id);
    if (!Array.isArray(s.lines)) return { ok: false, error: `systems[${i}].lines must be an array` };
    if (s.lines.length > MAX_LINES) return { ok: false, error: `systems[${i}]: too many lines (max ${MAX_LINES})` };
    const lines = [];
    const seenLineIds = new Set();
    for (let j = 0; j < s.lines.length; j++) {
      const l = s.lines[j] || {};
      const product = _str(l.product, 200);
      if (!product) return { ok: false, error: `systems[${i}].lines[${j}].product required` };
      let lineId = l.id ? String(l.id) : '';
      if (!lineId) lineId = nanoid('pl_');
      if (seenLineIds.has(lineId)) return { ok: false, error: `systems[${i}].lines[${j}].id duplicate` };
      seenLineIds.add(lineId);
      // qty: integer ≥ 0, or null = "not counted yet". Anything unparseable
      // becomes null — never invent a 0 that reads as a real count (P7).
      let qty = null;
      if (l.qty !== null && l.qty !== undefined && l.qty !== '') {
        const n = Number(l.qty);
        if (Number.isFinite(n) && n >= 0) qty = Math.min(Math.round(n), 100000);
      }
      lines.push({ id: lineId, qty, product, supplier: _str(l.supplier, 120) });
    }
    out.push({ id, name, edgeNote: _str(s.edgeNote, 300), lines });
  }
  return { ok: true, systems: out };
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const me = await requireAuth(req, res);
  if (!me) return;

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const data = await readBlob('jobs.json', { jobs: [] });
  const job = (data.jobs || []).find((j) => j.id === jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });

  // Read-access mirrors api/job-circuits.js: admins see any job; field crew
  // their assigned jobs; a client only their own job.
  const canSee = isAdminRole(me.role)
    || (Array.isArray(me.assignedJobIds) && me.assignedJobIds.includes(jobId))
    || (isClientRole(me.role) && job.clientUserId === me.id);
  if (!canSee) return res.status(403).json({ error: 'forbidden' });

  if (req.method === 'GET') {
    return res.status(200).json({ systems: Array.isArray(job.productSpec) ? job.productSpec : [] });
  }

  if (req.method === 'PUT') {
    if (!canManageJob(me, jobId)) return res.status(403).json({ error: 'cannot manage this job' });
    const body = req.body || {};
    if (body.systems === undefined) return res.status(400).json({ error: 'systems required' });
    const v = validateProductSpec(body.systems);
    if (!v.ok) return res.status(400).json({ error: v.error });
    job.productSpec = v.systems;
    await writeBlob('jobs.json', data);
    return res.status(200).json({ systems: v.systems });
  }

  return res.status(405).json({ error: 'method not allowed' });
};

// Test-only export: the pure validator.
module.exports.__test = { validateProductSpec };
