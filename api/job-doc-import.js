// BuhlOS — pricing/BOQ workbook import.  (#365)
//
//   POST /api/job-doc-import                        body: { fileName, mimeType, dataUrl }
//     → 200 { preview, readOnly: true }             (Sansara-shaped parse + review only)
//   POST /api/job-doc-import?action=create-job      body: { ...workbook, name, quoteId? }
//     → 201 { jobId, job, costBasis }               (creates a real DRAFT job; with
//                                                    quoteId it records the job↔quote
//                                                    link: job.fromQuoteId ↔ quote.linkedJobId)
//   POST /api/job-doc-import?action=attach-to-quote body: { ...workbook, quoteId? | quoteName? }
//     → 200 { quoteId, importId, counts, totals }   (imports AGAINST A QUOTE: lines with
//                                                    {sheet,cell} provenance, named health
//                                                    findings, classification defaults;
//                                                    re-upload SUPERSEDES with a kept record)
//   POST ?action=confirm-classification             body: { quoteId, lineId, classification }
//   POST ?action=resolve-finding                    body: { quoteId, findingId, resolution, reason? }
//   POST ?action=complete-review                    body: { quoteId }
//   GET  ?jobId=                                    → { costImport }        (hub cost card)
//   GET  ?quoteId=                                  → { workbookImport }    (quote review card)
//
// The quote-side import stores its record at quotes-v2/<id>/workbook-import.json
// (covered by the quotes-v2/ backup prefix) and MATERIALISES the base-classified
// lines into import-owned sections (id prefix `qsec_wb_`) on the v2 quote
// document through the api/quotes-v2.js store helpers — so the quote's totals,
// the registry row and the #366 reconciliation engine all see the imported
// lines. Alternate / excluded / PC-sum / by-others lines are NEVER materialised
// into the base document until a human re-classifies them (AC hard rule).
//
// Nothing imported is auto-trusted: the record carries review status + open
// finding / unconfirmed-classification counts until an admin completes review.
//
// Dark by default behind the `job_doc_import` flag (admin-tier) so the surface
// is invisible until proven on a preview deploy; the handler also 403s any
// non-admin. The pure parsers live in api/_lib/boq-import.js; the sole job
// writer is api/_lib/job-create.js (createJob).

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isAdminRole } = require('./_lib/auth');
const { isFlagEnabled } = require('./_lib/feature-flags');
const {
  parseBoqFromXlsx,
  parseQuoteWorkbookFromXlsx,
  QUOTE_LINE_CLASSIFICATIONS,
} = require('./_lib/boq-import');
const { createJob } = require('./_lib/job-create');
const { buildJobCreatedEntry } = require('./_lib/job-create-audit');
const { append: appendAuditLog } = require('./_lib/audit-log');
const { store: quoteStore } = require('./quotes-v2');

const MAX_BYTES = 15 * 1024 * 1024;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Import-owned quote sections carry this id prefix — the ONLY sections the
 *  importer may replace on re-upload/re-classification. Builder-authored
 *  sections are never touched. */
const IMPORT_SECTION_PREFIX = 'qsec_wb_';

const workbookImportKey = (quoteId) => `quotes-v2/${quoteId}/workbook-import.json`;

// Decode the data: URL into a size/type-checked Buffer. Returns { buf } or
// { error, status }. Shared by every workbook-carrying action.
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

// ── Quote-side import record helpers ─────────────────────────────────────────

/** A line's classification: the human confirmation wins over the detection default. */
function effectiveClassification(record, line) {
  const confirmed = (record.confirmations || []).find((c) => c.lineId === line.id);
  return confirmed ? confirmed.classification : line.classification;
}

/** The honest review counters: open findings (not resolved/waived) and
 *  classifications no human has confirmed yet. */
