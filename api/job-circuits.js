// Switchboards + circuits per job.
//
// The Job entity gains optional arrays. They live on the job record
// itself (alongside areaGroups, roughInTasks, etc) so a single GET
// /api/jobs?id=X gives the mobile + admin everything they need. The
// `modules.switchboards` + `modules.circuits` flags (rigidity audit R1)
// gate whether the UI surfaces them; the data is always available to
// API callers.
//
// TWO facets, deliberately distinct (do NOT conflate):
//   switchboards[] + circuits[]  — the lightweight INSTALL REGISTER below.
//   circuitBoards[]              — the rich AS/NZS-3000 CIRCUIT SCHEDULE: the
//     engineering design (supply, main switch, per-way device/cable/load with
//     live voltage-drop, phase-balance and capacity compute) that the office
//     builder + the Phil field view share. One store, two surfaces. The pure
//     compute + zod schema live in src/domains/circuit-schedule; this endpoint
//     is the only writer. Added additively — register callers are untouched.
//
// Schema (validated here):
//
//   switchboards: [{
//     id, code, name?,
//     levelId?,         link to a level (if levels module is on)
//     feedsFromId?,     parent switchboard id (the MSB feeds DBs)
//     location?,        free-text ("Plant room L1 east")
//     archived?, order?
//   }]
//
//   circuits: [{
//     id, number,        circuit ID on the schedule ("L1-L24")
//     switchboardId,     required — board the circuit is on
//     type,              power | light | emergency | data | fire | mech | other
//     description?,
//     areaId?,           link to an area (where the circuit serves)
//     status,            planned | roughed-in | energised | commissioned
//     archived?, order?
//   }]
//
//   circuitBoards: [{
//     id, name, ref, location, suppliedFrom,
//     supply (1ph|3ph), voltage, mainRating, mainPoles, faultKA,
//     mainRcd, spd, ways, status (draft|active|issued),
//     updated, updatedBy,            stamped server-side on content change
//     circuits: [{
//       id, way, desc, type, phase, device, rating, poles, curve, kA,
//       rcd, rcdType, active, neut, cores, length, method, load, loadUnit, notes
//     }]
//   }]
//
// Routes:
//
//   GET    /api/job-circuits?jobId=X
//          { switchboards, circuits, boards } — admin/LH/tradie-assigned
//          (read-only for tradies, write requires canManageJob).
//
//   PUT    /api/job-circuits?jobId=X
//          body: { switchboards?, circuits?, boards? }
//          Replaces the relevant array(s) wholesale. Validated. Preserves
//          ids for items the new payload still includes by id-match.
//
//   POST   /api/job-circuits?jobId=X&action=bulk-edit
//          body: { operations: [...] }
//          Ops:
//            archive-switchboard / rename-switchboard / reorder-switchboard
//            archive-circuit     / rename-circuit     / reorder-circuit
//            set-circuit-status (status: planned|roughed-in|energised|commissioned)
//          Same atomic single-write pattern as /api/jobs-bulk-edit.
//
// Audit entries on every mutation via _lib/job-audit.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canManageJob, isAdminRole, isClientRole } = require('./_lib/auth');
const { nanoid } = require('./_lib/validation');
const { appendAudit } = require('./_lib/job-audit');

const VALID_CIRCUIT_TYPES   = new Set(['power','light','emergency','data','fire','mech','other']);
const VALID_CIRCUIT_STATUS  = new Set(['planned','roughed-in','energised','commissioned']);
const MAX_SB                = 200;
const MAX_CIRCUITS          = 2000;

// Rich AS/NZS-3000 circuit schedule (job.circuitBoards). Distinct from the
// register above; the office builder + Phil field view both read/write here.
const VALID_BOARD_STATUS    = new Set(['draft','active','issued']);
const MAX_BOARDS            = 60;
const MAX_BOARD_CIRCUITS    = 300;

function _str(v, max = 80) {
  return v == null ? '' : String(v).trim().slice(0, max);
}

function _num(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  if (min != null && n < min) return min;
  if (max != null && n > max) return max;
  return n;
}

function _bool(v) {
  return v === true || v === 'true' || v === 1;
}

