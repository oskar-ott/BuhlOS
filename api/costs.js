// Labour cost rollups per job and per user.
//
// Source of truth post-cutover: time-entries (per-user, per-day, with
// per-job allocations). Cost is allocation hours × user.hourlyRate.
//
// Reads users/<id>/time-entries/<date>.json directly via blob list/fetch
// — same pattern as /api/time-entries-overview. Single endpoint covers the
// /admin → Costs tab.

const { list } = require('@vercel/blob');
const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const me = await requireAuth(req, res, { roles: ['admin'] });
  if (!me) return;

  // Optional date-range filter — if absent, returns lifetime totals.
  const q = req.query || {};
  const fromDate = q.fromDate || '';
  const toDate   = q.toDate   || '';
  if (fromDate && !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    return res.status(400).json({ error: 'fromDate must be YYYY-MM-DD' });
  }
  if (toDate && !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    return res.status(400).json({ error: 'toDate must be YYYY-MM-DD' });
  }
  if (fromDate && toDate && fromDate > toDate) {
    return res.status(400).json({ error: 'fromDate must be <= toDate' });
  }

  // ── Reference data: jobs + users (for rates and display names) ──
  const [jobsData, usersData] = await Promise.all([
    readBlob('jobs.json',  { jobs: [] }),
    readBlob('users.json', { users: [] }),
  ]);
  const rateByUserId = {};
  const userById = {};
  for (const u of usersData.users || []) {
    userById[u.id] = u;
    // Both tradies and LHs can have hourlyRate set; admins/clients don't.
    if (u.role === 'tradie' || u.role === 'leadingHand') {
      rateByUserId[u.id] = Number(u.hourlyRate) || 0;
    }
  }

  // ── Walk all time-entries blobs ──
  // Date filter happens at the path level (cheap, before fetch) using the
  // YYYY-MM-DD segment in users/<uid>/time-entries/<date>.json.
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  let entryBlobs = [];
  try {
    const r = await list({ prefix: 'users/', token, limit: 5000 });
    entryBlobs = (r.blobs || []).filter(b => {
      if (!b.pathname.includes('/time-entries/')) return false;
      if (b.pathname.includes('/time-entries-audit/')) return false;
      if (!b.pathname.endsWith('.json')) return false;
      if (!fromDate && !toDate) return true;
      const m = b.pathname.match(/\/time-entries\/(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m) return false;
      const d = m[1];
      if (fromDate && d < fromDate) return false;
      if (toDate   && d > toDate)   return false;
      return true;
    });
  } catch (e) {
    return res.status(502).json({ error: 'blob list failed: ' + e.message });
  }

  const entries = (await Promise.all(entryBlobs.map(async b => {
    try {
      const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }))).filter(Boolean);

  // ── Aggregate ──────────────────────────────────────────────────────
  // Costs are computed against ALL entries regardless of status — drafts
  // already represent committed work. (Filter by approved-only would be a
  // future enhancement gated by ?status=approved if needed.)
  const byJob  = {};  // jobId -> { hours, cost }
  const byUser = {};  // userId -> { name, hours, cost, rate }
  let grandHours = 0, grandCost = 0;

  for (const e of entries) {
    const rate = rateByUserId[e.userId] || 0;
    const u = userById[e.userId];
    const displayName = e.userName || (u && u.username) || e.userId;
    if (!byUser[e.userId]) {
      byUser[e.userId] = { name: displayName, hours: 0, cost: 0, rate };
    }
    for (const a of (e.allocations || [])) {
      const hrs = Number(a.hours) || 0;
      if (!hrs) continue;
      const c = hrs * rate;
      grandHours += hrs; grandCost += c;
      byUser[e.userId].hours += hrs;
      byUser[e.userId].cost  += c;
      const jobKey = a.jobId || '__internal__';
      if (!byJob[jobKey]) byJob[jobKey] = { hours: 0, cost: 0 };
      byJob[jobKey].hours += hrs;
      byJob[jobKey].cost  += c;
    }
  }

  // Job rows: include all known jobs (even zero-hours) for completeness, then
  // append "Internal (no job)" if any allocations had no jobId.
  const rows = (jobsData.jobs || []).map(j => ({
    id: j.id,
    name: j.name,
    status: j.status || 'active',
    hours: round2((byJob[j.id] && byJob[j.id].hours) || 0),
    cost:  round2((byJob[j.id] && byJob[j.id].cost)  || 0),
  }));
  if (byJob['__internal__']) {
    rows.push({
      id: null, name: 'Internal (no job)', status: 'active',
      hours: round2(byJob['__internal__'].hours),
      cost:  round2(byJob['__internal__'].cost),
    });
  }

  const users = Object.values(byUser)
    .map(u => ({ name: u.name, hours: round2(u.hours), cost: round2(u.cost), rate: u.rate }))
    .sort((a, b) => b.cost - a.cost);

  res.status(200).json({
    range: (fromDate || toDate) ? { fromDate: fromDate || null, toDate: toDate || null } : null,
    jobs: rows,
    users,
    totals: { hours: round2(grandHours), cost: round2(grandCost) },
  });
};

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
