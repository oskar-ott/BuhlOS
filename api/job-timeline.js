// Job activity timeline — chronological event feed per job.
//
//   GET /api/job-timeline?jobId=<id>
//       &since=YYYY-MM-DD         (default: 30 days ago)
//       &limit=50                  (default 50, max 200)
//
// A unified read-only stream of what's happened on the job, pulled
// from three sources:
//
//   1. Snag events  — opened (createdAt), closed (closedAt), reassigned
//                     (updatedAt when updatedBy changed via assignment).
//                     Sourced from jobs/<id>/data.json.
//   2. Hours days   — one event per (date × user) with allocated hours
//                     on this job > 0. Sourced from per-user
//                     time-entries blobs.
//   3. Dwelling     — photo events from jobs/<id>/photos-index.json
//      photos        (per dwelling, per stage).
//
// Distinct from `/api/data` (which is the *current state*) and from
// the Phase 09 audit log (#53, which is the *who did what* security
// trail). Timeline is the *what happened* narrative feed — for the
// "show me the story of this job" UI.
//
// Permissions:
//   - admin / leadingHand on this job
//   - client owning this job: receives a sanitised stream (no
//     hours events, no assignee names, only client-visible snags)
//   - everyone else: 403
//
// Response:
//   {
//     jobId, jobName,
//     count, hasMore,
//     events: [{ ts, type, summary, actor?, snagId?, dwellingId?,
//                userId?, hours?, ... }]
//   }
//
// Event types:
//   snag-opened, snag-closed, hours-logged, photo-snag, photo-dwelling

const { list } = require('@vercel/blob');
const { readBlob, setNoCache } = require('./_lib/blob');
const { getCurrentUser, canManageJob } = require('./_lib/auth');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SINCE_DAYS = 30;

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'not authenticated' });

  const q = req.query || {};
  const jobId = q.jobId || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const job = (jobsBlob.jobs || []).find(j => j.id === jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });

  const isClient = me.role === 'client' && job.clientUserId === me.id;
  const isManager = canManageJob(me, jobId);
  if (!isClient && !isManager) {
    return res.status(403).json({ error: 'forbidden' });
  }

  // Parse since / limit.
  let sinceISO;
  if (q.since) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q.since)) {
      return res.status(400).json({ error: 'since must be YYYY-MM-DD' });
    }
    sinceISO = q.since + 'T00:00:00Z';
  } else {
    sinceISO = new Date(Date.now() - DEFAULT_SINCE_DAYS * DAY_MS).toISOString();
  }
  let limit = parseInt(q.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 50;
  if (limit > 200) limit = 200;

  // Resolve user lookup once (for actor names).
  const usersBlob = await readBlob('users.json', { users: [] });
  const userById = {};
  for (const u of (usersBlob.users || [])) userById[u.id] = u;

  // Area name lookup.
  const areaName = {};
  for (const g of (job.areaGroups || [])) {
    for (const a of (g.areas || [])) areaName[a.id] = a.name;
  }

  const events = [];

  // ── 1. Snag events ───────────────────────────────────────────────────
  const data = await readBlob(`jobs/${jobId}/data.json`, { snags: [] });
  for (const s of (data.snags || [])) {
    const clientVisible = s.clientVisible === true
      || (s.clientVisible === undefined && (s.photos || []).length > 0);
    // For clients, only emit events on snags they can see.
    if (isClient && !clientVisible) continue;

    const created = s.createdAt || s.date;
    if (created && created >= sinceISO) {
      events.push({
        ts: created,
        type: 'snag-opened',
        summary: isClient
          ? 'Snag raised'
          : 'Snag raised — ' + (s.desc || '(no description)').slice(0, 80),
        snagId: s.id,
        priority: s.priority || 'Medium',
        actor: isClient ? null : (s.by || null),
        dwellingId: s.dwelling || null,
        dwellingName: areaName[s.dwelling] || s.dwelling || null,
      });
    }
    if (s.closedAt && s.closedAt >= sinceISO) {
      events.push({
        ts: s.closedAt,
        type: 'snag-closed',
        summary: isClient
          ? 'Snag resolved'
          : 'Snag closed — ' + (s.desc || '(no description)').slice(0, 80),
        snagId: s.id,
        actor: isClient ? null : (s.updatedBy || null),
        dwellingId: s.dwelling || null,
        dwellingName: areaName[s.dwelling] || s.dwelling || null,
      });
    }
    // Snag photos (per photo)
    for (const p of (s.photos || [])) {
      if (!p || !p.addedAt || p.addedAt < sinceISO) continue;
      // Client sees photos only on client-visible snags.
      events.push({
        ts: p.addedAt,
        type: 'photo-snag',
        summary: isClient ? 'Photo added' : 'Photo added to snag',
        snagId: s.id,
        actor: isClient ? null : (p.addedBy || null),
        dwellingId: s.dwelling || null,
        dwellingName: areaName[s.dwelling] || s.dwelling || null,
        url: p.url,
      });
    }
  }

  // ── 2. Hours days (skip for clients) ─────────────────────────────────
  if (!isClient) {
    const sinceDate = sinceISO.slice(0, 10);
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    let blobs = [];
    try {
      const r = await list({ prefix: 'users/', token, limit: 5000 });
      blobs = (r.blobs || []).filter(b => {
        const m = b.pathname.match(/\/time-entries\/(\d{4}-\d{2}-\d{2})\.json$/);
        return m && m[1] >= sinceDate;
      });
    } catch { /* swallow */ }
    const entries = (await Promise.all(blobs.map(async b => {
      try {
        const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
        if (!r.ok) return null;
        return await r.json();
      } catch { return null; }
    }))).filter(Boolean);
    for (const e of entries) {
      const hoursOnJob = (e.allocations || [])
        .filter(a => a.jobId === jobId)
        .reduce((s, a) => s + (Number(a.hours) || 0), 0);
      if (hoursOnJob <= 0) continue;
      // Use end-of-day stamp so the event sorts after morning events.
      const ts = (e.date || '') + 'T17:00:00Z';
      const uname = e.userName
        || (userById[e.userId] && userById[e.userId].username)
        || e.userId;
      events.push({
        ts,
        type: 'hours-logged',
        summary: uname + ' logged ' + (Math.round(hoursOnJob * 10) / 10) + 'h',
        actor: uname,
        userId: e.userId,
        hours: Math.round(hoursOnJob * 100) / 100,
        status: e.status || 'draft',
      });
    }
  }

  // ── 3. Dwelling photos ──────────────────────────────────────────────
  const photosIdx = await readBlob(`jobs/${jobId}/photos-index.json`, {});
  for (const [dwId, stages] of Object.entries(photosIdx || {})) {
    if (!stages || typeof stages !== 'object') continue;
    for (const [stage, plist] of Object.entries(stages)) {
      if (!Array.isArray(plist)) continue;
      for (const p of plist) {
        if (!p || !p.addedAt || p.addedAt < sinceISO) continue;
        events.push({
          ts: p.addedAt,
          type: 'photo-dwelling',
          summary: isClient ? 'Photo uploaded' : 'Photo uploaded to ' + (areaName[dwId] || dwId),
          actor: isClient ? null : (p.addedBy || null),
          dwellingId: dwId,
          dwellingName: areaName[dwId] || dwId,
          stage,
          url: p.url,
        });
      }
    }
  }

  // Sort desc, slice, hasMore signal.
  events.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  const hasMore = events.length > limit;

  return res.status(200).json({
    jobId, jobName: job.name,
    count: Math.min(events.length, limit),
    hasMore,
    events: events.slice(0, limit),
  });
};
