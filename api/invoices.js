// Supplier-invoice capture — the office API (docs/invoice-capture.md).
//
// ADMIN-TIER ONLY on every method (money is office data; a leading hand never
// reads it). Dark behind the `invoice_capture` launch-gate: 404 while off on
// every path except the cron sweep, which no-ops (skipped:flag_off).
//
//   GET    /api/invoices                       list (status,supplier,jobId,from,to,q,page,limit)
//   GET    /api/invoices?id=X                  one invoice (documents, allocation, events, attempts)
//   GET    /api/invoices?action=setup          inbound configuration + processing state
//   GET    /api/invoices?action=jobs&q=        job picker (id, name, code, status)
//   GET    /api/invoices?action=job-summary&jobId=  a job's confirmed figure + its invoices
//   GET    /api/invoices?action=document&id=X[&documentId=D]   the original PDF (authed proxy)
//   POST   /api/invoices?action=upload         { filename, dataUrl }  → captures (PDF or photo) + processes
//   POST   /api/invoices?action=attach&id=X    { filename, dataUrl }  → adds the document to a record that had none, then processes
//   POST   /api/invoices?action=process-pending                        → processes up to 3 received rows
//   POST   /api/invoices?action=retry&id=X                             → re-runs extraction
//   PUT    /api/invoices?id=X                  { field corrections }   → re-checks totals + IV match
//   POST   /api/invoices?action=receipt          FIELD: { jobId, filename, dataUrl, paidPersonally?, note? } → a photographed receipt logged to a job, read, and handed to the office (receipt_capture + invoice_capture)
//   PUT    /api/invoices?action=line&id=X      { lineNo, category?, description? } → re-files a line item; the category is REMEMBERED for this supplier + product
//   GET    /api/invoices?action=job-materials&jobId=  a job's materials breakdown by category, line by line (confirmed invoices only)
//   POST   /api/invoices?action=select-job&id=X   { jobId }
//   POST   /api/invoices?action=confirm&id=X      { jobId? }           → ONE active allocation (idempotent)
//   POST   /api/invoices?action=reassign&id=X     { jobId }            → reverse + re-allocate (confirmed only)
//   POST   /api/invoices?action=mark-duplicate&id=X { duplicateOfId? }
//   POST   /api/invoices?action=exclude&id=X      { reason? }
//   POST   /api/invoices?action=archive&id=X
//   POST   /api/invoices?action=restore&id=X
//   POST   /api/invoices?action=hold&id=X         → never books automatically until a person acts
//   POST   /api/invoices?action=supplier-pref&id=X { alwaysReview }  → per-supplier "always review"
//   GET    /api/invoices?action=sweep           cron (CRON_SECRET) — re-ingest + process pending + book due clean invoices
//   GET    /api/invoices?action=digest          cron (CRON_SECRET) — Monday digest to the accounts recipient list
//
// MONEY IS INTEGER CENTS. The supplier invoice number and the IV job reference
// are separate fields end to end. Every mutation validates, checks the tier,
// checks tenant ownership through the store, is idempotent where it matters,
// writes a per-invoice event and a platform audit entry (never with amounts),
// and returns { error: <stable code> } on failure — never an exception message.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isAdminRole, isLeadingHandRole, isFieldRole } = require('./_lib/auth');
const { isFieldOpenable } = require('./_lib/job-lifecycle');
const { isFlagEnabled, isFlagOn } = require('./_lib/feature-flags');
const { requireCron } = require('./_lib/cron-auth');
const { getDb } = require('./_lib/supabase-db');
const auditLog = require('./_lib/audit-log');
const { withErrorCapture } = require('./_lib/error-wrap');
const store = require('./_lib/invoices/store');
const { processInvoice, decideMatch } = require('./_lib/invoices/pipeline');
const { extractPdfText } = require('./_lib/invoices/pdf-text');
const { storeInvoicePdf, fetchInvoicePdf, sha256Hex } = require('./_lib/invoices/document-store');
const { sanitiseFilename, sanitiseFilenameFor, sniffDocument, decodeDataUrl } = require('./_lib/invoices/safe-file');
const { normaliseIvReference, buildJobCodeIndex, matchJobByIv, nearMissJobs } = require('./_lib/invoices/iv-match');
const { normaliseSupplierName } = require('./_lib/invoices/supplier-identity');
const { CATEGORY_LABELS, isCategory, descriptionKey } = require('./_lib/invoices/categories');
const { measureOf, rollUpProducts, measureTotals } = require('./_lib/invoices/measure');
const { reconcileTotals, allocationAmountCents, isCents } = require('./_lib/invoices/money');
const { canTransition, DOCUMENT_TYPES, ALLOCATABLE_TYPES, STATUSES } = require('./_lib/invoices/state');
const { ingestReceivedEmail } = require('./_lib/invoices/ingest');
const resend = require('./_lib/invoices/resend-inbound');
const aiExtractModule = require('./_lib/invoices/ai-extract');
const visionModule = require('./_lib/invoices/vision-extract');
const { getSettings } = require('./_lib/feature-settings');
const { sendEmail } = require('./_lib/email');
const { readTimesheetRecipients } = require('./_lib/timesheet-email-settings');
const { AUTO_ACTOR, buildDigest } = require('./_lib/invoices/auto-confirm');
const { evaluateAlerts, alertKey, shouldSend, buildAlertEmail } = require('./_lib/invoices/alerts');
const { writeBlob } = require('./_lib/blob');

const ALERT_STATE_KEY = 'invoices/alert-state.json';

const MAX_UPLOAD_BYTES = 3 * 1024 * 1024; // the serverless JSON body cap (~4.5 MB) minus base64 overhead
const SWEEP_BUDGET_MS = 45_000;
const PROCESS_BATCH = 10;
const SWEEP_BATCH = 20;

function actorOf(me) {
  return { id: me.id, name: me.name || me.username || '', role: me.role || null };
}

async function readJobs() {
  const data = await readBlob('jobs.json', { jobs: [] });
  return Array.isArray(data.jobs) ? data.jobs : [];
}

function jobSummaryRow(j) {
  return { id: j.id, name: j.name || j.id, code: typeof j.code === 'string' ? j.code : null, status: j.status || 'active' };
}

function liveJob(jobs, id) {
  const j = jobs.find((x) => x && x.id === id);
  if (!j || j.deleted === true || j.deletedAt) return null;
  return j;
}

/** The auto-booking knobs, resolved once per request (owner-console settings). */
async function autoConfirmSettings() {
  try {
    const s = await getSettings('invoice_capture');
    return {
      enabled: s.autoConfirm === true,
      capCents: Math.round(Number(s.autoConfirmCapDollars) * 100),
      graceHours: Number(s.autoConfirmGraceHours),
      lookbackDays: Number(s.autoConfirmLookbackDays),
      allowInferred: s.autoConfirmInferred === true,
      allowReceipts: s.autoConfirmReceipts === true,
    };
  } catch {
    return { enabled: false, capCents: 0, graceHours: 12, lookbackDays: 90, allowInferred: false, allowReceipts: false };
  }
}

async function pipelineDeps() {
  return {
    store,
    fetchPdf: fetchInvoicePdf,
    extractText: extractPdfText,
    readJobs,
    aiExtract: aiExtractModule.enabled() ? aiExtractModule.aiExtract : null,
    visionExtract: await visionEnabled() ? visionModule.visionExtract : null,
    autoConfirm: await autoConfirmSettings(),
  };
}

