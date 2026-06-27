// Confidential worker cost-rate endpoint (#304). ADMIN-TIER ONLY — every method.
// A leading hand can never read or write rates here (and the listTradies leak
// that exposed the legacy users.json hourlyRate is fixed in api/users.js).
//
//   GET  /api/cost-rates?userId=<id>      → { userId, history, current } for one worker
//   GET  /api/cost-rates?action=coverage  → { tracked, rated, unrated[] } across hours-tracked workers
//   POST /api/cost-rates  body { userId, costRateCents, chargeOutRateCents?, effectiveFrom }
//        → appends a new effective-dated rate (never overwrites); returns the updated history
//
// MONEY IS INTEGER CENTS. History entries carry setBy/setByName/setAt so every
// edit is attributable (the AC's editor+timestamp requirement) without writing
// the dollar amount into the cross-job audit journal.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isAdminRole } = require('./_lib/auth');
const {
  readCostRates,
  writeCostRates,
  historyFor,
  effectiveCostRate,
  validateRateInput,
  appendRate,
  costRateCoverage,
} = require('./_lib/cost-rates');

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const me = await requireAuth(req, res);
  if (!me) return;
  if (!isAdminRole(me.role)) return res.status(403).json({ error: 'admin only' });

  const q = req.query || {};
  const action = q.action || '';

  if (req.method === 'GET') {
    if (action === 'coverage') {
      const [data, usersBlob] = await Promise.all([
        readCostRates(),
        readBlob('users.json', { users: [] }),
      ]);
      return res.status(200).json(costRateCoverage(usersBlob.users || [], data));
    }
    const userId = String(q.userId || '');
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const data = await readCostRates();
    const history = historyFor(data, userId);
    return res.status(200).json({
      userId,
      history,
      current: effectiveCostRate(history, todayIso()),
    });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const userId = String(body.userId || '');
    if (!userId) return res.status(400).json({ error: 'userId required' });

    // The target must be a real, hours-tracked worker — a cost rate on an
    // office account or a non-existent id is meaningless.
    const usersBlob = await readBlob('users.json', { users: [] });
    const target = (usersBlob.users || []).find((u) => u.id === userId);
    if (!target) return res.status(404).json({ error: 'user not found' });

    const parsed = validateRateInput(body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });

    const data = await readCostRates();
    const next = appendRate(data, userId, parsed.value, me);
    await writeCostRates(next);

    const history = historyFor(next, userId);
    return res.status(201).json({
      userId,
      history,
      current: effectiveCostRate(history, todayIso()),
    });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
