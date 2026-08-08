// Instrument calibrations from the asset register whose calibrationDue falls
// within a configurable window (default: 14 days from today) — #305.
//
// The per-job Test & Tag registers this endpoint ALSO used to scan were
// deleted with the job-page rebuild; the `tags` key stays in the response as
// an always-empty array so legacy consumers don't break on shape.
//
//   GET /api/tags-expiring
//     ?withinDays=N  (default: 14)   — include items expiring in the next N days
//
// Response: {
//   tags: [],   // always empty — the per-job registers are gone
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
//   - admin tier: all calibrations
//   - leadingHand / tradie: calibrations on gear THEY currently hold
//   - clients: 403
//
// The computation itself lives in api/_lib/tag-compliance.js — the SAME
// rows feed the daily reminder cron in api/notifications.js, so the numbers
// can never disagree.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isAdminRole, isClientRole } = require('./_lib/auth');
const { isFlagEnabled } = require('./_lib/feature-flags');
const { expiringCalibrationRows } = require('./_lib/tag-compliance');
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

  // Per-job Test & Tag registers were deleted (the job-page rebuild) — the
  // response keeps the `tags` key as an ALWAYS-EMPTY array so legacy
  // consumers don't break, but nothing scans jobs/<id>/tags.json anymore.
  const tags = [];

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