/** Photos are read by Claude vision only when the key exists AND the owner has
 *  opted in — receipts from the field on, or the AI rung switched on. */
async function visionEnabled() {
  if (!visionModule.enabled()) return false;
  if (process.env.INVOICE_AI_EXTRACTION === '1') return true;
  try { return await isFlagOn('receipt_capture'); } catch { return false; }
}

async function journal(me, action, invoice, summary, metadata) {
  try {
    await auditLog.append({
      action,
      actorId: me.id,
      actorName: actorOf(me).name,
      actorRole: me.role || null,
      jobId: invoice.matchedJobId || null,
      targetType: 'supplier_invoice',
      targetId: invoice.id,
      summary: String(summary).slice(0, 240),
      // Privacy line (same as job-materials): never the amount.
      metadata: {
        supplier: invoice.supplierName || null,
        supplierInvoiceNumber: invoice.supplierInvoiceNumber || null,
        ivReference: invoice.ivReference || null,
        jobId: invoice.matchedJobId || null,
        ...(metadata || {}),
      },
    });
  } catch {
    // Best-effort — the PG write has already landed and its own event row exists.
  }
}

async function detailWithJob(sql, tenant, id, jobs) {
  const detail = await store.getInvoiceDetail(sql, tenant.id, id);
  if (!detail) return null;
  const all = jobs || (await readJobs());
  const inv = detail.invoice;
  const job = inv.matchedJobId ? all.find((j) => j && j.id === inv.matchedJobId) : null;
  const dupOf = inv.duplicateOfId ? await store.getInvoiceRow(sql, tenant.id, inv.duplicateOfId) : null;
  const supplierPref = inv.supplierKey ? await store.getSupplierPref(sql, tenant.id, inv.supplierKey) : { alwaysReview: false, setBy: null, setAt: null };
  const lines = Array.isArray(detail.lines) ? detail.lines.map((l) => ({ ...l, measure: measureOf(l.description, l.quantity, l.unit) })) : [];
  const evidenceCandidates = inv.matchStatus === 'none' && inv.matchReason && Array.isArray(inv.matchReason.suggestions)
    ? inv.matchReason.suggestions.map((c) => all.find((j) => j && j.id === c.id)).filter(Boolean).map(jobSummaryRow)
    : [];
  const suggestions = inv.matchStatus === 'not_found' && inv.ivReference
    ? nearMissJobs(inv.ivReference, buildJobCodeIndex(all)).slice(0, 3).map(jobSummaryRow)
    : evidenceCandidates;
  return {
    ...detail,
    lines,
    suggestions,
    supplierPref,
    job: job ? jobSummaryRow(job) : null,
    duplicateOf: dupOf ? { id: dupOf.id, supplierName: dupOf.supplierName, supplierInvoiceNumber: dupOf.supplierInvoiceNumber, status: dupOf.status, createdAt: dupOf.createdAt } : null,
    canConfirm: confirmBlockers(inv).length === 0,
    confirmBlockers: confirmBlockers(inv),
  };
}

/** Why an invoice cannot be confirmed yet (stable codes the UI explains). Pure. */
function confirmBlockers(inv) {
  const out = [];
  if (!canTransition(inv.status, 'confirm')) out.push('status');
  if (!inv.matchedJobId) out.push('no_job');
  if (!ALLOCATABLE_TYPES.has(inv.documentType)) out.push('not_allocatable');
  if (!isCents(inv.subtotalCents)) out.push('missing_subtotal');
  if (inv.totalsConsistent === false) out.push('totals_inconsistent');
  if (inv.matchStatus === 'ambiguous') out.push('iv_ambiguous');
  return out;
}

/** Review reasons after an office correction / job selection. Pure. */
function reviewReasonsAfterEdit(inv) {
  const reasons = [];
  if (!inv.matchedJobId) {
    if (inv.matchStatus === 'ambiguous') reasons.push('iv_ambiguous');
    else if (inv.matchStatus === 'not_found') reasons.push('iv_not_found');
    else if (inv.matchStatus === 'multi_reference') reasons.push('multi_reference');
    else reasons.push('no_iv_reference');
  }
  if (inv.documentType === 'unknown') reasons.push('unknown_document_type');
  else if (!ALLOCATABLE_TYPES.has(inv.documentType)) reasons.push('not_allocatable');
  if (!isCents(inv.subtotalCents)) reasons.push('missing_subtotal');
  if (inv.totalsConsistent === false) reasons.push('totals_inconsistent');
  return reasons;
}

function statusAfterEdit(inv, reasons) {
  return reasons.length === 0 && inv.matchedJobId ? 'matched' : 'needs_review';
}

function parseCents(v, name, errors) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) { errors.push(`${name}_invalid`); return undefined; }
  return n;
}