function importStatus(record) {
  const resolvedIds = new Set((record.resolutions || []).map((r) => r.findingId));
  const confirmedIds = new Set((record.confirmations || []).map((c) => c.lineId));
  const findings = (record.current && record.current.parse.findings) || [];
  const lines = (record.current && record.current.parse.lines) || [];
  return {
    openFindings: findings.filter((f) => !resolvedIds.has(f.id)).length,
    unconfirmedClassifications: lines.filter((l) => !confirmedIds.has(l.id)).length,
  };
}

/** Wire projection of the stored record (adds the computed status counters). */
function projectImportRecord(record) {
  return {
    quoteId: record.quoteId,
    current: record.current,
    confirmations: record.confirmations || [],
    resolutions: record.resolutions || [],
    review: record.review || { status: 'pending' },
    superseded: record.superseded || [],
    status: importStatus(record),
  };
}

/**
 * Base-classified lines → import-owned quote sections. Only lines a human
 * could bill land: qty+rate as parsed (the checkable arithmetic), or a lone
 * subtotal as qty 1 × subtotal. Non-base classifications NEVER materialise —
 * alternates are never counted in the base total.
 */
function materialiseImportSections(record) {
  const parse = record.current.parse;
  const groups = new Map();
  let materialised = 0;
  for (const line of parse.lines) {
    if (effectiveClassification(record, line) !== 'base') continue;
    let qty;
    let rate;
    if (line.qty != null && line.rate != null) {
      qty = line.qty;
      rate = line.rate;
    } else if (line.subtotal != null) {
      qty = 1;
      rate = line.subtotal;
    } else {
      continue; // no number at all — never invent one (P7)
    }
    const max = quoteStore.LIMITS.maxRate;
    if (!Number.isFinite(qty) || !Number.isFinite(rate) || qty < 0 || qty > quoteStore.LIMITS.maxQty || Math.abs(rate) > max) {
      continue;
    }
    const key = line.section || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      id: line.id,
      kind: 'other',
      description: (line.description || 'Imported line').slice(0, quoteStore.LIMITS.maxLineDescription),
      qty,
      unit: String(line.unit || '').slice(0, quoteStore.LIMITS.maxUnit),
      rate,
    });
    materialised += 1;
  }
  const sections = [...groups.entries()].map(([name, lines], i) => ({
    id: IMPORT_SECTION_PREFIX + (i + 1),
    title: (name ? `Imported — ${name}` : 'Imported BOQ').slice(0, quoteStore.LIMITS.maxSectionTitle),
    sortOrder: 0, // normalised on write
    lines,
  }));
  return { sections, materialised };
}

/**
 * Replace the import-owned sections on the quote document (builder-authored
 * sections untouched), recompute totals, refresh the registry row. Guarded by
 * expectedRev with a re-read retry — a racing builder save is never clobbered.
 */
async function applyImportToQuoteDoc(quoteId, importSections) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await readBlob(quoteStore.docKey(quoteId), null);
    if (!current) return { error: 'quote not found', status: 404 };
    const kept = (current.sections || []).filter(
      (s) => !String(s && s.id).startsWith(IMPORT_SECTION_PREFIX)
    );
    const sections = [...kept, ...importSections].map((s, i) => ({ ...s, sortOrder: i }));
    const next = {
      ...quoteStore.toWire(current),
      sections,
      totals: quoteStore.computeQuoteTotals(sections),
      updatedAt: new Date().toISOString(),
    };
    try {
      await writeBlob(quoteStore.docKey(quoteId), next, {
        expectedRev: quoteStore.currentRevOf(current),
      });
      await quoteStore.upsertRegistryRow(next);
      return { doc: next };
    } catch (e) {
      if (e && e.code === 'stale_write' && attempt < 3) continue;
      throw e;
    }
  }
  return { error: 'quote is being edited — try again', status: 409 };
}

// ── attach-to-quote: the #365 quote-side import ──────────────────────────────

