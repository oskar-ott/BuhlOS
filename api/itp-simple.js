// Simple mobile ITP builder (#912, lean-reset step 6) — the field's minimum
// honest QA artifact: start an ITP on the phone, name areas on the walk, drop
// photos into each, generate a plain PDF. No templates, no sign-off workflow —
// the heavy office ITP system (`itp` flag) is a separate, hidden feature.
//
// Storage split (product-owner directive 2026-07-18):
//   metadata → Supabase (api/_lib/itp-simple-store; the tables ARE the store)
//   binaries → Vercel Blob under jobs/<jobId>/itp-simple/ (photos + PDFs)
//
// Actions (all ?jobId=X scoped; field-authed like api/tags.js):
//   GET                                   → { job, reports: [...] }
//   GET    ?id=R                          → { report } (areas + photos)
//   POST         body {title}             → create report
//   PUT          body {id, title}         → rename report
//   DELETE       body {id}                → soft-delete report
//   POST   ?action=area   {reportId,name} → add area
//   PUT    ?action=area   {id, name}      → rename area
//   DELETE ?action=area   {id}            → delete area (+ its photo rows)
//   POST   ?action=photo  {areaId, dataUrl, caption?} → upload + attach
//   DELETE ?action=photo  {id}            → delete photo row
//   POST   ?action=pdf    {reportId}      → compose + store PDF → { url }
//
// Flag-dark behind `itp_simple` (viewer-aware gate → owner preview works;
// everyone else sees 404 — #760 no-trace layer for APIs).

const { put } = require('@vercel/blob');
const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');
const { isFlagEnabled } = require('./_lib/feature-flags');
const { getDb } = require('./_lib/supabase-db');
const store = require('./_lib/itp-simple-store');
const { composeItpPdf } = require('./_lib/itp-simple-pdf');

const MAX_PHOTO_BYTES = 8 * 1024 * 1024; // matches the tag-photo cap
const MAX_PDF_PHOTOS = 120; // serverless memory/time guard (maxDuration 60)

function cleanName(v, max) {
  const s = String(v == null ? '' : v).trim();
  return s.length >= 1 && s.length <= max ? s : null;
}

async function jobMeta(jobId) {
  const data = await readBlob('jobs.json', { jobs: [] });
  const job = (data.jobs || []).find((j) => j.id === jobId);
  return { id: jobId, name: (job && job.name) || jobId };
}

function sydneyDateLabel(d) {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney', day: 'numeric', month: 'short', year: 'numeric',
  }).format(d);
}

