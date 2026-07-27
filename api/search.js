// Cross-resource search for admins / leading hands.
//
//   GET /api/search?q=<text>
//       &types=jobs,users        (optional; defaults to both)
//       &limit=20                 (per-type cap; default 10, max 50)
//
// Lightweight prefix + substring search across the resources Daniel
// most often needs to *find*: jobs (by name), users (by username), and
// Returns a flat de-duplicated list of typed
// results, scored simply — exact / prefix match first, then substring.
//
// Why this exists:
//   guessing which job it was on. The command palette in /admin
//   (PR #36 Phase 04) will consume this when it lands; until then,
//   it's a usable read-only endpoint for any quick lookup UI.
//
// Permissions:
//   - admin: searches all jobs / users
//   - leadingHand: jobs restricted to their assignedJobIds;
//                  users restricted to those on shared jobs
//   - everyone else: 403
//
// Notes:
//   - All matching is case-insensitive.
//   - Results are sorted by score within type, then merged.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isStaffRole, isAdminRole, isLeadingHandRole, isClientRole } = require('./_lib/auth');
const { isFlagEnabled } = require('./_lib/feature-flags');

const TYPES = new Set(['jobs', 'users']);

// Return a score for a haystack match against the lowercased needle.
// 3 = exact, 2 = prefix, 1 = substring, 0 = no match.
function scoreMatch(haystack, needle) {
  if (!haystack) return 0;
  const h = String(haystack).toLowerCase();
  if (h === needle) return 3;
  if (h.startsWith(needle)) return 2;
  if (h.includes(needle)) return 1;
  return 0;
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

  const q = (req.query && req.query.q ? String(req.query.q) : '').trim().toLowerCase();
  if (q.length < 2) {
    return res.status(200).json({ q, results: [] });
  }

  const requestedTypes = (req.query.types ? String(req.query.types) : 'jobs,users')
    .split(',').map(s => s.trim()).filter(s => TYPES.has(s));
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);

  // ── Reference data (always needed for visibility scoping) ────────────
  const [jobsBlob, usersBlob] = await Promise.all([
    readBlob('jobs.json',  { jobs:  [] }),
    readBlob('users.json', { users: [] }),
  ]);
  const allJobs  = jobsBlob.jobs   || [];
  const allUsers = usersBlob.users || [];

  // Visible job set
  const visibleJobIds = isAdminRole(me.role)
    ? new Set(allJobs.map(j => j.id))
    : new Set(me.assignedJobIds || []);
  const visibleJobs = allJobs.filter(j => visibleJobIds.has(j.id));
  const jobNameById = {};
  for (const j of visibleJobs) jobNameById[j.id] = j.name;

  const results = [];

  // ── Jobs ──────────────────────────────────────────────────────────────
  if (requestedTypes.includes('jobs')) {
    const matches = [];
    for (const j of visibleJobs) {
      const s = Math.max(
        scoreMatch(j.name, q),
        scoreMatch(j.id, q),
      );
      if (s > 0) {
        matches.push({
          type: 'job',
          id: j.id,
          label: j.name,
          sub: (j.status || 'active'),
          url: '/v2/jobs/' + j.id,
          _score: s,
        });
      }
    }
    matches.sort((a, b) => b._score - a._score);
    for (const m of matches.slice(0, limit)) {
      delete m._score;
      results.push(m);
    }
  }

  // ── Users ─────────────────────────────────────────────────────────────
  if (requestedTypes.includes('users')) {
    // LH only sees users sharing at least one assigned job.
    let candidates = allUsers;
    if (isLeadingHandRole(me.role)) {
      candidates = candidates.filter(u =>
        u.id === me.id ||
        (u.assignedJobIds || []).some(jid => visibleJobIds.has(jid)));
    }
    const matches = [];
    for (const u of candidates) {
      if (u.archived) continue;
      const s = Math.max(
        scoreMatch(u.username, q),
        scoreMatch(u.email, q),
      );
      if (s > 0) {
        matches.push({
          type: 'user',
          id: u.id,
          label: u.username,
          sub: u.role + (u.email ? ' · ' + u.email : ''),
          // #188: deep-link to the worker's detail drawer (the employees
          // register keys on the same users.json id). Clients have no
          // employee record → no link.
          url: isClientRole(u.role) ? null : '/employees/' + u.id,
          _score: s,
        });
      }
    }
    matches.sort((a, b) => b._score - a._score);
    for (const m of matches.slice(0, limit)) {
      delete m._score;
      results.push(m);
    }
  }

  return res.status(200).json({ q, results });
};
