// Computes labour cost rollups per job (hours × tradie hourlyRate).
const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const me = await requireAuth(req, res, { roles: ['admin'] });
  if (!me) return;

  const jobsData = await readBlob('jobs.json', { jobs: [] });
  const usersData = await readBlob('users.json', { users: [] });
  const rates = {};
  for (const u of usersData.users || []) {
    if (u.role === 'tradie') rates[u.username.toLowerCase()] = Number(u.hourlyRate) || 0;
  }

  const rows = [];
  let grandHours = 0, grandCost = 0;
  for (const job of jobsData.jobs || []) {
    const h = await readBlob(`jobs/${job.id}/hours.json`, { entries: [] });
    let hrs = 0, cost = 0;
    for (const e of h.entries || []) {
      const names = Array.isArray(e.crew) ? e.crew : [{ name: e.name, hours: e.hours }];
      for (const c of names) {
        const hh = Number(c.hours) || 0;
        const rate = rates[String(c.name || '').toLowerCase()] || 0;
        hrs += hh; cost += hh * rate;
      }
    }
    rows.push({ id: job.id, name: job.name, status: job.status || 'active', hours: hrs, cost });
    grandHours += hrs; grandCost += cost;
  }
  res.status(200).json({ jobs: rows, totals: { hours: grandHours, cost: grandCost } });
};
