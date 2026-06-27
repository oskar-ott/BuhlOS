// Crew utilisation (#342, Epic 14). ADMIN-TIER ONLY.
//
//   GET /api/utilisation?weeks=<n>   → { weeks, workers[], crew, asOf }
//
// Per-worker utilisation over the trailing N weeks (default 8, max 26) against
// REAL expected hours (7.6h × Mon–Fri = 38h, NOT the legacy flat 40), plus a
// crew capacity roll-up for the latest week ("can we take this job"). Walks the
// per-user time-entry blobs like api/cash-watch.js — no per-week index. Hours
// are total-logged (all jobs), split approved vs submitted; drafts/rejected are
// excluded. Weeks before a worker's account existed are excluded (not 0%).

const { list } = require('@vercel/blob');
const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isAdminRole, isHoursTrackedWorker } = require('./_lib/auth');
const { trailingWeeks, mondayOf, buildWorkerUtilisation, crewCapacity } = require('./_lib/utilisation');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res);
  if (!me) return;
  if (!isAdminRole(me.role)) return res.status(403).json({ error: 'admin only' });

  const n = Number((req.query && req.query.weeks) || 8);
  const weeksCount = Math.min(26, Math.max(1, Number.isFinite(n) ? Math.floor(n) : 8));
  const today = new Date().toISOString().slice(0, 10);
  const weeks = trailingWeeks(today, weeksCount);
  const weekSet = new Set(weeks);

  const usersBlob = await readBlob('users.json', { users: [] });
  const tracked = (usersBlob.users || []).filter((u) => isHoursTrackedWorker(u));

  // Walk approved/submitted hours, bucketed by user + ISO week.
  const byUserWeek = {}; // userId → weekStart → { approved, submitted }
  try {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    const r = await list({ prefix: 'users/', token, limit: 5000 });
    const entryBlobs = (r.blobs || []).filter((b) =>
      b.pathname.includes('/time-entries/') &&
      !b.pathname.includes('/time-entries-audit/') &&
      b.pathname.endsWith('.json'));
    const entries = (await Promise.all(entryBlobs.map(async (b) => {
      try { const rr = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' }); return rr.ok ? await rr.json() : null; }
      catch { return null; }
    }))).filter(Boolean);
    for (const e of entries) {
      if (!e || !e.date) continue;
      if (e.status !== 'approved' && e.status !== 'submitted') continue;
      const ws = mondayOf(e.date);
      if (!weekSet.has(ws)) continue;
      const hrs = Number(e.totalHours) ||
        (e.allocations || []).reduce((s, a) => s + (Number(a.hours) || 0), 0);
      if (!hrs) continue;
      const u = (byUserWeek[e.userId] ||= {});
      const wk = (u[ws] ||= { approved: 0, submitted: 0 });
      if (e.status === 'approved') wk.approved += hrs; else wk.submitted += hrs;
    }
  } catch (err) {
    console.error('utilisation: walk failed', err && err.message);
  }

  const workers = tracked.map((u) => {
    const createdWeek = u.createdAt ? mondayOf(String(u.createdAt).slice(0, 10)) : '';
    const weekInputs = weeks.map((ws) => {
      const h = (byUserWeek[u.id] && byUserWeek[u.id][ws]) || { approved: 0, submitted: 0 };
      // Expected only once the worker's account existed (else excluded, not 0%).
      const expected = !createdWeek || createdWeek <= ws;
      return { weekStart: ws, approvedHours: h.approved, submittedHours: h.submitted, expected };
    });
    return buildWorkerUtilisation(u.id, u.username || u.id, weekInputs);
  });

  const latest = weeks.length ? weeks[weeks.length - 1] : null;
  return res.status(200).json({
    weeks,
    workers,
    crew: crewCapacity(latest, workers),
    asOf: new Date().toISOString(),
  });
};