async function uploadPhoto(jobId, dataUrl) {
  const base64 = String(dataUrl).split(',')[1];
  if (!base64) return { error: 'invalid dataUrl' };
  const mime = (String(dataUrl).match(/data:([^;]+)/) || [, 'image/jpeg'])[1];
  const buf = Buffer.from(base64, 'base64');
  if (buf.length > MAX_PHOTO_BYTES) return { error: 'photo too large (max 8 MB)' };
  const photoId = Date.now() + '_' + Math.random().toString(36).slice(2);
  const blob = await put(`jobs/${jobId}/itp-simple/${photoId}.jpg`, buf, {
    access: 'public',
    contentType: mime,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  return { url: blob.url, pathname: blob.pathname };
}

async function generatePdf(sql, tenantId, jobId, reportId, user) {
  const report = await store.getReport(sql, tenantId, jobId, reportId);
  if (!report) return { status: 404, body: { error: 'report not found' } };

  const allPhotos = report.areas.flatMap((a) => a.photos);
  if (allPhotos.length > MAX_PDF_PHOTOS) {
    return {
      status: 400,
      body: { error: `too many photos for one PDF (${allPhotos.length} > ${MAX_PDF_PHOTOS}) — split the report` },
    };
  }

  // Fetch binaries from Blob; a failed fetch becomes bytes:null and renders
  // as an honest "couldn't be embedded" box instead of a silent drop (P7).
  const bytesByUrl = new Map();
  await Promise.all([...new Set(allPhotos.map((p) => p.url))].map(async (url) => {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(String(r.status));
      bytesByUrl.set(url, new Uint8Array(await r.arrayBuffer()));
    } catch {
      bytesByUrl.set(url, null);
    }
  }));

  const job = await jobMeta(jobId);
  const pdfBytes = await composeItpPdf({
    title: report.title,
    jobName: job.name,
    jobLegacyId: jobId,
    authorName: user.name || user.username || '',
    generatedAtLabel: sydneyDateLabel(new Date()),
    areas: report.areas.map((a) => ({
      name: a.name,
      photos: a.photos.map((p) => ({ bytes: bytesByUrl.get(p.url) || null, caption: p.caption })),
    })),
  });

  const blob = await put(
    `jobs/${jobId}/itp-simple/${reportId}/itp-${Date.now()}.pdf`,
    Buffer.from(pdfBytes),
    { access: 'public', contentType: 'application/pdf', token: process.env.BLOB_READ_WRITE_TOKEN },
  );
  const generatedAt = await store.stampPdf(sql, tenantId, jobId, reportId, blob.url);
  return { status: 200, body: { url: blob.url, generatedAt } };
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const user = await requireAuth(req, res, { jobId });
  if (!user) return;
  if (!(await isFlagEnabled('itp_simple', user))) return res.status(404).json({ error: 'not found' });

  const action = (req.query && req.query.action) || '';
  const isRead = req.method === 'GET';
  const writes = !isRead;
  if (writes && !canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });

  try {
    const sql = getDb({ mode: isRead ? 'read' : 'write' });
    const tenantId = await store.resolveTenantId(sql);
    if (!tenantId) return res.status(503).json({ error: 'itp store not provisioned' });
    const body = req.body || {};

    // ── Areas ─────────────────────────────────────────────────────────
    if (action === 'area') {
      if (req.method === 'POST') {
        const name = cleanName(body.name, 120);
        if (!body.reportId || !name) return res.status(400).json({ error: 'reportId and name required' });
        const area = await store.addArea(sql, tenantId, jobId, body.reportId, name);
        if (!area) return res.status(404).json({ error: 'report not found' });
        return res.status(200).json({ area });
      }
      if (req.method === 'PUT') {
        const name = cleanName(body.name, 120);
        if (!body.id || !name) return res.status(400).json({ error: 'id and name required' });
        const ok = await store.renameArea(sql, tenantId, jobId, body.id, name);
        return ok ? res.status(200).json({ ok: true }) : res.status(404).json({ error: 'area not found' });
      }
      if (req.method === 'DELETE') {
        if (!body.id) return res.status(400).json({ error: 'id required' });
        const ok = await store.deleteArea(sql, tenantId, jobId, body.id);
        return ok ? res.status(200).json({ ok: true }) : res.status(404).json({ error: 'area not found' });
      }
      return res.status(405).end();
    }

    // ── Photos ────────────────────────────────────────────────────────
    if (action === 'photo') {
      if (req.method === 'POST') {
        if (!body.areaId || !body.dataUrl) return res.status(400).json({ error: 'areaId and dataUrl required' });
        const caption = body.caption ? String(body.caption).trim().slice(0, 200) : '';
        const uploaded = await uploadPhoto(jobId, body.dataUrl);
        if (uploaded.error) return res.status(400).json({ error: uploaded.error });
        const photo = await store.addPhoto(sql, tenantId, jobId, body.areaId, {
          url: uploaded.url, pathname: uploaded.pathname, caption, user,
        });
        // A bad areaId after a successful upload leaves an orphaned Blob byte —
        // that joins the existing evidence orphan-GC story, it is not tracked here.
        if (!photo) return res.status(404).json({ error: 'area not found' });
        return res.status(200).json({ photo });
      }
      if (req.method === 'DELETE') {
        if (!body.id) return res.status(400).json({ error: 'id required' });
        const ok = await store.deletePhoto(sql, tenantId, jobId, body.id);
        return ok ? res.status(200).json({ ok: true }) : res.status(404).json({ error: 'photo not found' });
      }
      return res.status(405).end();
    }

    // ── PDF ───────────────────────────────────────────────────────────
    if (action === 'pdf') {
      if (req.method !== 'POST') return res.status(405).end();
      if (!body.reportId) return res.status(400).json({ error: 'reportId required' });
      const out = await generatePdf(sql, tenantId, jobId, body.reportId, user);
      return res.status(out.status).json(out.body);
    }

    // ── Reports ───────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const id = (req.query && req.query.id) || '';
      if (id) {
        const report = await store.getReport(sql, tenantId, jobId, id);
        if (!report) return res.status(404).json({ error: 'report not found' });
        return res.status(200).json({ report });
      }
      const [job, reports] = await Promise.all([
        jobMeta(jobId),
        store.listReports(sql, tenantId, jobId),
      ]);
      return res.status(200).json({ job, reports });
    }

    if (req.method === 'POST') {
      const title = cleanName(body.title, 120);
      if (!title) return res.status(400).json({ error: 'title required (max 120 chars)' });
      const report = await store.createReport(sql, tenantId, { jobLegacyId: jobId, title, user });
      return res.status(200).json({ report });
    }

    if (req.method === 'PUT') {
      const title = cleanName(body.title, 120);
      if (!body.id || !title) return res.status(400).json({ error: 'id and title required' });
      const ok = await store.renameReport(sql, tenantId, jobId, body.id, title);
      return ok ? res.status(200).json({ ok: true }) : res.status(404).json({ error: 'report not found' });
    }

    if (req.method === 'DELETE') {
      if (!body.id) return res.status(400).json({ error: 'id required' });
      const ok = await store.deleteReport(sql, tenantId, jobId, body.id);
      return ok ? res.status(200).json({ ok: true }) : res.status(404).json({ error: 'report not found' });
    }

    return res.status(405).end();
  } catch (e) {
    console.error('itp-simple:', e);
    return res.status(500).json({ error: e.message || 'itp-simple failed' });
  }
};