async function attachWorkbookToQuote(req, res, user, buf) {
  const body = req.body || {};

  // Parse with the generic quote-workbook parser (provenance + health checks).
  let parse;
  try {
    parse = parseQuoteWorkbookFromXlsx(buf);
  } catch (err) {
    const msg = err && err.message ? err.message : 'parse error';
    return res.status(422).json({ error: 'could not read workbook: ' + msg });
  }
  if (parse.counts.lines === 0) {
    return res.status(422).json({
      error: 'no priced BOQ lines found in the workbook — check it has a Description/Qty/Rate/Amount table',
    });
  }

  // Target quote: existing (quoteId) or a fresh draft (quoteName).
  let quoteDoc;
  const quoteId = body.quoteId ? String(body.quoteId) : '';
  if (quoteId) {
    quoteDoc = await readBlob(quoteStore.docKey(quoteId), null);
    if (!quoteDoc) return res.status(404).json({ error: 'quote not found' });
  } else {
    const quoteName = String(body.quoteName || '').trim();
    if (!quoteName) return res.status(400).json({ error: 'quoteId or quoteName required' });
    const now = new Date().toISOString();
    quoteDoc = {
      id: quoteStore.uid('qv2'),
      name: quoteName.slice(0, quoteStore.LIMITS.maxName),
      clientName: null,
      status: 'draft',
      createdAt: now,
      createdBy: user.username || user.id,
      updatedAt: now,
      sections: [],
      totals: quoteStore.computeQuoteTotals([]),
    };
    await writeBlob(quoteStore.docKey(quoteDoc.id), quoteDoc);
    await quoteStore.upsertRegistryRow(quoteDoc);
  }
  const targetQuoteId = quoteId || quoteDoc.id;

  // Re-upload SUPERSEDES the prior import — the prior one stays as a kept
  // record (who/when/which workbook + its counts), never a silent second copy.
  const prior = await readBlob(workbookImportKey(targetQuoteId), null);
  const superseded = prior && prior.current
    ? [
        ...(prior.superseded || []),
        {
          importId: prior.current.importId,
          importedAt: prior.current.importedAt,
          importedByName: prior.current.importedByName,
          fileName: prior.current.fileName,
          lineCount: prior.current.parse.counts.lines,
          findingCount: prior.current.parse.counts.findings,
          supersededAt: new Date().toISOString(),
          supersededById: user.id,
        },
      ]
    : [];

  const record = {
    quoteId: targetQuoteId,
    current: {
      importId: 'wbimp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      importedAt: new Date().toISOString(),
      importedById: user.id,
      importedByName: user.username || user.id,
      fileName: body.fileName ? String(body.fileName).slice(0, 200) : null,
      parse,
    },
    // A new upload is new data: confirmations/resolutions restart (no silent
    // carry-over of decisions made about different cells) — review is pending.
    confirmations: [],
    resolutions: [],
    review: { status: 'pending' },
    superseded,
  };
  await writeBlob(workbookImportKey(targetQuoteId), record);

  const { sections, materialised } = materialiseImportSections(record);
  const applied = await applyImportToQuoteDoc(targetQuoteId, sections);
  if (applied.error) return res.status(applied.status).json({ error: applied.error });

  const status = importStatus(record);
  return res.status(200).json({
    quoteId: targetQuoteId,
    quoteName: applied.doc.name,
    importId: record.current.importId,
    counts: {
      lines: parse.counts.lines,
      findings: parse.counts.findings,
      unconfirmedClassifications: status.unconfirmedClassifications,
      materialisedLines: materialised,
    },
    totals: parse.totals,
    supersededCount: superseded.length,
  });
}

// ── Review actions on a stored quote import ──────────────────────────────────

async function withImportRecord(req, res, fn) {
  const body = req.body || {};
  const quoteId = String(body.quoteId || '');
  if (!quoteId) return res.status(400).json({ error: 'quoteId required' });
  const record = await readBlob(workbookImportKey(quoteId), null);
  if (!record || !record.current) {
    return res.status(404).json({ error: 'no workbook import on this quote' });
  }
  return fn(quoteId, record, body);
}

