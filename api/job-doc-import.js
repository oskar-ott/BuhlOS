// BuhlOS — read-only pricing/BOQ workbook import PREVIEW.  (#365 first increment)
//
//   POST /api/job-doc-import   body: { fileName, mimeType, dataUrl }   (admin)
//     → 200 { preview, readOnly: true }
//
// Parses an uploaded .xlsx pricing/BOQ workbook into a structured, reviewable
// preview (packages, lines, supply/install split, commercial reconciliation,
// ambiguity flags) and RETURNS IT. This endpoint NEVER writes a job, quote,
// material or blob — it is a preview surface for human review only. Turning a
// reviewed preview into job data is a separate, later slice (gated on the
// canonical task model, #479). Do not add a write path here.
//
// Dark by default behind the `job_doc_import` flag (admin-tier) so the surface
// is invisible until proven on a preview deploy; the handler also 403s any
// non-admin. The pure parser lives in api/_lib/boq-import.js.

const { setNoCache } = require('./_lib/blob');
const { requireAuth, isAdminRole } = require('./_lib/auth');
const { isFlagEnabled } = require('./_lib/feature-flags');
const { parseBoqFromXlsx } = require('./_lib/boq-import');

const MAX_BYTES = 15 * 1024 * 1024;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;
  if (!isAdminRole(user.role)) return res.status(403).json({ error: 'admin only' });

  // DARK by default: 404 (not 403) when off, so the surface is invisible.
  if (!(await isFlagEnabled('job_doc_import', user))) {
    return res.status(404).json({ error: 'not found' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const body = req.body || {};
  if (!body.dataUrl || typeof body.dataUrl !== 'string') {
    return res.status(400).json({ error: 'dataUrl required' });
  }
  const mime = body.mimeType ||
               ((body.dataUrl.match(/^data:([^;]+);/) || [])[1]) ||
               '';
  if (mime && mime !== XLSX_MIME && !mime.includes('spreadsheetml')) {
    return res.status(400).json({ error: 'only .xlsx pricing/BOQ workbooks are supported' });
  }
  const base64 = String(body.dataUrl).split(',')[1];
  if (!base64) return res.status(400).json({ error: 'invalid dataUrl' });
  const buf = Buffer.from(base64, 'base64');
  if (buf.length > MAX_BYTES) {
    return res.status(400).json({ error: 'file too large (max 15 MB)' });
  }

  try {
    const preview = parseBoqFromXlsx(buf);
    // READ-ONLY: nothing is persisted. The preview is for human review only.
    return res.status(200).json({ preview, readOnly: true });
  } catch (err) {
    const msg = err && err.message ? err.message : 'parse error';
    return res.status(422).json({ error: 'could not read workbook: ' + msg });
  }
};
