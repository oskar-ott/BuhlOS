const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');
const { sendPushToUserId } = require('./_lib/push');

const VALID_TASK_STATES = new Set(['not_started', 'in_progress', 'complete']);

// dwellings[id] is a free-form bag — known fields:
//   roughIn.tasks   { taskId: 'not_started'|'in_progress'|'complete' }
//   fitOff.tasks    { taskId: 'not_started'|'in_progress'|'complete' }
//   materials       { code: positive-int-qty, ... }   // Phase 9 — admin-confirmed
//                                                       counts from plan takeoff;
//                                                       writes also accepted via
//                                                       /api/plans?action=set-dwelling-materials
// Validation only enforces the known shape (task states); other fields flow
// through unchanged. The full POST replaces the data blob, so the client must
// re-fetch before mutating to avoid stomping concurrent writes.

// Scans dwellings for roughIn/fitOff task values and rejects anything that
// isn't a valid three-state string. Returns an error string or null.
function validateTaskStates(body) {
  const dwellings = body && body.dwellings;
  if (!dwellings || typeof dwellings !== 'object') return null;
  for (const [dwId, dw] of Object.entries(dwellings)) {
    for (const stageKey of ['roughIn', 'fitOff']) {
      const tasks = dw && dw[stageKey] && dw[stageKey].tasks;
      if (!tasks || typeof tasks !== 'object') continue;
      for (const [taskId, val] of Object.entries(tasks)) {
        if (!VALID_TASK_STATES.has(val)) {
          return `dwellings.${dwId}.${stageKey}.tasks.${taskId}: invalid value "${val}" (must be not_started|in_progress|complete)`;
        }
      }
    }
  }
  return null;
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const user = await requireAuth(req, res, { jobId });
  if (!user) return;

  const KEY = `jobs/${jobId}/data.json`;

  if (req.method === 'GET') {
    const data = await readBlob(KEY, { dwellings: {}, snags: [], notes: [] });
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
    const err = validateTaskStates(req.body);
    if (err) return res.status(400).json({ error: err });
    try {
      // Snag auto-assign-on-raise:
      // Diff the previous snags array against the new one; for any newly-added
      // snag without an explicit assignee, route it to a Leading Hand on this
      // job. This kills the "everything lands in Unassigned then admin
      // triages" backlog — tradies just file, the LH gets it. Manual
      // overrides (a snag posted with assignedToUserId already set) win.
      //
      // We mutate req.body in place because the writeBlob call below
      // persists the same object the response is built from.
      const previous = await readBlob(KEY, { snags: [] });
      const newlyRaised = findNewlyRaisedSnags(previous, req.body);
      let autoAssignedAny = false;
      if (newlyRaised.length) {
        const lh = await pickLeadingHandFor(jobId);
        if (lh) {
          const nowIso = new Date().toISOString();
          for (const s of newlyRaised) {
            // Skip when client already set an explicit assignee
            // (admin/LH raising a snag from the triage queue, or an LH
            // assigning to themselves on raise).
            if (s.assignedToUserId) continue;
            s.assignedToUserId = lh.id;
            s.assignedToName   = lh.username;
            s.autoAssigned     = true;            // for client display + audit
            s.updatedBy        = user.username;
            s.updatedAt        = nowIso;
            autoAssignedAny = true;
          }
        }
      }

      await writeBlob(KEY, req.body);

      // Best-effort push to each newly auto-assigned LH (skip self when the
      // LH raised the snag themselves). Fire-and-forget; never blocks the
      // response.
      if (autoAssignedAny) {
        const jobsBlob = await readBlob('jobs.json', { jobs: [] }).catch(() => ({ jobs: [] }));
        const jobName = ((jobsBlob.jobs || []).find(j => j.id === jobId) || {}).name || jobId;
        for (const s of newlyRaised) {
          if (!s.autoAssigned || !s.assignedToUserId) continue;
          if (s.assignedToUserId === user.id) continue;
          sendPushToUserId(s.assignedToUserId, {
            title: (s.priority === 'High' ? '⚠ HIGH · ' : '') + 'Snag assigned to you',
            body:  '[' + jobName + '] ' + String(s.desc || '(no description)').slice(0, 140),
            url:   '/jobs/' + jobId + '?snag=' + encodeURIComponent(s.id) + '#snags',
            tag:   'buhl-snag-assigned-' + s.id,
          }).catch(() => {});
        }
      }

      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).end();
};

// Diff helpers — newly-raised snags = present in `next.snags` by id but not
// in `prev.snags`. Doesn't look at content; status-changes / edits are not
// "newly raised" and get no auto-assign treatment.
function findNewlyRaisedSnags(prev, next) {
  const oldIds = new Set((prev && prev.snags) ? prev.snags.map(s => s && s.id).filter(Boolean) : []);
  const nextSnags = (next && next.snags) || [];
  return nextSnags.filter(s => s && s.id && !oldIds.has(s.id));
}

// Pick the Leading Hand to auto-route a snag to. Strategy:
//   1. LHs assigned to this job, sorted alphabetically — first wins.
//   2. If none, returns null and the snag stays unassigned (admin triages).
// Deterministic so multiple snags filed in the same write all go to the
// same LH; single-LH jobs (the common case) get the obvious answer.
async function pickLeadingHandFor(jobId) {
  const usersBlob = await readBlob('users.json', { users: [] }).catch(() => ({ users: [] }));
  const lhs = (usersBlob.users || [])
    .filter(u => u.role === 'leadingHand' && (u.assignedJobIds || []).includes(jobId))
    .sort((a, b) => (a.username || '').localeCompare(b.username || ''));
  return lhs[0] || null;
}
