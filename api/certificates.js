// api/certificates.js — #231 commissioning documents + certificates register.
//
//   GET  /api/certificates?jobId=X   → list current certificates
//                                       (admin/manager full; assigned crew read-only)
//   POST /api/certificates?jobId=X    → upload (admin/manager, dataUrl)
//                                       body { type, title, referenceNo?, issuedAt?,
//                                              dataUrl, mimeType?, fileName? }
//
// A typed register with the fields that matter — type, reference number, issue
// date, file. NOT an approval workflow (Epic 11 owns ITP/QA). Isolated store:
// jobs/<jobId>/certificates.json. Dark behind the global `certificates_register`
// flag (assigned crew see the read-only list once on; admin-only upload is
// enforced here, not by the flag).

const { put } = require('@vercel/blob');
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canManageJob, isAdminRole, isClientRole } = require('./_lib/auth');
const { isFlagEnabled } = require('./_lib/feature-flags');
const { getSetting } = require('./_lib/feature-settings');
const { append: appendAuditLog } = require('./_lib/audit-log');

const FLAG = 'certificates_register';
const CERT_TYPES = ['certificate', 'test_sheet', 'commissioning'];
// Upload cap is an owner-tunable setting (certificates_register.maxUploadMb, default 25).

function certsKey(jobId) { return 'jobs/' + jobId + '/certificates.json'; }
async function readCerts(jobId) { return await readBlob(certsKey(jobId), { certificates: [] }); }

function newId() {
  return 'cert_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function extFor(mime) {
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime && (mime.includes('word') || mime.includes('officedocument'))) return 'docx';
  return 'bin';
}
function isAllowedMime(mime) {
  if (!mime) return false;
  if (mime === 'application/pdf') return true;
  if (mime.startsWith('image/')) return true;
  if (mime.includes('word') || mime.includes('officedocument')) return true;
  return false;
}
/** Keep only a sane ISO date (YYYY-MM-DD); anything else → "" (undated). */
function normaliseDate(raw) {
  const s = String(raw || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;

  if (!(await isFlagEnabled(FLAG, user))) {
    return res.status(404).json({ error: 'not found' });
  }
  if (isClientRole(user.role)) return res.status(403).json({ error: 'forbidden' });

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const isCrew = Array.isArray(user.assignedJobIds) && user.assignedJobIds.includes(jobId);
  const canManage = isAdminRole(user.role) || canManageJob(user, jobId);

  // ---- GET list (admin/manager full; assigned crew read-only) ----
  if (req.method === 'GET') {
    if (!isCrew && !canManage) return res.status(403).json({ error: 'not assigned to this job' });
    const data = await readCerts(jobId);
    const certificates = (data.certificates || []).filter((c) => c.status === 'current');
    return res.status(200).json({ certificates });
  }

  // ---- POST upload (admin / manager only) ----
  if (req.method === 'POST') {
    if (!canManage) return res.status(403).json({ error: 'admin / manager only' });
    const body = req.body || {};
    const type = CERT_TYPES.includes(body.type) ? body.type : null;
    if (!type) {
      return res.status(400).json({ error: 'type must be one of certificate | test_sheet | commissioning' });
    }
    const title = body.title ? String(body.title).trim().slice(0, 200) : '';
    if (!title) return res.status(400).json({ error: 'title required' });
    if (!body.dataUrl || typeof body.dataUrl !== 'string') {
      return res.status(400).json({ error: 'dataUrl required' });
    }
    const mime =
      body.mimeType || ((body.dataUrl.match(/^data:([^;]+);/) || [])[1]) || 'application/octet-stream';
    if (!isAllowedMime(mime)) {
      return res.status(400).json({ error: 'unsupported file type (PDF, image or Word)' });
    }
    const base64 = String(body.dataUrl).split(',')[1];
    if (!base64) return res.status(400).json({ error: 'invalid dataUrl' });
    const buf = Buffer.from(base64, 'base64');
    const maxMb = await getSetting('certificates_register', 'maxUploadMb');
    if (buf.length > maxMb * 1024 * 1024)
      return res.status(400).json({ error: `file too large (max ${maxMb} MB)` });

    const id = newId();
    const blobPath = 'jobs/' + jobId + '/certificates/' + id + '.' + extFor(mime);
    const uploaded = await put(blobPath, buf, {
      access: 'public',
      contentType: mime,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    const referenceNo = body.referenceNo ? String(body.referenceNo).trim().slice(0, 80) : '';
    const issuedAt = normaliseDate(body.issuedAt);
    const now = new Date().toISOString();
    const cert = {
      id,
      jobId,
      type,
      title,
      referenceNo,
      issuedAt,
      fileName: body.fileName ? String(body.fileName).slice(0, 200) : title + '.' + extFor(mime),
      blobPath,
      url: uploaded.url,
      mimeType: mime,
      sizeBytes: buf.length,
      status: 'current',
      uploadedAt: now,
      uploadedBy: user.username || user.id,
    };
    const data = await readCerts(jobId);
    data.certificates = data.certificates || [];
    data.certificates.push(cert);
    await writeBlob(certsKey(jobId), data);
    await appendAuditLog({
      action: 'certificate.uploaded',
      actorId: user.id,
      actorName: user.username || 'Unknown',
      actorRole: user.role || null,
      jobId,
      targetType: 'certificate',
      targetId: id,
      summary: `uploaded ${type} "${title.slice(0, 80)}"${referenceNo ? ` (ref ${referenceNo})` : ''}`,
      metadata: { type, referenceNo, issuedAt },
    }).catch(() => {});
    return res.status(201).json({ certificate: cert });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