async function confirmClassification(req, res, user) {
  return withImportRecord(req, res, async (quoteId, record, body) => {
    const lineId = String(body.lineId || '');
    const classification = String(body.classification || '');
    if (!QUOTE_LINE_CLASSIFICATIONS.includes(classification)) {
      return res.status(400).json({ error: 'classification must be one of ' + QUOTE_LINE_CLASSIFICATIONS.join('|') });
    }
    const line = record.current.parse.lines.find((l) => l.id === lineId);
    if (!line) return res.status(404).json({ error: 'line not found on the current import' });

    record.confirmations = [
      ...(record.confirmations || []).filter((c) => c.lineId !== lineId),
      { lineId, classification, by: user.username || user.id, at: new Date().toISOString() },
    ];
    await writeBlob(workbookImportKey(quoteId), record);

    // Classification changes base membership — re-materialise the quote doc.
    const { sections } = materialiseImportSections(record);
    const applied = await applyImportToQuoteDoc(quoteId, sections);
    if (applied.error) return res.status(applied.status).json({ error: applied.error });

    return res.status(200).json({ workbookImport: projectImportRecord(record) });
  });
}

async function resolveFinding(req, res, user) {
  return withImportRecord(req, res, async (quoteId, record, body) => {
    const findingId = String(body.findingId || '');
    const resolution = String(body.resolution || '');
    if (resolution !== 'resolved' && resolution !== 'waived') {
      return res.status(400).json({ error: 'resolution must be resolved|waived' });
    }
    const finding = record.current.parse.findings.find((f) => f.id === findingId);
    if (!finding) return res.status(404).json({ error: 'finding not found on the current import' });

    record.resolutions = [
      ...(record.resolutions || []).filter((r) => r.findingId !== findingId),
      {
        findingId,
        action: resolution,
        reason: body.reason ? String(body.reason).slice(0, 500) : null,
        by: user.username || user.id,
        at: new Date().toISOString(),
      },
    ];
    await writeBlob(workbookImportKey(quoteId), record);
    return res.status(200).json({ workbookImport: projectImportRecord(record) });
  });
}

async function completeReview(req, res, user) {
  return withImportRecord(req, res, async (quoteId, record) => {
    const status = importStatus(record);
    // Honest completion: the counts at sign-off are stamped on the record —
    // completing review never fakes a clean state.
    record.review = {
      status: 'complete',
      completedBy: user.username || user.id,
      completedAt: new Date().toISOString(),
      openFindingsAtCompletion: status.openFindings,
      unconfirmedAtCompletion: status.unconfirmedClassifications,
    };
    await writeBlob(workbookImportKey(quoteId), record);
    return res.status(200).json({ workbookImport: projectImportRecord(record) });
  });
}

// ── create-job (the original #365 write-half, + the job↔quote link) ─────────

