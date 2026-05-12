// Fast-path single snag creation.
//
//   POST /api/snag-quick-raise?jobId=<id>
//        body: { dwelling, desc, priority?, stage?, photos?,
//                assignedToUserId?, clientVisible? }
//
// Appends one snag to jobs/<jobId>/data.json. Same wire-format as
// posting a snag via /api/data, but without uploading the entire
// snags + dwellings document on a 3G mobile connection.
//
// Auto-assign-on-raise is preserved (same rule as /api/data POST): a
// snag posted without an explicit assignee gets routed to a Leading
// Hand assigned to this job (alphabetical, deterministic). Manual
// overrides win.
//
// Fire-and-forget push to the auto-assigned LH (or to the explicit
// assignee when the caller set one and it isn't themselves).
//
// Response:
//   { snag: { ...full saved record } }
//
// Permissions: write access (admin / LH / tradie assigned).
// Client: 403.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');
const { sendPushToUserId } = require('./_lib/push');

const VALID_PRIORITY = new Set(['High', 'Medium', 'Low']);
const MAX_DESC = 1000;
const MAX_PHOTOS = 5;

function newSnagId() {
  return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function pickLeadingHandFor(jobId) {
  const usersBlob = await readBlob('users.json', { users: [] }).catch(() => ({ users: [] }));
  const lhs = (usersBlob.users || [])
    .filter(u => u.role === 'leadingHand' && !u.archived && (u.assignedJobIds || []).includes(jobId))
    .sort((a, b) => (a.username || '').localeCompare(b.username || ''));
  return lhs[0] || null;
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const me = await requireAuth(req, res, { jobId });
  if (!me) return;
  if (me.role === 'client') return res.status(403).json({ error: 'forbidden' });
  if (!canWrite(me, jobId)) return res.status(403).json({ error: 'no write access to job' });

  const body = req.body || {};
  const dwelling = (body.dwelling || '').toString();
  const desc     = (body.desc     || '').toString().trim();
  let priority   = (body.priority || 'Medium').toString();
  const stage    = body.stage ? String(body.stage).trim() : '';
  const photos   = Array.isArray(body.photos) ? body.photos.slice(0, MAX_PHOTOS) : [];
  const assignedToUserId = body.assignedToUserId
    ? String(body.assignedToUserId)
    : '';
  const clientVisible = body.clientVisible === true;

  if (!dwelling) return res.status(400).json({ error: 'dwelling required' });
  if (!desc)     return res.status(400).json({ error: 'desc required' });
  if (desc.length > MAX_DESC) {
    return res.status(400).json({ error: `desc too long (max ${MAX_DESC})` });
  }
  if (!VALID_PRIORITY.has(priority)) priority = 'Medium';

  // Verify the dwelling exists on the job.
  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const job = (jobsBlob.jobs || []).find(j => j.id === jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  const area = (job.areaGroups || [])
    .flatMap(g => (g.areas || []))
    .find(a => a.id === dwelling);
  if (!area) return res.status(404).json({ error: 'dwelling not found on job' });

  // Optional: validate explicit assignee exists.
  let explicitAssignee = null;
  if (assignedToUserId) {
    const users = await readBlob('users.json', { users: [] });
    explicitAssignee = (users.users || []).find(u => u.id === assignedToUserId);
    if (!explicitAssignee) {
      return res.status(400).json({ error: 'assignedToUserId not found' });
    }
  }

  // Build the snag record.
  const nowIso = new Date().toISOString();
  const snag = {
    id:        newSnagId(),
    dwelling,
    desc,
    priority,
    stage:     stage || '',
    status:    'Open',
    by:        me.username,
    createdAt: nowIso,
    photos:    photos.filter(p => p && p.id && p.url).map(p => ({
      id: p.id, url: p.url,
      addedBy: p.addedBy || me.username,
      addedAt: p.addedAt || nowIso,
    })),
    clientVisible,
  };

  // Auto-assign rule (mirrors /api/data POST behaviour).
  let autoAssigned = false;
  if (explicitAssignee) {
    snag.assignedToUserId = explicitAssignee.id;
    snag.assignedToName   = explicitAssignee.username;
    snag.updatedBy        = me.username;
    snag.updatedAt        = nowIso;
  } else {
    const lh = await pickLeadingHandFor(jobId);
    if (lh) {
      snag.assignedToUserId = lh.id;
      snag.assignedToName   = lh.username;
      snag.autoAssigned     = true;
      snag.updatedBy        = me.username;
      snag.updatedAt        = nowIso;
      autoAssigned = true;
    }
  }

  // Read → append → write.
  const KEY = `jobs/${jobId}/data.json`;
  const data = await readBlob(KEY, { dwellings: {}, snags: [], notes: [] });
  data.snags = Array.isArray(data.snags) ? data.snags : [];
  data.snags.push(snag);
  try {
    await writeBlob(KEY, data);
  } catch (e) {
    return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
  }

  // Fire-and-forget push to the assignee (auto or explicit), skip self.
  if (snag.assignedToUserId && snag.assignedToUserId !== me.id) {
    sendPushToUserId(snag.assignedToUserId, {
      title: (snag.priority === 'High' ? '⚠ HIGH · ' : '') + 'Snag assigned to you',
      body:  '[' + (job.name || jobId) + '] ' + snag.desc.slice(0, 140),
      url:   '/jobs/' + jobId + '?snag=' + encodeURIComponent(snag.id) + '#snags',
      tag:   'buhl-snag-assigned-' + snag.id,
    }).catch(() => {});
  }

  return res.status(201).json({ snag, autoAssigned });
};
