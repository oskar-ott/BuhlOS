// BuhlOS — pricing/BOQ workbook import: PREVIEW + create-draft-job.  (#365)
//
//   POST /api/job-doc-import                  body: { fileName, mimeType, dataUrl }
//     → 200 { preview, readOnly: true }       (parse + review only; writes nothing)
//   POST /api/job-doc-import?action=create-job body: { ...workbook, name }
//     → 201 { jobId, job, costBasis }         (creates a real DRAFT job)
//
// The preview parses an uploaded .xlsx pricing/BOQ workbook into a structured,
// reviewable shape (packages, lines, supply/install split, commercial
// reconciliation, ambiguity flags) and RETURNS IT without persisting anything.
//
// create-job (the #365 write-half) turns a reviewed bill into a real draft job
// via the sanctioned createJob() path and attaches the parsed bill as the job's
// cost basis (jobs/<id>/cost-import.json). A BOQ is a PRICED BILL — it carries
// no site areas or tasks, so none are invented (P7); the job is born structure-
// less and the office adds areas from the drawings. This is NOT gated on the
// canonical task model (#479): it creates a job + a cost record, not tasks.
//
// Dark by default behind the `job_doc_import` flag (admin-tier) so the surface
// is invisible until proven on a preview deploy; the handler also 403s any
// non-admin. The pure parser lives in api/_lib/boq-import.js; the sole job
// writer is api/_lib/job-create.js (createJob).

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isAdminRole } = require('./_lib/auth');
const { isFlagEnabled } = require('./_lib/feature-flags');
const { parseBoqFromXlsx } = require('./_lib/boq-import');
const { createJob } = require('./_lib/job-create');
const { buildJobCreatedEntry } = require('./_lib/job-create-audit');
const { append: appendAuditLog } = require('./_lib/audit-log');

const MAX_BYTES = 15 * 1024 * 1024;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Decode the data: URL into a size/type-checked Buffer. Returns { buf } or
// { error, status }. Shared by the preview and create-job paths.
function decodeWorkbook(body) {
  if (!body.dataUrl || typeof body.dataUrl !== 'string') {
    return { error: 'dataUrl required', status: 400 };
  }
  const mime = body.mimeType ||
               ((body.dataUrl.match(/^data:([^;]+);/) || [])[1]) ||
               '';
  if (mime && mime !== XLSX_MIME && !mime.includes('spreadsheetml')) {
    return { error: 'only .xlsx pricing/BOQ workbooks are supported', status: 400 };
  }
  const base64 = String(body.dataUrl).split(',')[1];
  if (!base64) return { error: 'invalid dataUrl', status: 400 };
  const buf = Buffer.from(base64, 'base64');
  if (buf.length > MAX_BYTES) return { error: 'file too large (max 15 MB)', status: 400 };
  return { buf };
}

// #365 write-half: create a real DRAFT job from a reviewed BOQ and attach the
// parsed bill as the job's cost basis. createJob() is the sole sanctioned job
// writer (it writes jobs.json + the per-job seeds and enforces every invariant —
// id collision, basics, the area-id uniqueness rule); we add only the cost-basis
// attachment + the job.created audit. NO areas/tasks are invented — a BOQ is a
// priced bill and carries neither (P7). Areas come later from drawings; turning
// the cost basis into a formal quote is a separate follow-up.
async function createJobFromBoq(req, res, user, preview) {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });

  const data = await readBlob('jobs.json', { jobs: [] });
  const result = await createJob(data, { name, status: 'draft' });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  const job = result.job;

  // Attach the parsed bill as the job's cost basis: who/when/which workbook, the
  // reconciliation totals (incl. any non-reconciling delta — the discrepancy is
  // preserved, not hidden), and every priced line. An honest record of what was
  // imported. Per-job store, covered by the jobs/ backup prefix.
  await writeBlob(`jobs/${job.id}/cost-import.json`, {
    source: 'boq-import',
    importedAt: new Date().toISOString(),
    importedById: user.id,
    importedByName: user.username || user.id,
    fileName: body.fileName ? String(body.fileName).slice(0, 200) : null,
    preview,
  });

  // Audit through the canonical job.created builder (best-effort, after the
  // write — a journal failure never unwinds the job). source 'boq-import'
  // distinguishes this origin from the Builder + won-quote conversion.
  await appendAuditLog(
    buildJobCreatedEntry({ actor: user, job, source: 'boq-import' }),
  ).catch(() => {});

  return res.status(201).json({
    jobId: job.id,
    job: { id: job.id, name: job.name, status: job.status },
    costBasis: {
      lines: preview.counts.lines,
      total: preview.totals.computed,
      reconciles: preview.totals.reconciles,
    },
  });
}

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

  const action = (req.query && req.query.action) || '';

  // Decode + size/type-guard the workbook (shared by preview + create-job).
  const decoded = decodeWorkbook(req.body || {});
  if (decoded.error) return res.status(decoded.status).json({ error: decoded.error });

  // Parse once. A workbook that won't parse never becomes a preview OR a job.
  let preview;
  try {
    preview = parseBoqFromXlsx(decoded.buf);
  } catch (err) {
    const msg = err && err.message ? err.message : 'parse error';
    return res.status(422).json({ error: 'could not read workbook: ' + msg });
  }

  // WRITE: turn the reviewed bill into a real draft job (#365 write-half).
  if (action === 'create-job') {
    return await createJobFromBoq(req, res, user, preview);
  }

  // READ-ONLY preview (default): nothing is persisted; for human review only.
  return res.status(200).json({ preview, readOnly: true });
};
