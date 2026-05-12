// Bulk-edit on a single job's structural items.
//
//   POST /api/jobs-bulk-edit?jobId=<id>
//        body: { operations: [...] }   max 200 per call
//
// Rigidity audit R7 — today renaming 20 areas means 20 round-trips through
// /api/jobs PUT (each one a full areaGroups payload re-validated). For a
// 14-storey fitout with 168 apartments + 7 plant rooms that's painful.
// This endpoint takes a list of operations and applies them atomically in
// one pass + one blob write.
//
// Supported operations (op string + per-op fields):
//
//   { op: 'archive-area',         areaId }
//   { op: 'unarchive-area',       areaId }
//   { op: 'rename-area',          areaId, name }
//   { op: 'move-area',            areaId, toGroupId }
//   { op: 'reorder-area',         areaId, order: number }
//
//   { op: 'archive-group',        groupId }
//   { op: 'rename-group',         groupId, name }
//   { op: 'reorder-group',        groupId, order: number }
//
//   { op: 'archive-task',         stage: 'roughIn'|'fitOff', taskId }
//   { op: 'rename-task',          stage, taskId, name }
//   { op: 'reorder-task',         stage, taskId, order: number }
//
//   { op: 'set-area-custom-field',  areaId, field: { key, label, value, type, group? } }
//   { op: 'remove-area-custom-field', areaId, key }
//
// Response:
//   { applied: N, failed: [{ index, op, reason }] }
//
// Atomicity: we read the job once, apply every op against the in-memory
// copy, then write once. If ANY op references a missing id, it's recorded
// in `failed` but doesn't block the others — admin gets a per-op report.
// (Single write at end; no partial-state on disk.)
//
// Permissions: admin or LH on the job.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canManageJob } = require('./_lib/auth');
const { appendAudit } = require('./_lib/job-audit');

const MAX_OPS = 200;
const VALID_STAGES = new Set(['roughIn', 'fitOff']);
const VALID_CF_TYPES = new Set(['text', 'number', 'bool', 'date', 'longtext']);