// ── Validators ────────────────────────────────────────────────────────
function validateSwitchboards(raw, existing) {
  if (!Array.isArray(raw)) return { ok: false, error: 'switchboards must be an array' };
  if (raw.length > MAX_SB)  return { ok: false, error: `too many switchboards (max ${MAX_SB})` };
  const existingById = {};
  for (const e of (existing || [])) existingById[e.id] = e;
  const out = [];
  const seenIds = new Set();
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i] || {};
    const code = _str(s.code, 40);
    if (!code) return { ok: false, error: `switchboards[${i}].code required` };
    let id = s.id ? String(s.id) : '';
    if (!id) id = nanoid('sb_');
    if (seenIds.has(id)) return { ok: false, error: `switchboards[${i}].id duplicate` };
    seenIds.add(id);
    const row = {
      id, code,
      name:        _str(s.name, 80),
      levelId:     _str(s.levelId, 40),
      feedsFromId: _str(s.feedsFromId, 40),
      location:    _str(s.location, 120),
    };
    if (s.archived) {
      row.archived = true;
      row.archivedAt = _str(s.archivedAt, 40) || (existingById[id] && existingById[id].archivedAt) || new Date().toISOString();
      row.archivedBy = _str(s.archivedBy, 80) || (existingById[id] && existingById[id].archivedBy) || '';
    }
    if (typeof s.order === 'number' && Number.isFinite(s.order)) row.order = s.order;
    out.push(row);
  }
  return { ok: true, switchboards: out };
}

function validateCircuits(raw, existing, switchboards) {
  if (!Array.isArray(raw)) return { ok: false, error: 'circuits must be an array' };
  if (raw.length > MAX_CIRCUITS) return { ok: false, error: `too many circuits (max ${MAX_CIRCUITS})` };
  const existingById = {};
  for (const e of (existing || [])) existingById[e.id] = e;
  const validSbIds = new Set((switchboards || []).map(s => s.id));
  const out = [];
  const seenIds = new Set();
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] || {};
    const number = _str(c.number, 40);
    if (!number) return { ok: false, error: `circuits[${i}].number required` };
    if (!c.switchboardId || !validSbIds.has(c.switchboardId)) {
      return { ok: false, error: `circuits[${i}].switchboardId must reference an existing switchboard` };
    }
    let id = c.id ? String(c.id) : '';
    if (!id) id = nanoid('ci_');
    if (seenIds.has(id)) return { ok: false, error: `circuits[${i}].id duplicate` };
    seenIds.add(id);
    const type = VALID_CIRCUIT_TYPES.has(c.type) ? c.type : 'power';
    const status = VALID_CIRCUIT_STATUS.has(c.status) ? c.status : 'planned';
    const row = {
      id, number,
      switchboardId: String(c.switchboardId),
      type, status,
      description: _str(c.description, 160),
      areaId:      _str(c.areaId, 40),
    };
    if (c.archived) {
      row.archived = true;
      row.archivedAt = _str(c.archivedAt, 40) || (existingById[id] && existingById[id].archivedAt) || new Date().toISOString();
      row.archivedBy = _str(c.archivedBy, 80) || (existingById[id] && existingById[id].archivedBy) || '';
    }
    if (typeof c.order === 'number' && Number.isFinite(c.order)) row.order = c.order;
    out.push(row);
  }
  return { ok: true, circuits: out };
}

// ── Rich circuit-schedule (boards) validator ──────────────────────────
// Mirrors src/domains/circuit-schedule/schema.ts (Board + Circuit). Lenient
// on the enum-ish string fields (device/poles/curve/cores/type) the same way
// the zod schema is — the UI constrains them; an unknown future value must not
// drop the row. Numbers are clamped; ids are preserved (minted only if absent).
function normCircuit(c) {
  return {
    id: c && c.id ? String(c.id) : nanoid('cc_'),
    way:      _num(c && c.way, 0, 0, 9999),
    desc:     _str(c && c.desc, 200),
    type:     _str(c && c.type, 40),
    phase:    _str(c && c.phase, 4),
    device:   _str(c && c.device, 24),
    rating:   _num(c && c.rating, 0, 0, 100000),
    poles:    _str(c && c.poles, 8),
    curve:    _str(c && c.curve, 8),
    kA:       _num(c && c.kA, 0, 0, 1000),
    rcd:      _str(c && c.rcd, 24) || 'none',
    rcdType:  _str(c && c.rcdType, 8),
    active:   _num(c && c.active, 0, 0, 100000),
    neut:     _num(c && c.neut, 0, 0, 100000),
    cores:    _str(c && c.cores, 16),
    length:   _num(c && c.length, 0, 0, 100000),
    method:   _str(c && c.method, 160),
    load:     _num(c && c.load, 0, 0, 1000000),
    loadUnit: (c && c.loadUnit) === 'kW' ? 'kW' : 'A',
    notes:    _str(c && c.notes, 300),
  };
}

// Content signature for change-detection — excludes the stamped metadata so a
// no-op save doesn't keep rewriting `updated`/`updatedBy`. Relies on both sides
// being produced by this normaliser (stable key order).
function boardSig(b) {
  const { updated, updatedBy, ...rest } = b; // eslint-disable-line no-unused-vars
  return JSON.stringify(rest);
}

