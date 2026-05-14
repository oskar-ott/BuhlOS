// Job data endpoint (dwellings/areas, snags, notes).
//
// Modes:
//   GET    /api/data?jobId=X                    → full blob
//   POST   /api/data?jobId=X                    → overwrite blob (admin or read-write user; used by legacy admin UI)
//   POST   /api/data?jobId=X&op=task-update     → atomic task status change
//                                                 body: { dwelling, stage, status }
//   POST   /api/data?jobId=X&op=snag-add        → atomic snag add
//                                                 body: { dwelling, stage, desc, priority? }
//   POST   /api/data?jobId=X&op=snag-close      → atomic snag close
//                                                 body: { id }    (or { index } legacy)
//   POST   /api/data?jobId=X&op=note-set        → atomic dwelling notes set
//                                                 body: { dwelling, notes }
//
// Per-operation routes do a fresh read-modify-write so concurrent tradies
// don't trample each other's updates.
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');

function newSnagId() {
  return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function todayAU() {
  return new Date().toLocaleDateString('en-AU');
}

async function loadJobData(jobId) {
  return await readBlob(`jobs/${jobId}/data.json`, { dwellings: {}, snags: [], notes: [] });
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const user = await requireAuth(req, res, { jobId });
  if (!user) return;

  const KEY = `jobs/${jobId}/data.json`;
  const op = (req.query && req.query.op) || '';

  if (req.method === 'GET') {
    const data = await loadJobData(jobId);
    if (!data.snags) data.snags = [];
    if (!data.dwellings) data.dwellings = {};
    if (!data.notes) data.notes = [];
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });

    if (op === 'task-update') {
      const { dwelling, stage, status } = req.body || {};
      if (!dwelling || !stage || !status) {
        return res.status(400).json({ error: 'dwelling, stage, status required' });
      }
      const ALLOWED = ['Not Started', 'In Progress', 'Done', 'Snagged', 'N/A'];
      if (!ALLOWED.includes(status)) {
        return res.status(400).json({ error: 'invalid status' });
      }
      const data = await loadJobData(jobId);
      data.dwellings = data.dwellings || {};
      data.dwellings[dwelling] = data.dwellings[dwelling] || {};
      data.dwellings[dwelling][stage] = data.dwellings[dwelling][stage] || {};
      data.dwellings[dwelling][stage].status = status;
      data.dwellings[dwelling][stage].updatedAt = new Date().toISOString();
      data.dwellings[dwelling][stage].updatedBy = user.username;
      await writeBlob(KEY, data);
      return res.status(200).json({ ok: true });
    }

    if (op === 'snag-add') {
      const { dwelling, stage, desc, priority } = req.body || {};
      if (!dwelling || !desc) {
        return res.status(400).json({ error: 'dwelling and desc required' });
      }
      const data = await loadJobData(jobId);
      data.snags = data.snags || [];
      const snag = {
        id: newSnagId(),
        dwelling,
        stage: stage || '',
        desc: String(desc).slice(0, 500),
        by: user.username,
        userId: user.id,
        priority: priority || 'Medium',
        status: 'Open',
        date: todayAU(),
        createdAt: new Date().toISOString(),
      };
      data.snags.push(snag);
      await writeBlob(KEY, data);
      return res.status(200).json({ snag });
    }

    if (op === 'snag-close') {
      const { id, index } = req.body || {};
      const data = await loadJobData(jobId);
      data.snags = data.snags || [];
      let snag;
      if (id) {
        snag = data.snags.find(s => s.id === id);
      } else if (typeof index === 'number') {
        snag = data.snags[index];
      }
      if (!snag) return res.status(404).json({ error: 'snag not found' });
      snag.status = 'Closed';
      snag.closedBy = user.username;
      snag.closedAt = new Date().toISOString();
      await writeBlob(KEY, data);
      return res.status(200).json({ snag });
    }

    if (op === 'note-set') {
      const { dwelling, notes } = req.body || {};
      if (!dwelling) return res.status(400).json({ error: 'dwelling required' });
      const data = await loadJobData(jobId);
      data.dwellings = data.dwellings || {};
      data.dwellings[dwelling] = data.dwellings[dwelling] || {};
      data.dwellings[dwelling]._notes = String(notes || '').slice(0, 4000);
      await writeBlob(KEY, data);
      return res.status(200).json({ ok: true });
    }

    // Legacy full-blob overwrite (admin UI). Restricted to admin so that tradies
    // can't accidentally blow away the whole data blob; they must use the granular
    // ops above (task-update, snag-add, snag-close, note-set).
    if (user.role !== 'admin') return res.status(403).json({ error: 'use op-based routes' });
    try {
      await writeBlob(KEY, req.body);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).end();
};