async function handler(req, res) {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const q = req.query || {};
  const action = String(q.action || '');

  // ── cron sweep (no user session; CRON_SECRET) ─────────────────────────────
  if (action === 'sweep' && req.method === 'GET') {
    if (!requireCron(req, res)) return;
    if (!(await isFlagOn('invoice_capture'))) return res.status(200).json({ skipped: 'flag_off' });
    return sweep(req, res);
  }
  if (action === 'digest' && req.method === 'GET') {
    if (!requireCron(req, res)) return;
    if (!(await isFlagOn('invoice_capture'))) return res.status(200).json({ skipped: 'flag_off' });
    return digest(req, res);
  }

  const me = await requireAuth(req, res);
  if (!me) return;
  // Receipts from the field: the one worker-facing action (receipt_capture is
  // a GLOBAL flag; the office side it feeds must be on too).
  if (action === 'receipt' && req.method === 'POST') return submitReceipt(req, me, res);
  if (!(await isFlagEnabled('invoice_capture', me))) return res.status(404).json({ error: 'not found' });
  if (!isAdminRole(me.role)) return res.status(403).json({ error: 'admin only' });

  let sql;
  let tenant;
  try {
    sql = getDb({ mode: req.method === 'GET' && action !== 'document' ? 'read' : 'write' });
    tenant = await store.resolveTenant(sql);
  } catch (e) {
    console.error('[invoices] store unavailable', { code: (e && e.code) || 'db' });
    return res.status(503).json({ error: 'store_unavailable' });
  }
  if (!tenant) return res.status(503).json({ error: 'store_unprovisioned' });

  const id = typeof q.id === 'string' ? q.id : '';
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  try {
    // ── reads ────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      if (action === 'setup') return res.status(200).json(await setupPayload(sql, tenant));
      if (action === 'jobs') {
        const jobs = await readJobs();
        const needle = String(q.q || '').trim().toLowerCase();
        const rows = jobs
          .filter((j) => j && !j.deleted && !j.deletedAt)
          .map(jobSummaryRow)
          .filter((j) => !needle || j.name.toLowerCase().includes(needle) || (j.code || '').toLowerCase().includes(needle) || j.id.toLowerCase().includes(needle))
          .slice(0, 50);
        return res.status(200).json({ jobs: rows });
      }
      if (action === 'job-materials') {
        const jobId = String(q.jobId || '');
        if (!jobId) return res.status(400).json({ error: 'jobId required' });
        const b = await store.jobMaterialsBreakdown(sql, tenant.id, jobId);
        // Each line gets its MEASURE (metres, pieces …) so a category can say
        // "450 m of cable" and each product "300 m across 3 rolls".
        const lines = b.lines.map((l) => ({ ...l, measure: measureOf(l.description, l.quantity, l.unit) }));
        const byCat = {};
        const bySupplier = {};
        let linesCents = 0;
        for (const l of lines) {
          const c = byCat[l.category] || (byCat[l.category] = { category: l.category, label: CATEGORY_LABELS[l.category] || l.category, cents: 0, lineCount: 0, lines: [] });
          c.cents += l.signedCents; c.lineCount += 1; c.lines.push(l); linesCents += l.signedCents;
          const s = l.supplierName || 'Unknown supplier';
          bySupplier[s] = (bySupplier[s] || 0) + l.signedCents;
        }
        const byCategory = Object.values(byCat).map((c) => {
          const m = measureTotals(c.lines);
          return {
            category: c.category, label: c.label, cents: c.cents, lineCount: c.lineCount,
            measure: m.totals, measuredLines: m.measuredLines, unmeasuredLines: m.unmeasuredLines,
            products: rollUpProducts(c.lines).map((p) => ({ key: p.key, description: p.description, supplierName: p.supplierName, cents: p.cents, lineCount: p.lineCount, invoiceCount: p.invoiceCount, quantities: p.quantities, measures: p.measures, lineIds: p.lines.map((l) => l.id) })),
          };
        }).sort((a, c) => c.cents - a.cents);
        return res.status(200).json({
          jobId,
          confirmedCents: b.confirmedCents,
          invoiceCount: b.invoiceCount,
          linesCents,
          byCategory,
          bySupplier: Object.entries(bySupplier).map(([supplierName, cents]) => ({ supplierName, cents })).sort((a, c) => c.cents - a.cents),
          lines,
          invoicesWithoutLines: b.invoicesWithoutLines,
        });
      }
      if (action === 'job-summary') {
        const jobId = String(q.jobId || '');
        if (!jobId) return res.status(400).json({ error: 'jobId required' });
        const [summary, list] = await Promise.all([
          store.jobSummary(sql, tenant.id, jobId),
          store.listInvoices(sql, tenant.id, { jobId, status: ['matched', 'needs_review', 'confirmed'], limit: 100 }),
        ]);
        return res.status(200).json({ ...summary, invoices: list.rows });
      }
      if (action === 'document') {
        if (!id) return res.status(400).json({ error: 'id required' });
        return serveDocument(sql, tenant, id, typeof q.documentId === 'string' ? q.documentId : null, res);
      }
      if (id) {
        const detail = await detailWithJob(sql, tenant, id);
        if (!detail) return res.status(404).json({ error: 'not found' });
        return res.status(200).json(detail);
      }
      const statuses = typeof q.status === 'string' && q.status ? q.status.split(',').filter((s) => STATUSES.includes(s)) : [];
      const list = await store.listInvoices(sql, tenant.id, {
        status: statuses,
        supplier: typeof q.supplier === 'string' ? q.supplier.slice(0, 120) : '',
        jobId: typeof q.jobId === 'string' ? q.jobId.slice(0, 120) : '',
        from: /^\d{4}-\d{2}-\d{2}$/.test(String(q.from || '')) ? String(q.from) : '',
        to: /^\d{4}-\d{2}-\d{2}$/.test(String(q.to || '')) ? String(q.to) : '',
        q: typeof q.q === 'string' ? q.q.slice(0, 120) : '',
        autoConfirm: q.autoConfirm === 'pending' ? 'pending' : '',
        page: q.page,
        limit: q.limit,
      });
      const [counts, suppliers, jobs, soon] = await Promise.all([store.countsByStatus(sql, tenant.id), store.listSuppliers(sql, tenant.id), readJobs(), store.listInvoices(sql, tenant.id, { autoConfirm: 'pending', status: ['matched'], limit: 1 })]);
      const jobsById = {};
      for (const row of list.rows) {
        if (row.matchedJobId && !jobsById[row.matchedJobId]) {
          const j = jobs.find((x) => x && x.id === row.matchedJobId);
          if (j) jobsById[row.matchedJobId] = jobSummaryRow(j);
        }
      }
      return res.status(200).json({ invoices: list.rows, total: list.total, page: list.page, limit: list.limit, counts, autoConfirmPendingCount: soon.total, suppliers, jobsById, asOf: new Date().toISOString() });
    }

    // ── writes ───────────────────────────────────────────────────────────────
    if (req.method === 'POST' && action === 'upload') return upload(sql, tenant, me, body, res);
    if (req.method === 'POST' && action === 'process-pending') {
      const processed = await processPending(sql, tenant, 'inbox', PROCESS_BATCH, SWEEP_BUDGET_MS);
      return res.status(200).json({ processed });
    }

    if (req.method === 'PUT' && action === 'line' && id) return correctLine(sql, tenant, me, id, body, res);
    if (req.method === 'PUT' && id) return correct(sql, tenant, me, id, body, res);
    if (!id) return res.status(400).json({ error: 'id required' });
    const current = await store.getInvoiceRow(sql, tenant.id, id);
    if (!current) return res.status(404).json({ error: 'not found' });

    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
    switch (action) {
      case 'retry': return retry(sql, tenant, me, current, res);
      case 'hold': return hold(sql, tenant, me, current, res);
      case 'attach': return attach(sql, tenant, me, current, body, res);
      case 'supplier-pref': return supplierPref(sql, tenant, me, current, body, res);
      case 'select-job': return selectJob(sql, tenant, me, current, body, res);
      case 'confirm': return confirm(sql, tenant, me, current, body, res);
      case 'reassign': return reassign(sql, tenant, me, current, body, res);
      case 'mark-duplicate': return markDuplicate(sql, tenant, me, current, body, res);
      case 'exclude': return exclude(sql, tenant, me, current, body, res);
      case 'archive': return archive(sql, tenant, me, current, res);
      case 'restore': return restore(sql, tenant, me, current, res);
      default: return res.status(400).json({ error: 'unknown action' });
    }
  } catch (e) {
    console.error('[invoices] request failed', { action: action || req.method, code: (e && e.code) || 'error' });
    return res.status(500).json({ error: 'request_failed' });
  }
}

// ── setup readout ────────────────────────────────────────────────────────────
async function setupPayload(sql, tenant) {
  const [stats, pending, quarantined] = await Promise.all([
    store.inboundStats(sql),
    store.listInvoices(sql, tenant.id, { status: ['received', 'processing'], limit: 1 }),
    store.listQuarantined(sql, { limit: 1 }),
  ]);
  return {
    inbound: {
      configured: resend.inboundConfigured(),
      address: resend.inboundAddress(),
      webhookSecretSet: Boolean(process.env.RESEND_INBOUND_WEBHOOK_SECRET),
      apiKeySet: Boolean(process.env.RESEND_API_KEY),
      tokenSet: Boolean(process.env.INVOICE_INBOUND_TOKEN),
      domainSet: Boolean(process.env.INVOICE_INBOUND_DOMAIN),
      stats,
      quarantinedWaiting: quarantined.length > 0,
    },
    ai: { enabled: aiExtractModule.enabled(), model: aiExtractModule.enabled() ? aiExtractModule.AI_MODEL : null },
    autoConfirm: await autoConfirmSettings(),
    pending: pending.total,
    maxUploadBytes: MAX_UPLOAD_BYTES,
  };
}