function validateBoards(raw, existing, username) {
  if (!Array.isArray(raw)) return { ok: false, error: 'boards must be an array' };
  if (raw.length > MAX_BOARDS) return { ok: false, error: `too many boards (max ${MAX_BOARDS})` };
  const existingById = {};
  for (const e of (existing || [])) existingById[e.id] = e;
  const now = new Date().toISOString();
  const out = [];
  const seenIds = new Set();
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i] || {};
    const name = _str(b.name, 120);
    if (!name) return { ok: false, error: `boards[${i}].name required` };
    let id = b.id ? String(b.id) : nanoid('cb_');
    if (seenIds.has(id)) return { ok: false, error: `boards[${i}].id duplicate` };
    seenIds.add(id);

    const circuitsRaw = Array.isArray(b.circuits) ? b.circuits : [];
    if (circuitsRaw.length > MAX_BOARD_CIRCUITS) {
      return { ok: false, error: `boards[${i}] too many circuits (max ${MAX_BOARD_CIRCUITS})` };
    }
    const seenCircuit = new Set();
    const circuits = [];
    for (let j = 0; j < circuitsRaw.length; j++) {
      const c = normCircuit(circuitsRaw[j]);
      if (seenCircuit.has(c.id)) return { ok: false, error: `boards[${i}].circuits[${j}].id duplicate` };
      seenCircuit.add(c.id);
      circuits.push(c);
    }

    const supply = b.supply === '3ph' ? '3ph' : '1ph';
    const status = VALID_BOARD_STATUS.has(b.status) ? b.status : 'draft';
    const row = {
      id,
      name,
      ref:          _str(b.ref, 40),
      location:     _str(b.location, 160),
      suppliedFrom: _str(b.suppliedFrom, 160),
      supply,
      voltage:      _num(b.voltage, supply === '3ph' ? 415 : 230, 0, 100000),
      mainRating:   _num(b.mainRating, 0, 0, 100000),
      mainPoles:    _str(b.mainPoles, 8) || '1P',
      faultKA:      _num(b.faultKA, 0, 0, 1000),
      mainRcd:      _bool(b.mainRcd),
      spd:          _bool(b.spd),
      ways:         _num(b.ways, 0, 0, 1000),
      status,
      circuits,
    };

    // Stamp last-edited only when the board's content actually changed.
    const prev = existingById[id];
    if (!prev || boardSig(prev) !== boardSig(row)) {
      row.updated = now;
      row.updatedBy = username || '';
    } else {
      row.updated = prev.updated || '';
      row.updatedBy = prev.updatedBy || '';
    }
    out.push(row);
  }
  return { ok: true, boards: out };
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const me = await requireAuth(req, res);
  if (!me) return;

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const data = await readBlob('jobs.json', { jobs: [] });
  const job = (data.jobs || []).find(j => j.id === jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });

  // Read-access: anyone who can see the job; write-access: canManageJob.
  const canSee = isAdminRole(me.role)
              || (me.assignedJobIds || []).includes(jobId)
              || (isClientRole(me.role) && job.clientUserId === me.id);
  if (!canSee) return res.status(403).json({ error: 'forbidden' });

  if (req.method === 'GET') {
    return res.status(200).json({
      jobId,
      switchboards: job.switchboards  || [],
      circuits:     job.circuits      || [],
      boards:       job.circuitBoards || [],
    });
  }

  // All mutating paths require manage access.
  if (!canManageJob(me, jobId)) return res.status(403).json({ error: 'forbidden' });

  if (req.method === 'PUT') {
    const body = req.body || {};
    let sbResult, ciResult, bdResult;
    if (body.switchboards !== undefined) {
      sbResult = validateSwitchboards(body.switchboards, job.switchboards);
      if (!sbResult.ok) return res.status(400).json({ error: sbResult.error });
      job.switchboards = sbResult.switchboards;
    }
    if (body.circuits !== undefined) {
      ciResult = validateCircuits(body.circuits, job.circuits, job.switchboards || []);
      if (!ciResult.ok) return res.status(400).json({ error: ciResult.error });
      job.circuits = ciResult.circuits;
    }
    if (body.boards !== undefined) {
      bdResult = validateBoards(body.boards, job.circuitBoards, me.username);
      if (!bdResult.ok) return res.status(400).json({ error: bdResult.error });
      job.circuitBoards = bdResult.boards;
    }
    await writeBlob('jobs.json', data);
    const auditParts = [];
    if (sbResult) auditParts.push((job.switchboards || []).length + ' switchboards');
    if (ciResult) auditParts.push((job.circuits || []).length + ' circuits');
    if (bdResult) auditParts.push((job.circuitBoards || []).length + ' schedule board' + ((job.circuitBoards || []).length === 1 ? '' : 's'));
    if (auditParts.length) {
      appendAudit(jobId, {
        byUserId: me.id, byUsername: me.username, kind: 'circuits',
        summary: `Updated ${auditParts.join(' + ')}`,
      }).catch(() => {});
    }
    return res.status(200).json({
      switchboards: job.switchboards  || [],
      circuits:     job.circuits      || [],
      boards:       job.circuitBoards || [],
    });
  }

  if (req.method === 'POST') {
    const action = (req.query && req.query.action) || '';
    if (action !== 'bulk-edit') return res.status(400).json({ error: 'unknown action' });

    const ops = (req.body && Array.isArray(req.body.operations)) ? req.body.operations : null;
    if (!ops) return res.status(400).json({ error: 'operations array required' });
    if (!ops.length) return res.status(400).json({ error: 'operations cannot be empty' });
    if (ops.length > 500) return res.status(400).json({ error: 'too many operations (max 500)' });

    const sbs = job.switchboards = job.switchboards || [];
    const cis = job.circuits     = job.circuits     || [];
    const now = new Date().toISOString();
    let applied = 0;
    const failed = [];
    const auditBits = [];

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i] || {};
      try {
        switch (op.op) {
          case 'archive-switchboard': {
            const s = sbs.find(x => x.id === op.switchboardId);
            if (!s) throw new Error('switchboard not found');
            s.archived = true; s.archivedAt = now; s.archivedBy = me.username;
            auditBits.push(`archived SB "${s.code}"`);
            break;
          }
          case 'rename-switchboard': {
            const s = sbs.find(x => x.id === op.switchboardId);
            if (!s) throw new Error('switchboard not found');
            const name = _str(op.name, 80);
            if (op.code !== undefined) {
              const code = _str(op.code, 40);
              if (!code) throw new Error('code required');
              s.code = code;
            }
            if (name) s.name = name;
            auditBits.push(`renamed SB "${s.code}"`);
            break;
          }
          case 'reorder-switchboard': {
            const s = sbs.find(x => x.id === op.switchboardId);
            if (!s) throw new Error('switchboard not found');
            if (typeof op.order !== 'number' || !Number.isFinite(op.order)) throw new Error('order required');
            s.order = op.order;
            break;
          }
          case 'archive-circuit': {
            const c = cis.find(x => x.id === op.circuitId);
            if (!c) throw new Error('circuit not found');
            c.archived = true; c.archivedAt = now; c.archivedBy = me.username;
            auditBits.push(`archived circuit ${c.number}`);
            break;
          }
          case 'rename-circuit': {
            const c = cis.find(x => x.id === op.circuitId);
            if (!c) throw new Error('circuit not found');
            const number = _str(op.number, 40);
            if (!number) throw new Error('number required');
            c.number = number;
            if (op.description !== undefined) c.description = _str(op.description, 160);
            auditBits.push(`renamed circuit ${c.number}`);
            break;
          }
          case 'reorder-circuit': {
            const c = cis.find(x => x.id === op.circuitId);
            if (!c) throw new Error('circuit not found');
            if (typeof op.order !== 'number' || !Number.isFinite(op.order)) throw new Error('order required');
            c.order = op.order;
            break;
          }
          case 'set-circuit-status': {
            const c = cis.find(x => x.id === op.circuitId);
            if (!c) throw new Error('circuit not found');
            if (!VALID_CIRCUIT_STATUS.has(op.status)) throw new Error('bad status');
            c.status = op.status;
            auditBits.push(`circuit ${c.number} → ${c.status}`);
            break;
          }
          default:
            throw new Error('unknown op: ' + String(op.op || ''));
        }
        applied++;
      } catch (e) {
        failed.push({ index: i, op: op.op || null, reason: e.message || 'failed' });
      }
    }

    await writeBlob('jobs.json', data);
    if (auditBits.length) {
      const preview = auditBits.slice(0, 5).join(' · ');
      const overflow = auditBits.length > 5 ? ` (+${auditBits.length - 5} more)` : '';
      appendAudit(jobId, {
        byUserId: me.id, byUsername: me.username,
        kind: 'circuits-bulk',
        summary: `Bulk: ${applied} op${applied === 1 ? '' : 's'} — ${preview}${overflow}`,
      }).catch(() => {});
    }

    return res.status(200).json({ applied, failed });
  }

  res.status(405).end();
};
