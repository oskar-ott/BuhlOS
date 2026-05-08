// Plan-Assisted Job Setup — Phase 1.
//
// Job-scoped plan register. Binary plan files live in Vercel Blob; metadata
// lives in jobs/<jobId>/plans-index.json.
//
//   GET    /api/plans?jobId=<id>                 → list plans for a job
//   POST   /api/plans?jobId=<id>                 → upload a plan (dataUrl pattern)
//                                                  body: { fileName, mimeType, dataUrl, drawingNumber, revision, title, level, category, notes }
//   PATCH  /api/plans?jobId=<id>&id=<planId>     → edit metadata only (no re-upload)
//                                                  body: any of { drawingNumber, revision, title, level, category, status, notes }
//   DELETE /api/plans?jobId=<id>&id=<planId>     → soft-archive (sets status=archived)
//
// Permissions:
//   admin/leadingHand: full access for jobs they manage (canManageJob)
//   tradie:            list-only for jobs they're on
//   client:            403 (admin setup is internal)
//
// Storage:
//   jobs/<jobId>/plans-index.json — { plans: [...] }
//   jobs/<jobId>/plans/<planId>.<ext> — binary file via @vercel/blob put()

const { put } = require('@vercel/blob');
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canManageJob } = require('./_lib/auth');

const VALID_STATUSES = ['current', 'superseded', 'archived'];
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB cap on uploads

function newId() {
  return 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function extFor(mime) {
  if (!mime) return 'bin';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/jpg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/heic') return 'heic';
  return 'bin';
}

function isAllowedMime(mime) {
  return mime === 'application/pdf' ||
         (typeof mime === 'string' && mime.startsWith('image/'));
}

async function readIndex(jobId) {
  return await readBlob('jobs/' + jobId + '/plans-index.json', { plans: [] });
}
async function writeIndex(jobId, data) {
  await writeBlob('jobs/' + jobId + '/plans-index.json', data);
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;
  if (user.role === 'client') return res.status(403).json({ error: 'forbidden' });

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  if (req.method === 'GET') {
    // Tradies on the job can read; admin/LH can read.
    const isCrew = (user.assignedJobIds || []).includes(jobId);
    if (user.role !== 'admin' && !canManageJob(user, jobId) && !isCrew) {
      return res.status(403).json({ error: 'no access to this job' });
    }
    const data = await readIndex(jobId);
    // Hide archived from non-admin by default (?includeArchived=1 to show all).
    const includeArchived = req.query && req.query.includeArchived === '1';
    let plans = data.plans || [];
    if (!includeArchived && user.role !== 'admin') {
      plans = plans.filter(p => p.status !== 'archived');
    }
    return res.status(200).json({ plans });
  }

  // Mutating actions require management of the job.
  if (!canManageJob(user, jobId) && user.role !== 'admin') {
    return res.status(403).json({ error: 'cannot manage this job' });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    if (!body.dataUrl || typeof body.dataUrl !== 'string') {
      return res.status(400).json({ error: 'dataUrl required' });
    }
    const mime = body.mimeType ||
                 ((body.dataUrl.match(/^data:([^;]+);/) || [])[1]) ||
                 'application/octet-stream';
    if (!isAllowedMime(mime)) {
      return res.status(400).json({ error: 'unsupported file type (PDF or image only)' });
    }
    const base64 = String(body.dataUrl).split(',')[1];
    if (!base64) return res.status(400).json({ error: 'invalid dataUrl' });
    const buf = Buffer.from(base64, 'base64');
    if (buf.length > MAX_BYTES) {
      return res.status(400).json({ error: 'file too large (max 25 MB)' });
    }

    const id = newId();
    const ext = extFor(mime);
    const blobPath = 'jobs/' + jobId + '/plans/' + id + '.' + ext;
    const uploaded = await put(blobPath, buf, {
      access: 'public',
      contentType: mime,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    const now = new Date().toISOString();
    const plan = {
      id,
      jobId,
      fileName:      body.fileName ? String(body.fileName).slice(0, 200) : (id + '.' + ext),
      blobPath,
      url:           uploaded.url,
      mimeType:      mime,
      sizeBytes:     buf.length,
      drawingNumber: body.drawingNumber ? String(body.drawingNumber).trim() : '',
      revision:      body.revision ? String(body.revision).trim() : '',
      title:         body.title ? String(body.title).trim() : '',
      level:         body.level ? String(body.level).trim() : '',
      category:      body.category ? String(body.category).trim() : '',
      status:        'current',
      notes:         body.notes ? String(body.notes).trim() : '',
      uploadedAt:    now,
      uploadedBy:    user.username,
      uploadedByUserId: user.id,
    };

    const data = await readIndex(jobId);
    data.plans = data.plans || [];

    // If this drawing number already has a "current" entry, leave it alone
    // and let the admin manually mark the new one current — but flag the
    // collision via a non-blocking note in the response so the UI can warn.
    let revisionWarning = null;
    if (plan.drawingNumber) {
      const dupe = data.plans.find(p =>
        p.drawingNumber && p.drawingNumber === plan.drawingNumber && p.status === 'current'
      );
      if (dupe) revisionWarning = 'Existing current drawing with this number — mark new one current?';
    }

    data.plans.push(plan);
    await writeIndex(jobId, data);
    return res.status(201).json({ plan, revisionWarning });
  }

  if (req.method === 'PATCH') {
    const id = req.query && req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    const body = req.body || {};
    const data = await readIndex(jobId);
    const idx = (data.plans || []).findIndex(p => p.id === id);
    if (idx < 0) return res.status(404).json({ error: 'not found' });

    const editable = ['drawingNumber', 'revision', 'title', 'level', 'category', 'notes'];
    for (const k of editable) {
      if (body[k] !== undefined) data.plans[idx][k] = String(body[k] || '').trim();
    }
    // linkedAreaGroups: array of area-group IDs the plan is relevant to.
    // Used by the Areas section of Job Setup to show "Relevant drawings"
    // under each group.
    if (Array.isArray(body.linkedAreaGroups)) {
      data.plans[idx].linkedAreaGroups = body.linkedAreaGroups
        .filter(g => typeof g === 'string')
        .map(g => g.trim())
        .filter(Boolean);
    }
    if (body.status && VALID_STATUSES.includes(body.status)) {
      data.plans[idx].status = body.status;
      // If marking current, demote any other "current" with the same drawing number to superseded.
      if (body.status === 'current' && data.plans[idx].drawingNumber) {
        for (const p of data.plans) {
          if (p.id !== id && p.drawingNumber === data.plans[idx].drawingNumber && p.status === 'current') {
            p.status = 'superseded';
          }
        }
      }
    }
    data.plans[idx].updatedAt = new Date().toISOString();
    await writeIndex(jobId, data);
    return res.status(200).json({ plan: data.plans[idx] });
  }

  if (req.method === 'DELETE') {
    const id = req.query && req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    const data = await readIndex(jobId);
    const idx = (data.plans || []).findIndex(p => p.id === id);
    if (idx < 0) return res.status(404).json({ error: 'not found' });
    // Soft delete — keeps the file in blob and the metadata, just hides.
    data.plans[idx].status = 'archived';
    data.plans[idx].updatedAt = new Date().toISOString();
    await writeIndex(jobId, data);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
