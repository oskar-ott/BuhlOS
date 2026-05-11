// Org-wide policy thresholds (admin-only on writes).
//
// Currently surfaces a single setting — the hours-anomaly threshold
// that the bulk-approve rule and <rate-flag> chip read on the
// approvals surface. Brief §09 H-02 calls out the threshold as a
// configurable rule, not a hardcoded 9h.
//
// Storage: policy.json
//   { hours: { dailyThreshold: 9 } }
//
// GET  /api/policy     → admin + leadingHand + office + accounts
// PUT  /api/policy     → admin only
//   body: { hours: { dailyThreshold: <number, 1..24> } }

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');

const KEY = 'policy.json';
const DEFAULTS = {
  hours: {
    dailyThreshold: 9,
  },
};

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    // Anyone with site-office access reads policy.
    const me = await requireAuth(req, res, { roles: ['admin', 'leadingHand', 'office', 'accounts'] });
    if (!me) return;
    const stored = await readBlob(KEY, null);
    return res.status(200).json({ policy: mergePolicy(stored) });
  }

  if (req.method === 'PUT') {
    const me = await requireAuth(req, res, { roles: ['admin'] });
    if (!me) return;
    const body = req.body || {};
    if (!body.hours || typeof body.hours.dailyThreshold !== 'number') {
      return res.status(400).json({ error: 'hours.dailyThreshold (number) required' });
    }
    const n = Number(body.hours.dailyThreshold);
    if (!Number.isFinite(n) || n < 1 || n > 24) {
      return res.status(400).json({ error: 'hours.dailyThreshold must be between 1 and 24' });
    }
    const stored = await readBlob(KEY, null);
    const next = mergePolicy(stored);
    next.hours.dailyThreshold = Math.round(n * 100) / 100;
    next.updatedAt = new Date().toISOString();
    next.updatedBy = me.id;
    await writeBlob(KEY, next);
    return res.status(200).json({ policy: next });
  }

  return res.status(405).json({ error: 'method not allowed' });
};

function mergePolicy(stored) {
  const s = stored || {};
  return {
    hours: {
      dailyThreshold: (s.hours && Number.isFinite(s.hours.dailyThreshold))
        ? s.hours.dailyThreshold
        : DEFAULTS.hours.dailyThreshold,
    },
    updatedAt: s.updatedAt || null,
    updatedBy: s.updatedBy || null,
  };
}
