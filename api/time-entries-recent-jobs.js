// Return the up-to-5 distinct job IDs the current user has logged hours on most
// recently. Used by the log-hours modal's "Recent" section in the job picker.

const { setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');
const { listUserEntries } = require('./_lib/time-entries');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const user = await requireAuth(req, res);
  if (!user) return;

  const entries = await listUserEntries(user.id);
  const seen = new Set();
  const recent = [];
  for (const e of entries) {
    for (const a of (e.allocations || [])) {
      if (a.jobId && !seen.has(a.jobId)) {
        seen.add(a.jobId);
        recent.push(a.jobId);
        if (recent.length >= 5) break;
      }
    }
    if (recent.length >= 5) break;
  }
  return res.status(200).json({ jobIds: recent });
};
