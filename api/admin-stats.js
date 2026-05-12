// At-a-glance system stats for admin dashboards.
//
//   GET /api/admin-stats
//
// Returns the kind of numbers you'd put on a header strip above the
// operations dashboard — total users, active jobs, open snag counts by
// priority, and how many of the open ones are already "stale" by the
// same thresholds the Monday escalation push uses. Cheap call: at most
// jobs.json + users.json + per-active-job data.json.
//
// Response shape:
//   {
//     asOf,
//     users: { total, byRole: { admin, leadingHand, tradie, client },
//              archived, withPushEnabled },
//     jobs:  { active, archived, totalAreas },
//     snags: { openTotal, openHigh, openMedium, openLow,
//              staleTotal, staleHigh },
//   }
//
// Why this exists:
//   The operations dashboard wants a one-line "the business right now"
//   strip — without summing it client-side from three separate fetches.
//   This endpoint pre-aggregates the things admins actually scan.
//
// Permissions: admin only.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_THRESHOLDS = { High: 3, Medium: 7, Low: 14 };

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res, { roles: ['admin'] });
  if (!me) return;

  // ── Users ──────────────────────────────────────────────────────────────
  const usersBlob = await readBlob('users.json', { users: [] });
  const allUsers  = usersBlob.users || [];
  const byRole = { admin: 0, leadingHand: 0, tradie: 0, client: 0 };
  let archived = 0;
  let withPushEnabled = 0;
  for (const u of allUsers) {
    if (u.archived) { archived++; continue; }
    if (byRole[u.role] !== undefined) byRole[u.role]++;
    if (Array.isArray(u.pushSubscriptions) && u.pushSubscriptions.length) {
      withPushEnabled++;
    }
  }
  const usersTotal = byRole.admin + byRole.leadingHand + byRole.tradie + byRole.client;

  // ── Jobs ───────────────────────────────────────────────────────────────
  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const allJobs  = jobsBlob.jobs || [];
  let activeJobs = 0;
  let archivedJobs = 0;
  let totalAreas = 0;
  const active = [];
  for (const j of allJobs) {
    const status = j.status || 'active';
    if (status === 'archived') archivedJobs++;
    else { activeJobs++; active.push(j); }
    for (const g of (j.areaGroups || [])) {
      totalAreas += (g.areas || []).length;
    }
  }

  // ── Snags (open only, across active jobs) ──────────────────────────────
  let openTotal = 0;
  let openHigh = 0, openMedium = 0, openLow = 0;
  let staleTotal = 0, staleHigh = 0;
  const now = Date.now();

  // Parallel — bounded by active-job count.
  await Promise.all(active.map(async j => {
    let data;
    try { data = await readBlob(`jobs/${j.id}/data.json`, { snags: [] }); }
    catch { return; }
    for (const s of (data.snags || [])) {
      if ((s.status || 'Open') !== 'Open') continue;
      openTotal++;
      const prio = s.priority || 'Medium';
      if (prio === 'High') openHigh++;
      else if (prio === 'Low') openLow++;
      else openMedium++;

      const createdRaw = s.createdAt || s.date || '';
      if (createdRaw) {
        const t = Date.parse(createdRaw);
        if (Number.isFinite(t)) {
          const ageDays = (now - t) / DAY_MS;
          const threshold = STALE_THRESHOLDS[prio] ?? STALE_THRESHOLDS.Medium;
          if (ageDays >= threshold) {
            staleTotal++;
            if (prio === 'High') staleHigh++;
          }
        }
      }
    }
  }));

  return res.status(200).json({
    asOf: new Date().toISOString(),
    users: {
      total: usersTotal,
      byRole,
      archived,
      withPushEnabled,
    },
    jobs: {
      active: activeJobs,
      archived: archivedJobs,
      totalAreas,
    },
    snags: {
      openTotal,
      openHigh, openMedium, openLow,
      staleTotal, staleHigh,
    },
  });
};