function findArea(job, areaId) {
  for (const g of (job.areaGroups || [])) {
    for (const a of (g.areas || [])) {
      if (a.id === areaId) return { area: a, group: g };
    }
  }
  return null;
}
function findGroup(job, groupId) {
  return (job.areaGroups || []).find(g => g.id === groupId) || null;
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res);
  if (!me) return;

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  if (!canManageJob(me, jobId)) return res.status(403).json({ error: 'forbidden' });

  const ops = (req.body && Array.isArray(req.body.operations)) ? req.body.operations : null;
  if (!ops) return res.status(400).json({ error: 'operations array required' });
  if (!ops.length) return res.status(400).json({ error: 'operations cannot be empty' });
  if (ops.length > MAX_OPS) {
    return res.status(400).json({ error: `too many operations (max ${MAX_OPS})` });
  }

  // Load the job (mutable in-place).
  const jobsData = await readBlob('jobs.json', { jobs: [] });
  const job = (jobsData.jobs || []).find(j => j.id === jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });

  // LH gating: the same restrictions as /api/jobs PUT — LH can't change
  // job-level things (name/type/status/money/modules). Bulk-edit here
  // doesn't touch those fields though; areas + tasks + custom-fields
  // are LH-writable. Leaving the gate at canManageJob is correct.

  const failed = [];
  let applied = 0;
  const now = new Date().toISOString();
  const auditBits = []; // collect for one rolled-up audit entry

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] || {};
    try {
      switch (op.op) {
        case 'archive-area': {
          const hit = findArea(job, op.areaId);
          if (!hit) throw new Error('area not found');
          hit.area.archived = true;
          hit.area.archivedAt = now;
          hit.area.archivedBy = me.username;
          auditBits.push(`archived area "${hit.area.name}"`);
          break;
        }
        case 'unarchive-area': {
          const hit = findArea(job, op.areaId);
          if (!hit) throw new Error('area not found');
          delete hit.area.archived;
          delete hit.area.archivedAt;
          delete hit.area.archivedBy;
          auditBits.push(`restored area "${hit.area.name}"`);
          break;
        }
        case 'rename-area': {
          const hit = findArea(job, op.areaId);
          if (!hit) throw new Error('area not found');
          const name = String(op.name || '').trim();
          if (!name) throw new Error('name required');
          const old = hit.area.name;
          hit.area.name = name.slice(0, 120);
          auditBits.push(`renamed area "${old}" → "${hit.area.name}"`);
          break;
        }
        case 'move-area': {
          const hit = findArea(job, op.areaId);
          if (!hit) throw new Error('area not found');
          const toGroup = findGroup(job, op.toGroupId);
          if (!toGroup) throw new Error('target group not found');
          if (toGroup === hit.group) break; // no-op
          // Detach from source group, attach to target. Preserve all fields
          // including any per-area override task lists.
          hit.group.areas = (hit.group.areas || []).filter(a => a.id !== op.areaId);
          toGroup.areas = toGroup.areas || [];
          toGroup.areas.push(hit.area);
          auditBits.push(`moved area "${hit.area.name}" → "${toGroup.name}"`);
          break;
        }
        case 'reorder-area': {
          const hit = findArea(job, op.areaId);
          if (!hit) throw new Error('area not found');
          if (typeof op.order !== 'number' || !Number.isFinite(op.order)) {
            throw new Error('order must be a number');
          }
          hit.area.order = op.order;
          break;
        }
        case 'archive-group': {
          const g = findGroup(job, op.groupId);
          if (!g) throw new Error('group not found');
          g.archived = true;
          g.archivedAt = now;
          g.archivedBy = me.username;
          auditBits.push(`archived group "${g.name}"`);
          break;
        }
        case 'rename-group': {
          const g = findGroup(job, op.groupId);
          if (!g) throw new Error('group not found');
          const name = String(op.name || '').trim();
          if (!name) throw new Error('name required');
          const old = g.name;
          g.name = name.slice(0, 80);
          auditBits.push(`renamed group "${old}" → "${g.name}"`);
          break;
        }
        case 'reorder-group': {
          const g = findGroup(job, op.groupId);
          if (!g) throw new Error('group not found');
          if (typeof op.order !== 'number' || !Number.isFinite(op.order)) {
            throw new Error('order must be a number');
          }
          g.order = op.order;
          break;
        }
        case 'archive-task': {
          if (!VALID_STAGES.has(op.stage)) throw new Error('stage required');
          const list = job[op.stage === 'roughIn' ? 'roughInTasks' : 'fitOffTasks'] || [];
          const t = list.find(x => x.id === op.taskId);
          if (!t) throw new Error('task not found');
          t.archived = true;
          t.archivedAt = now;
          t.archivedBy = me.username;
          auditBits.push(`archived ${op.stage} task "${t.name}"`);
          break;
        }
        case 'rename-task': {
          if (!VALID_STAGES.has(op.stage)) throw new Error('stage required');
          const list = job[op.stage === 'roughIn' ? 'roughInTasks' : 'fitOffTasks'] || [];
          const t = list.find(x => x.id === op.taskId);
          if (!t) throw new Error('task not found');
          const name = String(op.name || '').trim();
          if (!name) throw new Error('name required');
          const old = t.name;
          t.name = name.slice(0, 120);
          auditBits.push(`renamed ${op.stage} task "${old}" → "${t.name}"`);
          break;
        }
        case 'reorder-task': {
          if (!VALID_STAGES.has(op.stage)) throw new Error('stage required');
          const list = job[op.stage === 'roughIn' ? 'roughInTasks' : 'fitOffTasks'] || [];
          const t = list.find(x => x.id === op.taskId);
          if (!t) throw new Error('task not found');
          if (typeof op.order !== 'number' || !Number.isFinite(op.order)) {
            throw new Error('order must be a number');
          }
          t.order = op.order;
          break;
        }
        case 'set-area-custom-field': {
          const hit = findArea(job, op.areaId);
          if (!hit) throw new Error('area not found');
          const f = op.field || {};
          const key = String(f.key || '').toLowerCase().trim().replace(/[^a-z0-9_]+/g, '_').slice(0, 40);
          if (!key) throw new Error('field.key required');
          const type = VALID_CF_TYPES.has(f.type) ? f.type : 'text';
          let value = f.value;
          if (type === 'bool')          value = !!value;
          else if (type === 'number')   { value = (value === '' || value == null) ? null : Number(value); if (value !== null && !Number.isFinite(value)) value = null; }
          else if (type === 'longtext') value = (value == null) ? '' : String(value).slice(0, 4000);
          else if (type === 'date')     { value = (value == null) ? null : String(value).slice(0, 10); if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) value = null; }
          else                          value = (value == null) ? '' : String(value).slice(0, 240);
          const entry = { key, label: String(f.label || key).slice(0, 80), value, type };
          if (f.group) entry.group = String(f.group).slice(0, 40);
          hit.area.customFields = hit.area.customFields || [];
          const existingIdx = hit.area.customFields.findIndex(c => c.key === key);
          if (existingIdx >= 0) hit.area.customFields[existingIdx] = entry;
          else                  hit.area.customFields.push(entry);
          break;
        }
        case 'remove-area-custom-field': {
          const hit = findArea(job, op.areaId);
          if (!hit) throw new Error('area not found');
          const key = String(op.key || '').toLowerCase().trim();
          if (!key) throw new Error('key required');
          hit.area.customFields = (hit.area.customFields || []).filter(c => c.key !== key);
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

  // Single blob write at the end. Atomic from the caller's perspective.
  await writeBlob('jobs.json', jobsData);

  // Rolled-up audit entry. Single entry for the whole batch keeps the
  // audit log readable when admin runs a 50-op rename pass.
  if (auditBits.length) {
    const preview = auditBits.slice(0, 5).join(' · ');
    const overflow = auditBits.length > 5 ? ` (+${auditBits.length - 5} more)` : '';
    appendAudit(jobId, {
      byUserId: me.id, byUsername: me.username,
      kind: 'bulk-edit',
      summary: `Bulk: ${applied} op${applied === 1 ? '' : 's'} — ${preview}${overflow}`,
    }).catch(() => {});
  }

  return res.status(200).json({ applied, failed });
};
