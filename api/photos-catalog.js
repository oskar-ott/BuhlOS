// Photo catalog per job — handover support.
//
//   GET /api/photos-catalog?jobId=<id>
//       &source=snags|dwellings|all   (default: all)
//       &format=json|csv              (default: json)
//
// Flat list of every photo associated with the job: snag photos
// (jobs/<id>/snag-photos/...) and dwelling/ITP photos (indexed in
// jobs/<id>/photos-index.json). Each entry carries enough context — what
// it's a photo *of* — that the handover binder can be assembled without
// a database lookup per row.
//
// Why this exists:
//   At handover the builder wants every photo with provenance: "this
//   one was taken by Sam on May 12, for the meter-box snag on lot 4".
//   The /admin/snags UI shows photos per snag but doesn't expose a flat
//   catalog. The CSV is what gets dropped into a Word document with
//   `Insert > Quick Parts > Field`, or imported into a handover binder.
//
// JSON response:
//   {
//     jobId, jobName,
//     counts: { total, snag, dwelling },
//     photos: [
//       { source: 'snag'|'dwelling',
//         id, url, addedBy, addedAt,
//         snagId?, snagDesc?, snagPriority?, snagStatus?,
//         dwellingId?, dwellingName?, stage? }
//     ]
//   }
//
// CSV columns: Source, ID, Subject, Priority/Stage, Status, Added By,
// Added At, URL.
//
// Permissions: admin / leadingHand on the job (via canManageJob).

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canManageJob } = require('./_lib/auth');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res);
  if (!me) return;
  if (!['admin', 'leadingHand'].includes(me.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const q = req.query || {};
  const jobId  = q.jobId || '';
  const source = (q.source || 'all').toLowerCase();    // 'snags' | 'dwellings' | 'all'
  const format = (q.format || 'json').toLowerCase();   // 'json' | 'csv'
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  // Job lookup + access.
  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const job = (jobsBlob.jobs || []).find(j => j.id === jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  if (!canManageJob(me, jobId)) return res.status(403).json({ error: 'no access to job' });

  // Build area-name lookup for dwelling photos.
  const areaName = {};
  for (const g of (job.areaGroups || [])) {
    for (const a of (g.areas || [])) areaName[a.id] = a.name;
  }

  const photos = [];
  let snagCount = 0, dwellingCount = 0;

  // ── Snag photos ───────────────────────────────────────────────────────
  if (source === 'snags' || source === 'all') {
    const data = await readBlob(`jobs/${jobId}/data.json`, { snags: [] });
    for (const s of (data.snags || [])) {
      const list = Array.isArray(s.photos) ? s.photos : [];
      for (const p of list) {
        if (!p || !p.url) continue;
        photos.push({
          source: 'snag',
          id: p.id || '',
          url: p.url,
          addedBy: p.addedBy || s.by || '',
          addedAt: p.addedAt || s.createdAt || '',
          snagId: s.id || '',
          snagDesc: s.desc || '',
          snagPriority: s.priority || 'Medium',
          snagStatus: s.status || 'Open',
          dwellingId: s.dwelling || '',
          dwellingName: areaName[s.dwelling] || s.dwelling || '',
        });
        snagCount++;
      }
    }
  }

  // ── Dwelling / ITP photos ─────────────────────────────────────────────
  if (source === 'dwellings' || source === 'all') {
    const idx = await readBlob(`jobs/${jobId}/photos-index.json`, {});
    // photos-index shape: { [dwellingId]: { [stage]: [ { id, url, addedBy, addedAt }, ... ] } }
    for (const [dwId, stages] of Object.entries(idx || {})) {
      if (!stages || typeof stages !== 'object') continue;
      for (const [stage, list] of Object.entries(stages)) {
        if (!Array.isArray(list)) continue;
        for (const p of list) {
          if (!p || !p.url) continue;
          photos.push({
            source: 'dwelling',
            id: p.id || '',
            url: p.url,
            addedBy: p.addedBy || '',
            addedAt: p.addedAt || '',
            dwellingId: dwId,
            dwellingName: areaName[dwId] || dwId,
            stage,
          });
          dwellingCount++;
        }
      }
    }
  }

  // Sort newest first by addedAt — handover binders read in reverse chrono.
  photos.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));

  if (format === 'csv') {
    const cols = ['Source', 'ID', 'Subject', 'Priority / Stage', 'Status', 'Dwelling', 'Added By', 'Added At', 'URL'];
    const lines = [cols.map(csvCell).join(',')];
    for (const p of photos) {
      const subject = p.source === 'snag' ? p.snagDesc : ('Dwelling photo · ' + (p.stage || ''));
      const priOrStage = p.source === 'snag' ? p.snagPriority : p.stage;
      const status = p.source === 'snag' ? p.snagStatus : '';
      lines.push([
        p.source, p.id, subject, priOrStage, status,
        p.dwellingName, p.addedBy, p.addedAt, p.url,
      ].map(csvCell).join(','));
    }
    const csv = lines.join('\n') + '\n';
    const safeJobName = String(job.name || jobId).replace(/[^a-z0-9\-_]+/gi, '_').slice(0, 60);
    const today = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="buhl-photos_' + safeJobName + '_' + today + '.csv"');
    res.setHeader('X-Row-Count', String(photos.length));
    return res.status(200).send(csv);
  }

  return res.status(200).json({
    jobId, jobName: job.name,
    counts: { total: photos.length, snag: snagCount, dwelling: dwellingCount },
    photos,
  });
};

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
