// Client portal — a single sanitised job overview (Epic 16 / #271).
//
//   GET /api/portal-job?jobId=<id>
//
// The scoped, sanitised SINGLE-job read behind /portal/jobs/<id>. Returns the
// portal allowlist projection (api/_lib/portal-projection.js) for ONE job the
// signed-in client owns — never the raw job payload.
//
// Isolation is the whole point:
//   - A client may read ONLY a job they own (job.clientUserId === me.id).
//   - Any other jobId — another client's job, a non-existent id, a draft /
//     archived / complete job — returns 404 (existence is NOT confirmed). We
//     never 403 with a "you don't own this" that would leak that the id is
//     real; a guessed id is indistinguishable from a missing one.
//
// Scoping key: job.clientUserId === me.id (the single source of truth; this
// endpoint never consults assignedJobIds).
//
// Response: { job: { id, name, siteAddress, status, progressPct, stageLabel } }
//
// Permissions:
//   - client owning the job → 200
//   - client, any other id  → 404
//   - non-client role       → 403 (this is the client surface)
//   - unauthenticated       → 401

const { readBlob, setNoCache } = require('./_lib/blob');
const { getCurrentUser, isClientRole } = require('./_lib/auth');
const { projectJobForClient } = require('./_lib/portal-projection');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'not authenticated' });

  if (!isClientRole(me.role)) return res.status(403).json({ error: 'forbidden' });

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const job = (jobsBlob.jobs || []).find((j) => j.id === jobId);

  // Ownership + status are both resolved as 404. A job that doesn't exist, one
  // owned by another client, or one that's draft/archived/complete are all
  // "not found" from this client's perspective — no signal leaks either way.
  if (!job || job.clientUserId !== me.id) {
    return res.status(404).json({ error: 'job not found' });
  }

  let data;
  try {
    data = await readBlob(`jobs/${jobId}/data.json`, { dwellings: {}, snags: [] });
  } catch {
    data = { dwellings: {}, snags: [] };
  }

  const projected = projectJobForClient(job, data.dwellings || {});
  // projectJobForClient returns null for a non-visible status (draft/archived/
  // complete) — surface that as 404 too, same "existence not confirmed" rule.
  if (!projected) {
    return res.status(404).json({ error: 'job not found' });
  }

  return res.status(200).json({ job: projected });
};
