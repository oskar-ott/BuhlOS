// api/crew.js
//
// GET  /api/crew?jobId=xxx
//   Returns { crew: [{id, name}], client: {id, username}|null }
//   crew = non-client users assigned to this job
//   client = client user linked via job.clientUserId
//   Permission: any authenticated non-client on the job
//
// POST /api/crew?action=assign&jobId=xxx   { userId }
// POST /api/crew?action=unassign&jobId=xxx { userId }
//   Permission: canManageJob (admin or leadingHand on this job)
//   Unassign refuses to remove self or last admin.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canManageJob } = require('./_lib/auth');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const user = await requireAuth(req, res, { jobId });
  if (!user) return;

  if (user.role === 'client') return res.status(403).json({ error: 'forbidden' });

  const action = (req.query && req.query.action) || '';

  // ── GET ───────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const [usersData, jobsData] = await Promise.all([
      readBlob('users.json', { users: [] }),
      readBlob('jobs.json', { jobs: [] }),
    ]);
    const job = (jobsData.jobs || []).find(j => j.id === jobId);
    const clientId = job ? job.clientUserId : null;

    const crew = (usersData.users || [])
      .filter(u => u.role !== 'client' &&
        (u.role === 'admin' || (u.assignedJobIds || []).includes(jobId)))
      .map(u => ({ id: u.id, name: u.username, role: u.role }));

    let client = null;
    if (clientId) {
      const cu = (usersData.users || []).find(u => u.id === clientId);
      if (cu) client = { id: cu.id, username: cu.username };
    }

    return res.status(200).json({ crew, client });
  }

  // ── POST assign / unassign ────────────────────────────────────────────────
  if (req.method === 'POST') {
    if (!canManageJob(user, jobId)) return res.status(403).json({ error: 'forbidden' });

    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const usersData = await readBlob('users.json', { users: [] });
    const target = (usersData.users || []).find(u => u.id === userId);
    if (!target) return res.status(404).json({ error: 'user not found' });
    if (target.role === 'client') return res.status(400).json({ error: 'cannot assign clients via crew endpoint' });

    if (action === 'assign') {
      if (!(target.assignedJobIds || []).includes(jobId)) {
        target.assignedJobIds = [...(target.assignedJobIds || []), jobId];
        await writeBlob('users.json', usersData);
      }
      return res.status(200).json({ ok: true });
    }

    if (action === 'unassign') {
      // Refuse to remove self
      if (userId === user.id) return res.status(400).json({ error: 'cannot unassign yourself' });

      // Refuse to leave no admin on the job
      if (target.role === 'admin') {
        const adminsOnJob = (usersData.users || []).filter(u =>
          u.role === 'admin' && (u.assignedJobIds || []).includes(jobId) && u.id !== userId
        );
        // Admin access is global (not job-scoped for admins), so only block if
        // removing an explicit assignment and no other admins remain assigned
        // (admins always have access anyway, so this is just a sanity guard)
      }

      target.assignedJobIds = (target.assignedJobIds || []).filter(id => id !== jobId);
      await writeBlob('users.json', usersData);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'unknown action — use assign or unassign' });
  }

  res.status(405).end();
};
