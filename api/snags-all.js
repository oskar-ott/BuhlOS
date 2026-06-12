// Cross-job defects register listing for admin / leading hand (#414).
//
//   GET /api/snags-all
//     ?status=<v2 status>|all     (default: the ACTIVE statuses —
//                                  open + in_progress + resolved; case-
//                                  insensitive, so the pre-#414 caller
//                                  vocabulary still works: Open→open,
//                                  Closed→closed)
//     ?priority=low|normal|high|urgent   (optional; case-insensitive;
//                                  legacy High/Medium/Low accepted —
//                                  Medium maps to normal)
//     ?jobId=<id>                 (optional — restrict to one job)
//     ?assignedToUserId=<id>      (optional — restrict to one assignee;
//                                  use 'unassigned' to filter to no-assignee)
//
// Response: { snags: [RegisterSnag...], jobs: [{ id, name }] }
//   RegisterSnag = { id, source: 'v2'|'legacy', jobId, jobName, jobStatus,
//                    title, status, priority, areaName, assignedToName,
//                    createdAt, evidenceCount }
//
// #414 reshaped this response: the endpoint had ZERO consumers since the
// legacy cutover (#376), so the old legacy-only flat shape (desc/dwelling/
// photoCount/...) was replaced by the normalised register shape that
// serves BOTH per-job stores:
//   - snags[]   (legacy)  — status Open|Closed, priority High|Medium|Low
//   - snagsV2[] (live)    — written by api/snags.js, six-status lifecycle
// Legacy values are mapped INTO the v2 vocabulary (Open→open,
// Closed→closed; High→high, Medium→normal, Low→low) — no new vocabulary.
//
// The mapping contract lives in src/domains/snags/register.ts
// (normaliseLegacySnag / normaliseV2Snag / compareRegisterSnags) and the
// API-harness test uses those functions as the oracle, so this CJS copy
// cannot drift silently. Keep both in sync.
//
// Sorted: active rows first (open/in_progress/resolved), then priority
// (urgent→low), then OLDEST first, then id (stable).
//
// Permissions (UNCHANGED by #414):
//   - admin: all jobs
//   - leadingHand: only jobs in their assignedJobIds
//   - everyone else: 403

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isStaffRole, isAdminRole } = require('./_lib/auth');

const V2_STATUSES = new Set(['open', 'in_progress', 'resolved', 'verified', 'closed', 'rejected']);
const V2_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
// Default filter = the snags domain's isActive() set (register.ts
// REGISTER_DEFAULT_STATUSES). Verified/closed are done; rejected waits on
// the worker — none belong in the office's default chasing queue.
const DEFAULT_STATUSES = new Set(['open', 'in_progress', 'resolved']);
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

function parseStatusParam(v) {
  if (!v) return null; // default → DEFAULT_STATUSES
  const low = String(v).toLowerCase();
  if (low === 'all') return 'all';
  return V2_STATUSES.has(low) ? low : null;
}

