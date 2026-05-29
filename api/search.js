// Cross-resource search for admins / leading hands.
//
//   GET /api/search?q=<text>
//       &types=jobs,snags,users   (optional; defaults to all three)
//       &limit=20                 (per-type cap; default 10, max 50)
//
// Lightweight prefix + substring search across the resources Daniel
// most often needs to *find*: jobs (by name), users (by username), and
// snags (by description). Returns a flat de-duplicated list of typed
// results, scored simply — exact / prefix match first, then substring.
//
// Why this exists:
//   "Where was that meter-box snag again?" — answered without first
//   guessing which job it was on. The command palette in /admin
//   (PR #36 Phase 04) will consume this when it lands; until then,
//   it's a usable read-only endpoint for any quick lookup UI.
//
// Permissions:
//   - admin: searches all jobs / snags / users
//   - leadingHand: snags & jobs restricted to their assignedJobIds;
//                  users restricted to those on shared jobs
//   - everyone else: 403
//
// Notes:
//   - Snag walk is bounded by visible-jobs count, not snag count.
//   - All matching is case-insensitive.
//   - Results are sorted by score within type, then merged.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isStaffRole } = require('./_lib/auth');

const TYPES = new Set(['jobs', 'snags', 'users']);

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

  const requestedTypes = (req.query.types ? String(req.query.types) : 'jobs,snags,users')
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
  const visibleJobIds = (me.role === 'admin')
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
          url: '/admin/jobs/' + j.id,
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
    if (me.role === 'leadingHand') {
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
          url: u.role === 'client' ? null : '/admin/crew',
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

  // ── Snags ─────────────────────────────────────────────────────────────
  if (requestedTypes.includes('snags')) {
    // Per-job walks in parallel — bounded by visible-job count.
    const perJob = await Promise.all(visibleJobs.map(async j => {
      let data;
      try { data = await readBlob(`jobs/${j.id}/data.json`, { snags: [] }); }
      catch { return []; }
      const out = [];
      for (const s of (data.snags || [])) {
        const score = scoreMatch(s.desc, q);
        if (score > 0) {
          out.push({
            type: 'snag',
            id: s.id,
            jobId: j.id,
            label: s.desc || '(no description)',
            sub: j.name + ' · ' + (s.status || 'Open') +
                 (s.priority ? ' · ' + s.priority : ''),
            url: '/admin/jobs/' + j.id + '?openSnag=' + (s.id || ''),
            _score: score,
            _createdAt: s.createdAt || s.date || '',
          });
        }
      }
      return out;
    }));
    const flat = [].concat.apply([], perJob);
    flat.sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      // Newer first within same score
      return (b._createdAt || '').localeCompare(a._createdAt || '');
    });
    for (const m of flat.slice(0, limit)) {
      delete m._score; delete m._createdAt;
      results.push(m);
    }
  }

  return res.status(200).json({ q, results });
};