// Create a real DRAFT job from a reviewed BOQ and attach the parsed bill as the
// job's cost basis. createJob() is the sole sanctioned job writer; we add only
// the cost-basis attachment + the job.created audit. NO areas/tasks are
// invented — a BOQ is a priced bill and carries neither (P7).
//
// With body.quoteId the created job records `fromQuoteId` and the quote records
// `linkedJobId` — the LIVE job↔quote link the #366 reconciliation engine reads
// (src/server/job-control/reconciliation-producer.ts loadScope).
async function createJobFromBoq(req, res, user, preview) {
  const body = req.body || {};
  const quoteId = body.quoteId ? String(body.quoteId) : '';

  let quoteDoc = null;
  if (quoteId) {
    quoteDoc = await readBlob(quoteStore.docKey(quoteId), null);
    if (!quoteDoc) return res.status(404).json({ error: 'quote not found' });
  }

  const name = String(body.name || (quoteDoc && quoteDoc.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });

  const data = await readBlob('jobs.json', { jobs: [] });
  const result = await createJob(data, {
    name,
    status: 'draft',
    ...(quoteId ? { fromQuoteId: quoteId } : {}),
  });
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
    ...(quoteId ? { quoteId } : {}),
    preview,
  });

  // The link's other half: the quote remembers the job it became. expectedRev-
  // guarded so a racing builder save is respected (the link write retries).
  if (quoteId) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await readBlob(quoteStore.docKey(quoteId), null);
      if (!current) break;
      const next = {
        ...quoteStore.toWire(current),
        linkedJobId: job.id,
        updatedAt: new Date().toISOString(),
      };
      try {
        await writeBlob(quoteStore.docKey(quoteId), next, {
          expectedRev: quoteStore.currentRevOf(current),
        });
        await quoteStore.upsertRegistryRow(next);
        break;
      } catch (e) {
        if (e && e.code === 'stale_write' && attempt < 3) continue;
        throw e;
      }
    }
  }

  // Audit through the canonical job.created builder (best-effort, after the
  // write — a journal failure never unwinds the job). source 'boq-import'
  // distinguishes this origin from the Builder + won-quote conversion.
  await appendAuditLog(
    buildJobCreatedEntry({ actor: user, job, source: 'boq-import', fromQuoteId: quoteId || null }),
  ).catch(() => {});

  return res.status(201).json({
    jobId: job.id,
    job: { id: job.id, name: job.name, status: job.status },
    ...(quoteId ? { quoteId } : {}),
    costBasis: {
      lines: preview.counts.lines,
      total: preview.totals.computed,
      reconciles: preview.totals.reconciles,
    },
  });
}

// Project a stored cost-import.json into the headline summary the hub card reads
// (totals + counts + provenance, not the full priced lines). Returns null for an
// absent/malformed record so the card renders nothing.
function summariseCostImport(raw) {
  if (!raw || !raw.preview || !raw.preview.totals) return null;
  const t = raw.preview.totals;
  const c = raw.preview.counts || {};
  return {
    source: raw.source || 'boq-import',
    importedAt: raw.importedAt || null,
    importedByName: raw.importedByName || null,
    fileName: raw.fileName || null,
    total: typeof t.computed === 'number' ? t.computed : 0,
    stated: typeof t.stated === 'number' ? t.stated : null,
    delta: typeof t.delta === 'number' ? t.delta : null,
    reconciles: typeof t.reconciles === 'boolean' ? t.reconciles : null,
    lines: typeof c.lines === 'number' ? c.lines : 0,
    sections: Array.isArray(raw.preview.sections) ? raw.preview.sections.length : 0,
  };
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

  if (req.method === 'GET') {
    // Quote review card: the stored workbook-import record + review counters.
    const quoteId = (req.query && req.query.quoteId) || '';
    if (quoteId) {
      const record = await readBlob(workbookImportKey(String(quoteId)), null);
      return res.status(200).json({
        workbookImport: record && record.current ? projectImportRecord(record) : null,
      });
    }
    // Job hub cost-basis card: what a BOQ import attached to the job (#365).
    const jobId = (req.query && req.query.jobId) || '';
    if (!jobId) return res.status(400).json({ error: 'jobId or quoteId required' });
    const raw = await readBlob(`jobs/${jobId}/cost-import.json`, null);
    return res.status(200).json({ costImport: summariseCostImport(raw) });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const action = (req.query && req.query.action) || '';

  // Review actions carry no workbook — route them before the decode.
  if (action === 'confirm-classification') return confirmClassification(req, res, user);
  if (action === 'resolve-finding') return resolveFinding(req, res, user);
  if (action === 'complete-review') return completeReview(req, res, user);

  // Decode + size/type-guard the workbook (preview / create-job / attach).
  const decoded = decodeWorkbook(req.body || {});
  if (decoded.error) return res.status(decoded.status).json({ error: decoded.error });

  // The quote-side import parses with the generic provenance/health parser.
  if (action === 'attach-to-quote') {
    return await attachWorkbookToQuote(req, res, user, decoded.buf);
  }

  // Parse once (Sansara-shaped). A workbook that won't parse never becomes a
  // preview OR a job.
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