function parsePriorityParam(v) {
  if (!v) return null;
  const low = String(v).toLowerCase();
  if (low === 'medium') return 'normal'; // legacy caller vocabulary
  return V2_PRIORITIES.has(low) ? low : null;
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

// Mirrors src/domains/snags/register.ts normaliseLegacySnag — keep in sync.
function normaliseLegacy(s, ctx) {
  const dwelling = str(s.dwelling);
  const resolved = dwelling ? (ctx.areaNameById[dwelling] || dwelling) : null;
  return {
    id: str(s.id),
    source: 'legacy',
    jobId: ctx.jobId,
    jobName: ctx.jobName,
    jobStatus: ctx.jobStatus,
    title: str(s.desc),
    status: s.status === 'Closed' ? 'closed' : 'open',
    priority: s.priority === 'High' ? 'high' : s.priority === 'Low' ? 'low' : 'normal',
    areaName: resolved,
    assignedToName: str(s.assignedToName) || null,
    createdAt: str(s.createdAt) || str(s.date),
    evidenceCount: Array.isArray(s.photos) ? s.photos.length : 0,
  };
}

// Mirrors src/domains/snags/register.ts normaliseV2Snag — keep in sync.
function normaliseV2(s, ctx) {
  const status = str(s.status);
  const priority = str(s.priority);
  return {
    id: str(s.id),
    source: 'v2',
    jobId: ctx.jobId,
    jobName: ctx.jobName,
    jobStatus: ctx.jobStatus,
    title: str(s.title),
    status: V2_STATUSES.has(status) ? status : 'open',
    priority: V2_PRIORITIES.has(priority) ? priority : 'normal',
    areaName: str(s.areaName) || null,
    assignedToName: str(s.assignedToName) || null,
    createdAt: str(s.createdAt),
    evidenceCount: Array.isArray(s.evidenceIds) ? s.evidenceIds.length : 0,
  };
}

function isActiveStatus(status) {
  return DEFAULT_STATUSES.has(status);
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res);
  if (!me) return;
  if (!isStaffRole(me.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const q = req.query || {};
  const wantStatus = parseStatusParam(q.status);
  const wantPrio   = parsePriorityParam(q.priority);
  const wantJobId  = q.jobId || '';
  const wantAssign = q.assignedToUserId || '';

  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const allJobs = jobsBlob.jobs || [];
  let visible = isAdminRole(me.role)
    ? allJobs
    : allJobs.filter(j => (me.assignedJobIds || []).includes(j.id));
  if (wantJobId) visible = visible.filter(j => j.id === wantJobId);

  const collected = await Promise.all(visible.map(async job => {
    let data;
    try {
      data = await readBlob('jobs/' + job.id + '/data.json', { dwellings: {}, snags: [] });
    } catch (e) { return []; }
    const areaNameById = {};
    for (const g of (job.areaGroups || [])) {
      for (const a of (g.areas || [])) areaNameById[a.id] = a.name;
    }
    const ctx = {
      jobId: job.id,
      jobName: job.name,
      jobStatus: job.status || 'active',
      areaNameById,
    };

    // Assignee filter has to read the RAW rows — the stores keep the id
    // under different fields (legacy assignedToUserId / v2 assignedToId)
    // and the normalised shape only carries the display name.
    const assignMatches = (assigneeId) => {
      if (!wantAssign) return true;
      if (wantAssign === 'unassigned') return !assigneeId;
      return assigneeId === wantAssign;
    };

    const out = [];
    for (const s of (data.snags || [])) {
      if (!s || !assignMatches(s.assignedToUserId)) continue;
      out.push(normaliseLegacy(s, ctx));
    }
    for (const s of (Array.isArray(data.snagsV2) ? data.snagsV2 : [])) {
      if (!s || !assignMatches(s.assignedToId)) continue;
      out.push(normaliseV2(s, ctx));
    }
    return out.filter(item => {
      if (wantStatus) {
        if (wantStatus !== 'all' && item.status !== wantStatus) return false;
      } else if (!DEFAULT_STATUSES.has(item.status)) {
        return false; // default view = the active statuses
      }
      if (wantPrio && item.priority !== wantPrio) return false;
      return true;
    });
  }));

  // Flatten + sort — mirrors register.ts compareRegisterSnags:
  // active-first, priority urgent→low, oldest createdAt first, id stable.
  const snags = [].concat.apply([], collected).sort((a, b) => {
    const activeDelta = (isActiveStatus(a.status) ? 0 : 1) - (isActiveStatus(b.status) ? 0 : 1);
    if (activeDelta !== 0) return activeDelta;
    const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (pr !== 0) return pr;
    const created = a.createdAt.localeCompare(b.createdAt);
    if (created !== 0) return created;
    return a.id.localeCompare(b.id);
  });

  return res.status(200).json({ snags, jobs: visible.map(j => ({ id: j.id, name: j.name })) });
};
