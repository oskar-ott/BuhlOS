// Snag duplicate candidates — pre-raise check.
//
//   GET /api/snag-duplicates?jobId=<id>&desc=<text>&dwelling=<id>
//
// Given a draft snag description, returns the most-similar OPEN snags
// already on the job — to surface in the snag-raise UI as "is this the
// same as [X]?". Reduces the duplicate-snag noise that ends up dumping
// 3 versions of the same issue into the LH's queue.
//
// Scoring: token overlap (case-insensitive, stop-words dropped). For
// each candidate snag's description vs the input:
//   score = |intersect(tokens)| / max(|tokens_input|, |tokens_candidate|)
//
// Tokens are deduped within each desc so "meter meter box" doesn't
// score itself.
//
// Optional ?dwelling=<id> filter — if both snags reference the same
// dwelling, that's a stronger signal; we bump the score by +0.15 so
// same-dwelling candidates rank above generic name-match.
//
// Returns up to 5 candidates with score >= 0.3, sorted desc.
//
// Response:
//   {
//     jobId, q: { desc, dwelling? },
//     candidates: [{
//       id, desc, priority, status, dwellingId, dwellingName,
//       createdAt, photoCount, score
//     }]
//   }
//
// Permissions: anyone with write access to the job (tradies file
// snags). The endpoint only reads OPEN snags, so the worst-case data
// exposure is the same as the existing snag list.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');

// Tiny stop-list. Conservative — keep most words because trade jargon
// matters ("the switch on the kitchen wall" vs "the switch").
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'in', 'on', 'at',
  'to', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'for', 'with', 'this', 'that', 'these', 'those', 'it', 'its',
]);

function tokenize(str) {
  if (!str) return new Set();
  const out = new Set();
  for (const tok of String(str).toLowerCase().split(/[^a-z0-9]+/)) {
    if (!tok) continue;
    if (tok.length < 3) continue;
    if (STOP_WORDS.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

function intersectSize(a, b) {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res);
  if (!me) return;

  const q = req.query || {};
  const jobId    = q.jobId || '';
  const desc     = (q.desc || '').trim();
  const dwelling = q.dwelling || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  if (!desc || desc.length < 4) {
    return res.status(200).json({ jobId, q: { desc, dwelling: dwelling || null }, candidates: [] });
  }
  if (!canWrite(me, jobId)) return res.status(403).json({ error: 'no write access to job' });

  // Read job for dwelling names, and data for open snags.
  const [jobsBlob, data] = await Promise.all([
    readBlob('jobs.json', { jobs: [] }),
    readBlob(`jobs/${jobId}/data.json`, { snags: [] }),
  ]);
  const job = (jobsBlob.jobs || []).find(j => j.id === jobId);
  const areaName = {};
  if (job) {
    for (const g of (job.areaGroups || [])) {
      for (const a of (g.areas || [])) areaName[a.id] = a.name;
    }
  }

  const inputTokens = tokenize(desc);
  if (inputTokens.size === 0) {
    return res.status(200).json({ jobId, q: { desc, dwelling: dwelling || null }, candidates: [] });
  }

  const scored = [];
  for (const s of (data.snags || [])) {
    if ((s.status || 'Open') !== 'Open') continue;
    if (!s.desc) continue;
    const candTokens = tokenize(s.desc);
    if (candTokens.size === 0) continue;
    const overlap = intersectSize(inputTokens, candTokens);
    if (overlap === 0) continue;
    let score = overlap / Math.max(inputTokens.size, candTokens.size);
    // Dwelling-match bump.
    if (dwelling && s.dwelling === dwelling) score += 0.15;
    if (score < 0.3) continue;
    scored.push({
      id: s.id,
      desc: s.desc,
      priority: s.priority || 'Medium',
      status: s.status || 'Open',
      dwellingId: s.dwelling || '',
      dwellingName: areaName[s.dwelling] || s.dwelling || '',
      createdAt: s.createdAt || s.date || '',
      photoCount: (s.photos || []).length,
      score: Math.round(score * 1000) / 1000,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return res.status(200).json({
    jobId,
    q: { desc, dwelling: dwelling || null },
    candidates: scored.slice(0, 5),
  });
};
