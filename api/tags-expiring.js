// Cross-job listing of test & tag entries whose expiryDate falls within
// a configurable window (default: 14 days from today), plus instrument
// calibrations from the asset register (#305).
//
//   GET /api/tags-expiring
//     ?withinDays=N  (default: 14)   — include items expiring in the next N days
//     ?jobId=<id>                    — restrict tags to one job (optional)
//
// Response: {
//   tags: [{ id, jobId, jobName, tagNumber, applianceType, owner, result,
//            expiryDate, expiryISO, daysToExpiry, status }],
//   calibrations: [{ kind, key, assetId, assetName, identifier, holderId,
//                    holderName, calibrationDue, daysToExpiry, status }],
//   withinDays
// }
//   - daysToExpiry: signed integer; <0 means already expired.
//   - status: 'expired' | 'expiring' (within window) — never 'ok' (those are filtered out).
//
// Sorting: expired-first (oldest expiry first), then earliest upcoming.
//
// Visibility:
//   - admin tier: all jobs' tags + all calibrations
//   - leadingHand / tradie: tags on their assignedJobIds + calibrations on
//     gear THEY currently hold
//   - clients: 403
//
// The computation itself lives in api/_lib/tag-compliance.js — the SAME
// rows feed the daily reminder cron in api/notifications.js and the admin
// compliance view, so the numbers can never disagree.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isAdminRole, isClientRole } = require('./_lib/auth');
const { isFlagEnabled } = require('./_lib/feature-flags');
const { expiringTagRows, expiringCalibrationRows } = require('./_lib/tag-compliance');
const { tagsFromBlob } = require('./_lib/tags-store');
const { listAllAssets } = require('./_lib/assets');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res);
  if (!me) return;
  // #760: gear is an owner kill-switch feature. When turned off, the whole
  // surface 404s (masking it) — same pattern as the register flags.
  if (!(await isFlagEnabled('gear', me))) return res.status(404).json({ error: 'not found' });
  if (isClientRole(me.role)) return res.status(403).json({ error: 'forbidden' });

  const q = req.query || {};
  const withinDays = Math.max(1, Math.min(365, Number(q.withinDays) || 14));
  const filterJobId = q.jobId || '';

  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const allJobs = jobsBlob.jobs || [];
  let visible = isAdminRole(me.role)
    ? allJobs
    : allJobs.filter(j => (me.assignedJobIds || []).includes(j.id));
  if (filterJobId) visible = visible.filter(j => j.id === filterJobId);

  // Read each job's tags.json in parallel (same as the pre-#305 endpoint).
  const tagsByJobId = {};
  await Promise.all(visible.map(async job => {
    try {
      const blob = await readBlob('jobs/' + job.id + '/tags.json', { tags: [] });
      tagsByJobId[job.id] = tagsFromBlob(blob); // tolerate legacy bare-array blobs
    } catch (e) { tagsByJobId[job.id] = []; }
  }));

  const tagRows = expiringTagRows(visible, tagsByJobId, { withinDays });
  // Back-compat: the legacy consumers read `tags` with exactly these keys
  // (raw tag id, ''-defaulted strings) — `key` stays internal to the loop.
  const tags = tagRows.map(r => ({
    id: r.id,
    jobId: r.jobId,
    jobName: r.jobName,
    tagNumber: r.tagNumber,
    applianceType: r.applianceType,
    owner: r.owner,
    result: r.result,
    expiryDate: r.expiryDate,
    expiryISO: r.expiryISO,
    daysToExpiry: r.daysToExpiry,
    status: r.status,
  }));

  // #305 additive: instrument calibrations from the asset register.
  // Admin tier sees all; everyone else only the gear THEY currently hold.
  let calibrations = [];
  try {
    const assets = await listAllAssets();
    if (assets.length) {
      const usersBlob = await readBlob('users.json', { users: [] });
      const nameById = {};
      for (const u of usersBlob.users || []) nameById[u.id] = u.username || u.name || u.id;
      const rows = expiringCalibrationRows(assets, { withinDays, nameById });
      calibrations = isAdminRole(me.role)
        ? rows
        : rows.filter(r => r.holderId === me.id);
    }
  } catch (e) { calibrations = []; }

  return res.status(200).json({ tags, calibrations, withinDays });
};