// ── document proxy ───────────────────────────────────────────────────────────
async function serveDocument(sql, tenant, id, documentId, res) {
  const doc = await store.getDocumentWithBlob(sql, tenant.id, id, documentId);
  if (!doc) return res.status(404).json({ error: 'not found' });
  let bytes;
  try {
    bytes = await fetchInvoicePdf(doc.blobUrl, 20 * 1024 * 1024);
  } catch {
    return res.status(502).json({ error: 'document_unavailable' });
  }
  const contentType = doc.kind === 'image' && /^image\/(jpeg|png|webp)$/.test(doc.contentType || '') ? doc.contentType : 'application/pdf';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', String(bytes.length));
  res.setHeader('Content-Disposition', `inline; filename="${String(doc.filename || 'document').replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).end(bytes);
}

// ── upload ───────────────────────────────────────────────────────────────────
/** Decode + sniff an uploaded file. Returns { bytes, kind, contentType, filename } or an error response. */
function readUpload(body, res) {
  const decoded = decodeDataUrl(body.dataUrl, MAX_UPLOAD_BYTES);
  if (!decoded) { res.status(400).json({ error: 'file_required' }); return null; }
  if (decoded.tooLarge) { res.status(413).json({ error: 'file_too_large', maxBytes: MAX_UPLOAD_BYTES }); return null; }
  const sniff = sniffDocument(decoded.bytes);
  if (!sniff) { res.status(400).json({ error: 'not_a_pdf_or_image' }); return null; }
  return { bytes: decoded.bytes, kind: sniff.kind, contentType: sniff.contentType, filename: sanitiseFilenameFor(body.filename, sniff.contentType) };
}

async function storeDocumentFor(sql, tenant, me, invoiceId, file, source) {
  const digest = sha256Hex(file.bytes);
  const stored = await storeInvoicePdf({ tenantSlug: tenant.slug, invoiceId, filename: file.filename, bytes: file.bytes, contentType: file.contentType });
  await store.addDocument(sql, tenant.id, {
    invoiceId, source, kind: file.kind, filename: file.filename, contentType: file.contentType, byteSize: file.bytes.length,
    sha256: digest, blobPathname: stored.pathname, blobUrl: stored.url, uploadedBy: actorOf(me),
  });
  return digest;
}

async function upload(sql, tenant, me, body, res) {
  const file = readUpload(body, res);
  if (!file) return;
  const invoice = await store.createInvoice(sql, tenant.id, { source: 'upload', createdBy: actorOf(me) });
  let digest;
  try {
    digest = await storeDocumentFor(sql, tenant, me, invoice.id, file, 'upload');
  } catch (e) {
    await store.setStatus(sql, tenant.id, invoice.id, 'failed', { failureCode: 'storage_failed' });
    console.error('[invoices] upload storage failed', { code: (e && e.code) || 'blob' });
    return res.status(502).json({ error: 'storage_failed' });
  }
  await store.insertEvent(sql, tenant.id, invoice.id, { event: 'uploaded', actor: actorOf(me), detail: { filename: file.filename, byteSize: file.bytes.length, sha256: digest, kind: file.kind } });
  await store.claimOne(sql, tenant.id, invoice.id);
  const result = await processInvoice({ sql, tenantId: tenant.id, invoiceId: invoice.id, trigger: 'upload', deps: await pipelineDeps() });
  const detail = await detailWithJob(sql, tenant, invoice.id);
  await journal(me, 'invoice.uploaded', detail.invoice, `Uploaded supplier document ${file.filename}`, { filename: file.filename, outcome: result.status || result.code });
  return res.status(201).json(detail);
}

/**
 * A worker photographs a card receipt and picks the job (owner pull
 * 2026-09-25). The receipt becomes a supplier-invoice record (source
 * 'receipt') with the worker's job choice as its match, the photo is read
 * inline (Claude vision when opted in), and the worker is told plainly what
 * was read — or that the office will check it. Nothing books here: the office
 * confirms (or the owner knob lets clean receipts book themselves).
 */
async function submitReceipt(req, me, res) {
  if (!(await isFlagEnabled('receipt_capture', me)) || !(await isFlagOn('invoice_capture'))) return res.status(404).json({ error: 'not found' });
  if (!(isAdminRole(me.role) || isLeadingHandRole(me.role) || isFieldRole(me.role))) return res.status(403).json({ error: 'forbidden' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const jobId = typeof body.jobId === 'string' ? body.jobId : '';
  const jobs = await readJobs();
  const job = liveJob(jobs, jobId);
  if (!job || !isFieldOpenable(job)) return res.status(400).json({ error: 'job_not_available' });
  const file = readUpload(body, res);
  if (!file) return;
  let sql;
  let tenant;
  try {
    sql = getDb({ mode: 'write' });
    tenant = await store.resolveTenant(sql);
  } catch (e) {
    console.error('[invoices] receipt: store unavailable', { code: (e && e.code) || 'db' });
    return res.status(503).json({ error: 'store_unavailable' });
  }
  if (!tenant) return res.status(503).json({ error: 'store_unprovisioned' });
  const actor = actorOf(me);
  const note = typeof body.note === 'string' ? body.note.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  const invoice = await store.createInvoice(sql, tenant.id, {
    source: 'receipt', createdBy: actor,
    matchedJobId: job.id, matchedJobUuid: await store.resolveJobUuid(sql, tenant.id, job.id), matchStatus: 'manual',
    matchReason: { source: 'worker', field: 'chosen on the phone', chosenBy: actor.name, jobName: job.name || null, jobStatus: job.status || 'active', matchCount: 1, warnings: [] },
    paidPersonally: body.paidPersonally === true, workerNote: note || null,
  });
  try {
    await storeDocumentFor(sql, tenant, me, invoice.id, file, 'upload');
  } catch (e) {
    await store.setStatus(sql, tenant.id, invoice.id, 'failed', { failureCode: 'storage_failed' });
    console.error('[invoices] receipt storage failed', { code: (e && e.code) || 'blob' });
    return res.status(502).json({ error: 'storage_failed' });
  }
  await store.insertEvent(sql, tenant.id, invoice.id, { event: 'receipt_submitted', actor, detail: { jobId: job.id, kind: file.kind, byteSize: file.bytes.length, paidPersonally: body.paidPersonally === true } });
  await store.claimOne(sql, tenant.id, invoice.id);
  let result = { ok: false };
  try {
    result = await processInvoice({ sql, tenantId: tenant.id, invoiceId: invoice.id, trigger: 'receipt', deps: await pipelineDeps() });
  } catch {
    // stays received; the sweep reads it
  }
  const row = await store.getInvoiceRow(sql, tenant.id, invoice.id);
  const lines = typeof store.listInvoiceLines === 'function' ? await store.listInvoiceLines(sql, tenant.id, invoice.id) : [];
  await journal(me, 'invoice.uploaded', { ...row, matchedJobId: job.id }, `Logged a receipt to ${job.code || job.name || job.id}`, { receipt: true, paidPersonally: body.paidPersonally === true });
  const read = !!(result && result.ok) && row && row.totalCents != null && row.extractionMethod === 'ocr';
  return res.status(201).json({
    id: invoice.id,
    status: row ? row.status : 'received',
    duplicate: row ? row.status === 'duplicate' : false,
    read,
    storeName: row ? row.supplierName : null,
    totalCents: row ? row.totalCents : null,
    receiptDate: row ? row.invoiceDate : null,
    lineCount: lines.length,
    job: { id: job.id, name: job.name || job.id, code: typeof job.code === 'string' ? job.code : null },
    paidPersonally: body.paidPersonally === true,
  });
}

/** Give a record that arrived without a usable document (link-only email,
 *  forwarded-as-attachment, zip) its PDF or photo, then read it. */
async function attach(sql, tenant, me, current, body, res) {
  const existing = await store.getDocumentWithBlob(sql, tenant.id, current.id, null);
  if (existing) return res.status(409).json({ error: 'already_has_document' });
  if (!['needs_review', 'failed'].includes(current.status)) return res.status(409).json({ error: 'invalid_transition', status: current.status });
  const file = readUpload(body, res);
  if (!file) return;
  let digest;
  try {
    digest = await storeDocumentFor(sql, tenant, me, current.id, file, 'upload');
  } catch (e) {
    console.error('[invoices] attach storage failed', { code: (e && e.code) || 'blob' });
    return res.status(502).json({ error: 'storage_failed' });
  }
  await store.insertEvent(sql, tenant.id, current.id, { event: 'attached', actor: actorOf(me), detail: { filename: file.filename, byteSize: file.bytes.length, sha256: digest, kind: file.kind } });
  await store.claimOne(sql, tenant.id, current.id, { resetAttempts: true });
  const result = await processInvoice({ sql, tenantId: tenant.id, invoiceId: current.id, trigger: 'upload', deps: await pipelineDeps() });
  const detail = await detailWithJob(sql, tenant, current.id);
  await journal(me, 'invoice.uploaded', detail.invoice, `Attached ${file.filename} to a supplier invoice record`, { filename: file.filename, outcome: result.status || result.code, attached: true });
  return res.status(200).json(detail);
}

// ── processing ───────────────────────────────────────────────────────────────
async function processPending(sql, tenant, trigger, limit, budgetMs) {
  const started = Date.now();
  const claimed = await store.claimPending(sql, tenant.id, { limit });
  const out = [];
  for (const inv of claimed) {
    if (Date.now() - started > budgetMs) { out.push({ id: inv.id, status: 'deferred' }); continue; }
    const r = await processInvoice({ sql, tenantId: tenant.id, invoiceId: inv.id, trigger, deps: await pipelineDeps() });
    out.push({ id: inv.id, status: r.status || 'failed', code: r.code || null });
  }
  return out;
}

async function sweep(req, res) {
  let sql;
  let tenant;
  try {
    sql = getDb({ mode: 'write' });
    tenant = await store.resolveTenant(sql);
  } catch (e) {
    console.error('[invoices] sweep: store unavailable', { code: (e && e.code) || 'db' });
    return res.status(503).json({ error: 'store_unavailable' });
  }
  if (!tenant) return res.status(503).json({ error: 'store_unprovisioned' });
  const started = Date.now();
  const reingested = [];
  // 1. deliveries quarantined while the flag was off, or whose inline ingest died
  if (resend.inboundConfigured()) {
    const waiting = await store.listQuarantined(sql, { limit: 5 });
    const stale = await sql`select svix_message_id, provider_email_id from public.supplier_invoice_inbound_events
                            where status = 'received' and processed_at is null and created_at < now() - interval '5 minutes' order by created_at limit 5`;
    const targets = [...waiting.map((w) => ({ svixId: w.svixId, emailId: w.emailId })), ...stale.map((s) => ({ svixId: s.svix_message_id, emailId: s.provider_email_id }))];
    for (const t of targets) {
      if (!t.emailId || Date.now() - started > SWEEP_BUDGET_MS / 2) break;
      try {
        const r = await ingestReceivedEmail({ sql, tenant, emailId: t.emailId, deps: { store, resend, storePdf: storeInvoicePdf, sha256: sha256Hex, apiKey: process.env.RESEND_API_KEY } });
        await store.finishInboundEvent(sql, t.svixId, { status: 'processed' });
        reingested.push({ emailId: t.emailId, created: r.created.length, skipped: r.skipped.length });
      } catch (e) {
        const code = String((e && e.code) || 'ingest_failed').slice(0, 40);
        if (code === 'provider_not_found') await store.finishInboundEvent(sql, t.svixId, { status: 'failed', failureCode: code });
        reingested.push({ emailId: t.emailId, error: code });
      }
    }
  }
  // 2. extraction for anything received / stale
  const processed = await processPending(sql, tenant, 'sweep', SWEEP_BATCH, SWEEP_BUDGET_MS - (Date.now() - started));
  // 3. clean invoices whose grace window has passed book themselves
  const booked = await bookDueInvoices(sql, tenant);
  // 4. anything a person must know before Monday
  const alert = await maybeAlert(sql, tenant, { providerAuthFailed: reingested.some((r) => r.error === 'provider_auth') });
  console.log('[invoices] sweep', { reingested: reingested.length, processed: processed.length, booked: booked.length, alert: alert.key || null, alertSent: alert.sent });
  return res.status(200).json({ reingested, processed, booked, alert, ms: Date.now() - started });
}

/**
 * Mid-week alert (docs/invoice-capture.md "Alerts"): evaluate the health
 * snapshot every sweep; email the accounts list at most once a day per
 * condition set. State lives in a small blob so a redeploy never re-alerts.
 */
async function maybeAlert(sql, tenant, { providerAuthFailed }) {
  try {
    const [snap, settings, state] = await Promise.all([
      store.healthSnapshot(sql, tenant.id),
      getSettings('invoice_capture').catch(() => ({})),
      readBlob(ALERT_STATE_KEY, { key: '', sentAt: null }),
    ]);
    const conditions = evaluateAlerts(snap, { quietDays: Number(settings.alertQuietDays), providerAuthFailed });
    const key = alertKey(conditions);
    const now = Date.now();
    if (!key) {
      if (state.key) await writeBlob(ALERT_STATE_KEY, { key: '', sentAt: null, clearedAt: new Date(now).toISOString() });
      return { key: '', sent: false };
    }
    if (!shouldSend(state, key, now)) return { key, sent: false };
    const recipients = await readTimesheetRecipients();
    if (!recipients.length) return { key, sent: false, reason: 'no_recipients' };
    const base = process.env.APP_BASE_URL || 'https://buhlos.com';
    const msg = buildAlertEmail(conditions, { inboxUrl: `${base}/invoices` });
    const sent = await sendEmail({ to: recipients, subject: msg.subject, html: msg.html, text: msg.text });
    if (sent.ok) await writeBlob(ALERT_STATE_KEY, { key, sentAt: new Date(now).toISOString() });
    return { key, sent: !!sent.ok, reason: sent.ok ? undefined : sent.reason };
  } catch (e) {
    console.error('[invoices] alert evaluation failed', { code: (e && e.code) || 'error' });
    return { key: '', sent: false, reason: 'alert_failed' };
  }
}

/**
 * Automatic booking (docs/invoice-capture.md "Auto-booking"). Only when the
 * owner knob is on; each claim clears the deadline first so a crash mid-loop
 * can never book twice, and the allocation index makes a double book
 * impossible anyway. The eligibility verdict is re-checked against the
 * current row (a person may have edited it since it was scheduled).
 */
async function bookDueInvoices(sql, tenant) {
  const settings = await autoConfirmSettings();
  if (!settings.enabled) return [];
  const due = await store.claimAutoConfirmDue(sql, tenant.id, { limit: 10 });
  const out = [];
  const jobs = due.length ? await readJobs() : [];
  for (const inv of due) {
    const job = liveJob(jobs, inv.matchedJobId);
    const amountCents = allocationAmountCents(inv.documentType, inv.subtotalCents);
    const stillClean = job && (job.status || 'active') === 'active' && inv.status === 'matched' && !inv.heldAt && !inv.reviewedAt
      && inv.autoConfirmEligible && amountCents != null && confirmBlockers(inv).length === 0 && Math.abs(amountCents) < settings.capCents;
    if (!stillClean) {
      await store.insertEvent(sql, tenant.id, inv.id, { event: 'auto_confirm_skipped', detail: { reason: !job ? 'job_missing' : 'no_longer_clean' } });
      out.push({ id: inv.id, booked: false });
      continue;
    }
    try {
      const r = await store.confirmAllocation(sql, tenant.id, inv.id, {
        jobLegacyId: job.id, jobUuid: await store.resolveJobUuid(sql, tenant.id, job.id), amountCents,
        gstCents: inv.gstCents, totalCents: inv.totalCents, matchStatus: inv.matchStatus === 'inferred' ? 'inferred' : 'exact', actor: AUTO_ACTOR,
      });
      if (r.conflict) { out.push({ id: inv.id, booked: false }); continue; }
      await store.insertEvent(sql, tenant.id, inv.id, { event: 'auto_confirmed', actor: AUTO_ACTOR, detail: { jobId: job.id, amountCents, checks: inv.autoConfirmChecks } });
      await journal({ id: AUTO_ACTOR.id, name: AUTO_ACTOR.name, role: AUTO_ACTOR.role }, 'invoice.auto_confirmed', { ...inv, matchedJobId: job.id },
        `Booked a supplier ${inv.documentType === 'credit_note' ? 'credit note' : 'invoice'} automatically against ${job.code || job.id}`, { documentType: inv.documentType });
      out.push({ id: inv.id, booked: true });
    } catch (e) {
      console.error('[invoices] auto-booking failed', { code: (e && e.code) || 'error' });
      out.push({ id: inv.id, booked: false });
    }
  }
  return out;
}

/** Monday digest → the accounts recipient list (the same list timesheets go to). */
async function digest(req, res) {
  let sql;
  let tenant;
  try {
    sql = getDb({ mode: 'read' });
    tenant = await store.resolveTenant(sql);
  } catch (e) {
    console.error('[invoices] digest: store unavailable', { code: (e && e.code) || 'db' });
    return res.status(503).json({ error: 'store_unavailable' });
  }
  if (!tenant) return res.status(503).json({ error: 'store_unprovisioned' });
  const recipients = await readTimesheetRecipients();
  if (!recipients.length) return res.status(200).json({ skipped: 'no_recipients' });
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const stats = await store.digestStats(sql, tenant.id, { since });
  const jobs = await readJobs();
  const label = (row) => { const j = jobs.find((x) => x && x.id === row.matchedJobId); return j ? `${j.code ? `${j.code} · ` : ''}${j.name || j.id}` : row.matchedJobId; };
  const base = process.env.APP_BASE_URL || 'https://buhlos.com';
  const decorate = (list) => list.map((r) => ({ ...r, jobLabel: label(r), url: `${base}/invoices/${r.id}` }));
  const msg = buildDigest({
    weekLabel: `week to ${new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'Australia/Sydney' })}`,
    capturedCount: stats.capturedCount,
    autoBooked: decorate(stats.autoBooked), humanBooked: decorate(stats.humanBooked),
    pending: decorate(stats.pending), bookingSoon: decorate(stats.bookingSoon),
    failedCount: stats.failedCount, stuckCount: stats.stuckCount, lastReceivedAt: stats.lastReceivedAt, everReceived: stats.everReceived,
    inboxUrl: `${base}/invoices`,
  });
  const sent = await sendEmail({ to: recipients, subject: msg.subject, html: msg.html, text: msg.text });
  console.log('[invoices] digest', { recipients: recipients.length, ok: sent.ok, attention: msg.attention });
  return res.status(200).json({ sent: sent.ok, reason: sent.ok ? null : sent.reason, recipients: recipients.length, attention: msg.attention });
}

async function hold(sql, tenant, me, current, res) {
  if (!['matched', 'needs_review'].includes(current.status)) return res.status(409).json({ error: 'invalid_transition', status: current.status });
  await store.holdInvoice(sql, tenant.id, current.id, actorOf(me));
  await store.insertEvent(sql, tenant.id, current.id, { event: 'held', actor: actorOf(me), detail: { hadDeadline: !!current.autoConfirmAt } });
  const detail = await detailWithJob(sql, tenant, current.id);
  await journal(me, 'invoice.held', detail.invoice, 'Held a supplier invoice — it will not book automatically', {});
  return res.status(200).json(detail);
}

async function supplierPref(sql, tenant, me, current, body, res) {
  if (!current.supplierKey) return res.status(409).json({ error: 'no_supplier' });
  const alwaysReview = body.alwaysReview === true;
  await store.setSupplierPref(sql, tenant.id, current.supplierKey, { alwaysReview, actor: actorOf(me) });
  if (alwaysReview && current.autoConfirmAt) await store.holdInvoice(sql, tenant.id, current.id, actorOf(me));
  await store.insertEvent(sql, tenant.id, current.id, { event: 'supplier_pref_changed', actor: actorOf(me), detail: { supplierKey: current.supplierKey, alwaysReview } });
  const detail = await detailWithJob(sql, tenant, current.id);
  await journal(me, 'invoice.supplier_pref_changed', detail.invoice, `${alwaysReview ? 'Always review' : 'Allow automatic booking for'} ${current.supplierName || current.supplierKey}`, { alwaysReview });
  return res.status(200).json(detail);
}

async function retry(sql, tenant, me, current, res) {
  if (!canTransition(current.status, 'retry')) return res.status(409).json({ error: 'invalid_transition', status: current.status });
  await store.claimOne(sql, tenant.id, current.id, { resetAttempts: true });
  await store.insertEvent(sql, tenant.id, current.id, { event: 'retried', actor: actorOf(me) });
  const result = await processInvoice({ sql, tenantId: tenant.id, invoiceId: current.id, trigger: 'retry', deps: await pipelineDeps() });
  const detail = await detailWithJob(sql, tenant, current.id);
  await journal(me, 'invoice.retried', detail.invoice, 'Re-read a supplier invoice', { outcome: result.status || result.code });
  return res.status(200).json(detail);
}

// ── corrections ──────────────────────────────────────────────────────────────
/** Re-file (or rename) one line item; the category choice is remembered per supplier + product. */
async function correctLine(sql, tenant, me, id, body, res) {
  const current = await store.getInvoiceRow(sql, tenant.id, id);
  if (!current) return res.status(404).json({ error: 'not found' });
  if (current.status === 'archived') return res.status(409).json({ error: 'invalid_transition', status: current.status });
  const lineNo = Number(body.lineNo);
  if (!Number.isInteger(lineNo) || lineNo < 1) return res.status(400).json({ error: 'invalid_input', details: ['lineNo_invalid'] });
  const patch = {};
  if (body.category !== undefined) {
    if (!isCategory(body.category)) return res.status(400).json({ error: 'invalid_input', details: ['category_invalid'] });
    patch.category = body.category;
  }
  if (body.description !== undefined) {
    const d = String(body.description || '').trim().slice(0, 200);
    if (!d) return res.status(400).json({ error: 'invalid_input', details: ['description_required'] });
    patch.description = d;
    patch.descriptionKey = descriptionKey(d) || 'unknown';
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'invalid_input', details: ['nothing_to_change'] });
  const line = await store.updateInvoiceLine(sql, tenant.id, id, lineNo, patch);
  if (!line) return res.status(404).json({ error: 'line_not_found' });
  if (patch.category && body.remember !== false) {
    await store.rememberCategory(sql, tenant.id, { supplierKey: current.supplierKey, descriptionKey: line.descriptionKey, category: patch.category, actor: actorOf(me) });
  }
  await store.insertEvent(sql, tenant.id, id, { event: 'line_corrected', actor: actorOf(me), detail: { lineNo, category: patch.category || null, renamed: !!patch.description, remembered: !!(patch.category && body.remember !== false) } });
  const detail = await detailWithJob(sql, tenant, id);
  await journal(me, 'invoice.corrected', detail.invoice, `Re-filed line ${lineNo} of a supplier invoice${patch.category ? ` as ${CATEGORY_LABELS[patch.category]}` : ''}`, { lineNo, category: patch.category || null });
  return res.status(200).json(detail);
}

async function correct(sql, tenant, me, id, body, res) {
  const current = await store.getInvoiceRow(sql, tenant.id, id);
  if (!current) return res.status(404).json({ error: 'not found' });
  if (!canTransition(current.status, 'correct')) return res.status(409).json({ error: 'invalid_transition', status: current.status });

  const errors = [];
  const patch = {};
  const fields = { ...(current.fields || {}) };
  const manual = (value) => ({ value, confidence: 'high', provenance: 'manual', label: 'entered by office', line: null });

  if (body.supplierName !== undefined) {
    const v = body.supplierName == null ? null : String(body.supplierName).trim().slice(0, 120);
    if (!v) errors.push('supplierName_required');
    else { patch.supplierName = v; patch.supplierKey = normaliseSupplierName(v); fields.supplierName = manual(v); }
  }
  if (body.supplierInvoiceNumber !== undefined) {
    const v = body.supplierInvoiceNumber == null ? null : String(body.supplierInvoiceNumber).trim().slice(0, 40);
    if (v && normaliseIvReference(v)) errors.push('supplierInvoiceNumber_is_iv_reference');
    else { patch.supplierInvoiceNumber = v || null; fields.supplierInvoiceNumber = manual(v || null); }
  }
  if (body.documentType !== undefined) {
    if (!DOCUMENT_TYPES.includes(body.documentType)) errors.push('documentType_invalid');
    else { patch.documentType = body.documentType; fields.documentType = manual(body.documentType); }
  }
  if (body.invoiceDate !== undefined) {
    const v = body.invoiceDate == null || body.invoiceDate === '' ? null : String(body.invoiceDate);
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors.push('invoiceDate_invalid');
    else { patch.invoiceDate = v; fields.invoiceDate = manual(v); }
  }
  const subtotal = parseCents(body.subtotalCents, 'subtotalCents', errors);
  const gst = parseCents(body.gstCents, 'gstCents', errors);
  const total = parseCents(body.totalCents, 'totalCents', errors);
  if (errors.length) return res.status(400).json({ error: 'invalid_input', details: errors });

  const merged = {
    subtotalCents: subtotal === undefined ? current.subtotalCents : subtotal,
    gstCents: gst === undefined ? current.gstCents : gst,
    totalCents: total === undefined ? current.totalCents : total,
  };
  if (subtotal !== undefined || gst !== undefined || total !== undefined) {
    const t = reconcileTotals(merged);
    patch.subtotalCents = t.subtotalCents;
    patch.gstCents = t.gstCents;
    patch.totalCents = t.totalCents;
    patch.totalsConsistent = t.consistent;
    if (subtotal !== undefined) fields.subtotalCents = manual(t.subtotalCents);
    if (gst !== undefined) fields.gstCents = manual(t.gstCents);
    if (total !== undefined) fields.totalCents = manual(t.totalCents);
  }

  let jobs = null;
  if (body.ivReference !== undefined) {
    const raw = body.ivReference == null ? '' : String(body.ivReference).trim();
    if (!raw) {
      patch.ivReferenceRaw = null; patch.ivReference = null; patch.matchStatus = 'none'; patch.matchReason = null;
      patch.matchedJobId = null; patch.matchedJobUuid = null;
      fields.ivReference = manual(null);
    } else {
      const norm = normaliseIvReference(raw);
      if (!norm) return res.status(400).json({ error: 'invalid_input', details: ['ivReference_malformed'] });
      jobs = await readJobs();
      const m = matchJobByIv(norm, buildJobCodeIndex(jobs));
      patch.ivReferenceRaw = raw.slice(0, 40);
      patch.ivReference = norm;
      fields.ivReference = manual(norm);
      patch.matchReason = { raw, normalised: norm, label: 'entered by office', source: 'manual', field: 'jobs.json code', matchCount: m.matchCount, warnings: m.warnings };
      if (m.status === 'exact') {
        patch.matchStatus = 'exact'; patch.matchedJobId = m.job.id; patch.matchedJobUuid = await store.resolveJobUuid(sql, tenant.id, m.job.id);
        patch.matchReason.jobName = m.job.name || null; patch.matchReason.jobStatus = m.job.status || 'active';
      } else {
        patch.matchStatus = m.status === 'ambiguous' ? 'ambiguous' : 'not_found';
        patch.matchedJobId = null; patch.matchedJobUuid = null;
      }
    }
  }

  const next = { ...current, ...patch };
  patch.reviewReasons = reviewReasonsAfterEdit(next);
  patch.status = statusAfterEdit(next, patch.reviewReasons);
  patch.fields = fields;
  patch.actor = actorOf(me);
  await store.updateInvoiceFields(sql, tenant.id, id, patch);
  const changed = Object.keys(body).filter((k) => ['supplierName', 'supplierInvoiceNumber', 'documentType', 'invoiceDate', 'subtotalCents', 'gstCents', 'totalCents', 'ivReference'].includes(k));
  await store.insertEvent(sql, tenant.id, id, { event: 'corrected', actor: actorOf(me), detail: { fields: changed, status: patch.status } });
  const detail = await detailWithJob(sql, tenant, id, jobs);
  await journal(me, 'invoice.corrected', detail.invoice, `Corrected supplier invoice details (${changed.join(', ')})`, { fields: changed });
  return res.status(200).json(detail);
}

async function selectJob(sql, tenant, me, current, body, res) {
  if (!canTransition(current.status, 'select_job')) return res.status(409).json({ error: 'invalid_transition', status: current.status });
  const jobId = String(body.jobId || '').trim();
  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  const jobs = await readJobs();
  const job = liveJob(jobs, jobId);
  if (!job) return res.status(404).json({ error: 'job_not_found' });
  const patch = {
    matchedJobId: job.id,
    matchedJobUuid: await store.resolveJobUuid(sql, tenant.id, job.id),
    matchStatus: 'manual',
    matchReason: { source: 'manual', field: 'selected by office', jobName: job.name || null, jobStatus: job.status || 'active', jobCode: job.code || null, previousJobId: current.matchedJobId || null, matchCount: 1, warnings: [] },
    actor: actorOf(me),
  };
  const next = { ...current, ...patch };
  patch.reviewReasons = reviewReasonsAfterEdit(next);
  patch.status = statusAfterEdit(next, patch.reviewReasons);
  await store.updateInvoiceFields(sql, tenant.id, current.id, patch);
  await store.insertEvent(sql, tenant.id, current.id, { event: 'job_selected', actor: actorOf(me), detail: { jobId: job.id, previousJobId: current.matchedJobId || null } });
  const detail = await detailWithJob(sql, tenant, current.id, jobs);
  await journal(me, 'invoice.job_selected', detail.invoice, `Chose job ${job.code || job.id} for a supplier invoice`, { previousJobId: current.matchedJobId || null });
  return res.status(200).json(detail);
}

// ── the money ────────────────────────────────────────────────────────────────
async function confirm(sql, tenant, me, current, body, res) {
  if (!canTransition(current.status, 'confirm')) {
    // Idempotent re-click: an already-confirmed invoice for the same job returns 200 unchanged.
    if (current.status === 'confirmed' && (!body.jobId || body.jobId === current.matchedJobId)) {
      return res.status(200).json({ ...(await detailWithJob(sql, tenant, current.id)), alreadyConfirmed: true });
    }
    return res.status(409).json({ error: 'invalid_transition', status: current.status });
  }
  const blockers = confirmBlockers(current).filter((b) => b !== 'status' && b !== 'no_job');
  if (blockers.length) return res.status(409).json({ error: 'cannot_confirm', blockers });
  const jobs = await readJobs();
  const jobId = String(body.jobId || current.matchedJobId || '').trim();
  if (!jobId) return res.status(400).json({ error: 'no_job' });
  const job = liveJob(jobs, jobId);
  if (!job) return res.status(404).json({ error: 'job_not_found' });
  if (body.jobId && body.jobId !== current.matchedJobId) {
    // The client may not silently confirm onto a job the server never matched.
    return res.status(409).json({ error: 'job_mismatch', matchedJobId: current.matchedJobId || null });
  }
  const amountCents = allocationAmountCents(current.documentType, current.subtotalCents);
  if (amountCents == null) return res.status(409).json({ error: 'cannot_confirm', blockers: ['missing_subtotal'] });

  const r = await store.confirmAllocation(sql, tenant.id, current.id, {
    jobLegacyId: job.id,
    jobUuid: await store.resolveJobUuid(sql, tenant.id, job.id),
    amountCents,
    gstCents: current.gstCents,
    totalCents: current.totalCents,
    matchStatus: current.matchStatus === 'exact' || current.matchStatus === 'inferred' ? current.matchStatus : 'manual',
    actor: actorOf(me),
  });
  if (r.conflict) return res.status(409).json({ error: 'already_allocated', allocation: r.allocation });
  const detail = await detailWithJob(sql, tenant, current.id, jobs);
  if (!r.alreadyConfirmed) {
    await journal(me, 'invoice.confirmed', detail.invoice, `Confirmed a supplier ${current.documentType === 'credit_note' ? 'credit note' : 'invoice'} against ${job.code || job.id}`, { documentType: current.documentType });
  }
  return res.status(200).json({ ...detail, alreadyConfirmed: !!r.alreadyConfirmed });
}

async function reassign(sql, tenant, me, current, body, res) {
  if (!canTransition(current.status, 'reassign')) return res.status(409).json({ error: 'invalid_transition', status: current.status });
  const jobId = String(body.jobId || '').trim();
  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  if (jobId === current.matchedJobId) return res.status(200).json({ ...(await detailWithJob(sql, tenant, current.id)), unchanged: true });
  const jobs = await readJobs();
  const job = liveJob(jobs, jobId);
  if (!job) return res.status(404).json({ error: 'job_not_found' });
  const amountCents = allocationAmountCents(current.documentType, current.subtotalCents);
  if (amountCents == null) return res.status(409).json({ error: 'cannot_confirm', blockers: ['missing_subtotal'] });
  await store.reassignAllocation(sql, tenant.id, current.id, {
    jobLegacyId: job.id, jobUuid: await store.resolveJobUuid(sql, tenant.id, job.id), amountCents,
    gstCents: current.gstCents, totalCents: current.totalCents, actor: actorOf(me),
  });
  const detail = await detailWithJob(sql, tenant, current.id, jobs);
  await journal(me, 'invoice.reassigned', detail.invoice, `Moved a supplier invoice from ${current.matchedJobId || '—'} to ${job.code || job.id}`, { previousJobId: current.matchedJobId || null });
  return res.status(200).json(detail);
}

async function markDuplicate(sql, tenant, me, current, body, res) {
  if (!canTransition(current.status, 'mark_duplicate')) return res.status(409).json({ error: 'invalid_transition', status: current.status });
  let ofId = null;
  if (body.duplicateOfId) {
    const other = await store.getInvoiceRow(sql, tenant.id, String(body.duplicateOfId));
    if (!other || other.id === current.id) return res.status(404).json({ error: 'duplicate_of_not_found' });
    ofId = other.id;
  }
  await store.transitionWithReversal(sql, tenant.id, current.id, {
    status: 'duplicate', actor: actorOf(me), event: 'marked_duplicate', detail: { ofId },
    extra: { duplicateOfId: ofId, duplicateReason: 'manual' },
  });
  const detail = await detailWithJob(sql, tenant, current.id);
  await journal(me, 'invoice.marked_duplicate', detail.invoice, 'Marked a supplier invoice as a duplicate', { duplicateOfId: ofId });
  return res.status(200).json(detail);
}

async function exclude(sql, tenant, me, current, body, res) {
  if (!canTransition(current.status, 'exclude')) return res.status(409).json({ error: 'invalid_transition', status: current.status });
  const reason = body.reason == null ? null : String(body.reason).trim().slice(0, 200) || null;
  const r = await store.transitionWithReversal(sql, tenant.id, current.id, {
    status: 'excluded', actor: actorOf(me), event: 'excluded', detail: { reason, wasConfirmed: current.status === 'confirmed' },
    extra: { excludedReason: reason },
  });
  const detail = await detailWithJob(sql, tenant, current.id);
  await journal(me, 'invoice.excluded', detail.invoice, `Excluded a supplier document${r.reversed ? ' (cost reversed)' : ''}`, { reason, reversed: !!r.reversed });
  return res.status(200).json(detail);
}

async function archive(sql, tenant, me, current, res) {
  if (!canTransition(current.status, 'archive')) return res.status(409).json({ error: 'invalid_transition', status: current.status });
  const r = await store.transitionWithReversal(sql, tenant.id, current.id, {
    status: 'archived', actor: actorOf(me), event: 'archived', detail: { wasConfirmed: current.status === 'confirmed', previousStatus: current.status },
  });
  const detail = await detailWithJob(sql, tenant, current.id);
  await journal(me, 'invoice.archived', detail.invoice, `Archived a supplier invoice${r.reversed ? ' (cost reversed)' : ''}`, { reversed: !!r.reversed, previousStatus: current.status });
  return res.status(200).json(detail);
}

async function restore(sql, tenant, me, current, res) {
  if (!canTransition(current.status, 'restore')) return res.status(409).json({ error: 'invalid_transition', status: current.status });
  const reasons = reviewReasonsAfterEdit(current);
  await store.setStatus(sql, tenant.id, current.id, 'needs_review', {
    actor: actorOf(me), clearArchive: true, excludedReason: null,
    duplicateOfId: current.status === 'duplicate' ? null : undefined, duplicateReason: current.status === 'duplicate' ? null : undefined,
  });
  await store.updateInvoiceFields(sql, tenant.id, current.id, { reviewReasons: reasons, actor: actorOf(me) });
  await store.insertEvent(sql, tenant.id, current.id, { event: 'restored', actor: actorOf(me), detail: { from: current.status } });
  const detail = await detailWithJob(sql, tenant, current.id);
  await journal(me, 'invoice.restored', detail.invoice, `Restored a supplier invoice from ${current.status}`, { from: current.status });
  return res.status(200).json(detail);
}

module.exports = withErrorCapture(handler, 'invoices');
module.exports.__test = { confirmBlockers, reviewReasonsAfterEdit, statusAfterEdit, decideMatch, MAX_UPLOAD_BYTES, bookDueInvoices };
