// Client portal — the signed-in client's own jobs (Epic 16 / #271).
//
//   GET /api/portal-jobs
//
// The scoped, sanitised job LIST behind /portal. Returns ONLY the jobs the
// signed-in client owns (job.clientUserId === me.id), each projected through
// the portal allowlist (api/_lib/portal-projection.js) — never the raw job.
//
// Scoping key: job.clientUserId === me.id is the single source of truth for
// client→job linkage (declared by this foundation; see docs/client-portal.md).
// This endpoint NEVER consults assignedJobIds, so re-linking a job's client in
// the builder immediately re-scopes the portal — no stale access.
//
// Status: draft / archived / complete jobs are filtered out (a linked draft
// must not leak its existence, name or progress before publish — the
// #386 regression, defended again here and in the projection).
//
// Response:
//   { count, jobs: [{ id, name, siteAddress, status, progressPct, stageLabel }] }
//
// Permissions:
//   - client            → their own active jobs only
//   - everyone else     → 403 (this is the client surface; staff use /v2/jobs)
//   - unauthenticated   → 401

const { readBlob, setNoCache } = require('./_lib/blob');
const { getCurrentUser, isClientRole } = require('./_lib/auth');
const { projectJobForClient, isClientVisibleStatus } = require('./_lib/portal-projection');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'not authenticated' });

  // The portal is the client surface only. Staff have /v2/jobs; admitting them
  // here would just widen the projection's audience for no product need. 403
  // keeps the boundary sharp (and the tests assert it).
  if (!isClientRole(me.role)) return res.status(403).json({ error: 'forbidden' });

  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const allJobs = jobsBlob.jobs || [];

  // Scope FIRST (ownership + status), THEN project. Both filters are defence in
  // depth: the projection also returns null for a non-visible status.
  const owned = allJobs.filter(
    (j) => j.clientUserId === me.id && isClientVisibleStatus(j.status),
  );

  // Progress needs each job's data.json (dwellings). Parallel, fail-soft: a job
  // whose data blob can't be read still lists with progressPct null.
  const rows = await Promise.all(
    owned.map(async (j) => {
      let data;
      try {
        data = await readBlob(`jobs/${j.id}/data.json`, { dwellings: {}, snags: [] });
      } catch {
        data = { dwellings: {}, snags: [] };
      }
      return projectJobForClient(j, data.dwellings || {});
    }),
  );

  // Drop any null the projection returned (belt-and-braces; the filter above
  // already excluded non-visible statuses).
  const jobs = rows.filter(Boolean);

  // Most-complete-looking first is unhelpful; keep it stable by name so the
  // client's list order doesn't jump around between polls.
  jobs.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  return res.status(200).json({ count: jobs.length, jobs });
};
