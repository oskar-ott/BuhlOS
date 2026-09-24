'use strict';

// The processing pipeline for ONE captured document. Deps are injected so the
// whole decision path is unit-testable without Blob, pdf.js or Postgres:
//
//   deps.store           the PG store (api/_lib/invoices/store.js shape)
//   deps.fetchPdf(url)   → Buffer            (document-store.fetchInvoicePdf)
//   deps.extractText(b)  → { text, pageCount, hasTextLayer }
//   deps.readJobs()      → jobs.json rows    (the IV lookup source)
//   deps.aiExtract?      → optional structured-AI rung (api/_lib/invoices/ai-extract.js)
//
// Order of evidence: the PDF's own text layer → (optional, opt-in) AI over
// that text for still-missing money/number/date fields → manual entry. AI is
// NEVER consulted for the IV job match: matching uses only tokens printed on
// the document, exactly, and a human confirms every allocation anyway.
//
// A failure never loses the document: the row stays with its PDF, the attempt
// is journalled with a stable failure code, and the sweep retries with backoff
// up to MAX_ATTEMPTS before parking it as `failed` (retryable from the inbox).

const { extractInvoiceFromText } = require('./extract');
const { buildJobCodeIndex, matchJobByIv, nearMissJobs } = require('./iv-match');
const { normaliseSupplierName } = require('./supplier-identity');
const { decideDuplicate, normaliseInvoiceNumber } = require('./dedupe');
const { reconcileTotals } = require('./money');
const { ALLOCATABLE_TYPES, NON_INVOICE_TYPES } = require('./state');
const { evaluateAutoConfirm, autoConfirmDeadline } = require('./auto-confirm');
const { withTimeout } = require('../with-timeout');
const { extractStatementLines, reconcileStatement } = require('./statement');
const { extractLineItems } = require('./lines');
const { inferPlacement } = require('./placement');
const { categorise, descriptionKey, isCategory } = require('./categories');

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 40_000;
const BACKOFF_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

/** Decide match + review reasons from an extraction. Pure; exported for tests. */
function decideMatch(extracted, jobs) {
  const index = buildJobCodeIndex(jobs);
  const reasons = [];
  let matchStatus = 'none';
  let matchedJob = null;
  let matchReason = null;
  const sel = extracted.ivSelection;

  if (sel.outcome === 'multi_reference') {
    matchStatus = 'multi_reference';
    reasons.push('multi_reference');
    matchReason = { distinct: sel.distinct, source: sel.source, matchCount: 0, field: 'jobs.json code' };
  } else if (sel.outcome === 'selected') {
    const m = matchJobByIv(sel.normalised, index);
    matchReason = {
      raw: sel.raw, normalised: sel.normalised, label: sel.label, source: sel.source, line: sel.line,
      field: 'jobs.json code', matchCount: m.matchCount, warnings: m.warnings,
    };
    if (m.status === 'exact') {
      matchStatus = 'exact';
      matchedJob = m.job;
      matchReason.jobName = m.job.name || null;
      matchReason.jobStatus = m.job.status || 'active';
    } else if (m.status === 'ambiguous') {
      matchStatus = 'ambiguous';
      reasons.push('iv_ambiguous');
      matchReason.jobIds = m.jobs.map((j) => j.id);
    } else {
      matchStatus = 'not_found';
      reasons.push('iv_not_found');
      // one typo away — offered to the reviewer, never matched automatically
      matchReason.suggestions = nearMissJobs(sel.normalised, index).slice(0, 3).map((j) => ({ id: j.id, name: j.name || j.id, code: j.code, status: j.status || 'active' }));
    }
  } else {
    // No IV number printed (a boutique supplier): place it from the evidence
    // the document does print — delivery address, job name, job ref — and
    // say which (owner direction 2026-09-24). Two candidates = ambiguity,
    // offered to the reviewer, never guessed.
    const placed = inferPlacement({ text: extracted.placementText || extracted.excerpt || '', deliveryAddress: extracted.deliveryAddress || null, references: extracted.customerReferences || [] }, jobs);
    if (placed.outcome === 'placed') {
      matchStatus = 'inferred';
      matchedJob = placed.job;
      matchReason = {
        source: 'evidence', strength: placed.strength, field: 'site address / job name',
        evidence: placed.evidence.map((e) => ({ kind: e.kind, detail: e.detail })),
        deliveryAddress: extracted.deliveryAddress || null, matchCount: 1, warnings: [],
        jobName: placed.job.name || null, jobStatus: placed.job.status || 'active',
        candidates: placed.candidates,
      };
      if ((placed.job.status || 'active') !== 'active') matchReason.warnings.push(`the job is ${placed.job.status}`);
    } else {
      reasons.push('no_iv_reference');
      if (placed.outcome === 'ambiguous') {
        matchReason = { source: 'evidence', field: 'site address / job name', matchCount: placed.candidates.length, warnings: [], candidates: placed.candidates,
          suggestions: placed.candidates.slice(0, 3).map((c) => ({ id: c.id, name: c.name, code: c.code, status: c.status })) };
      }
    }
  }

  if (extracted.documentType === 'unknown') reasons.push('unknown_document_type');
  else if (!ALLOCATABLE_TYPES.has(extracted.documentType)) reasons.push('not_allocatable');
  if (extracted.subtotalCents == null) reasons.push('missing_subtotal');
  if (extracted.totalsConsistent === false) reasons.push('totals_inconsistent');
  if (extracted.negativeAmounts && extracted.documentType !== 'credit_note') reasons.push('negative_amounts');

  return { matchStatus, matchedJob, matchReason, reasons, collisions: index.collisions };
}

function backoffAt(attemptCount) {
  const ms = BACKOFF_MS[Math.min(BACKOFF_MS.length, Math.max(1, attemptCount)) - 1];
  return new Date(Date.now() + ms).toISOString();
}

/**
 * Process one invoice that the caller has ALREADY claimed (status processing,
 * attempt_count bumped). Never throws; returns { ok, status, code }.
 */
async function processInvoice({ sql, tenantId, invoiceId, trigger, deps }) {
  const { store } = deps;
  const attempt = await store.startAttempt(sql, tenantId, invoiceId, trigger);
  const current = await store.getInvoiceRow(sql, tenantId, invoiceId);
  if (!current) return { ok: false, code: 'not_found' };

  const fail = async (code, { retryable = true } = {}) => {
    await store.finishAttempt(sql, attempt.id, { outcome: 'failed', failureCode: code });
    const exhausted = current.attemptCount >= store.MAX_ATTEMPTS || !retryable;
    await store.setStatus(sql, tenantId, invoiceId, exhausted ? 'failed' : 'received', {
      failureCode: code,
      nextAttemptAt: exhausted ? null : backoffAt(current.attemptCount),
    });
    await store.insertEvent(sql, tenantId, invoiceId, { event: exhausted ? 'failed' : 'attempt_failed', detail: { code, attempt: attempt.attemptNo } });
    return { ok: false, status: exhausted ? 'failed' : 'received', code };
  };

  try {
    const doc = await store.getDocumentWithBlob(sql, tenantId, invoiceId, null);
    if (!doc) return await fail('no_document', { retryable: false });

    // A photo or scan: nothing to read — straight to a person, image intact.
    if (doc.kind === 'image') {
      await store.applyExtraction(sql, tenantId, invoiceId, {
        status: 'needs_review', reviewReasons: ['image_only'], extractionMethod: 'none', matchStatus: 'none',
        fields: {}, ivCandidates: [], excerpt: null,
      });
      await store.finishAttempt(sql, attempt.id, { outcome: 'ok', extractionMethod: 'none' });
      await store.insertEvent(sql, tenantId, invoiceId, { event: 'review_required', detail: { reasons: ['image_only'] } });
      return { ok: true, status: 'needs_review' };
    }

    const run = async () => {
      const bytes = await deps.fetchPdf(doc.blobUrl, MAX_PDF_BYTES);
      const textResult = await deps.extractText(bytes);
      await store.updateDocumentText(sql, tenantId, doc.id, { pageCount: textResult.pageCount, hasTextLayer: textResult.hasTextLayer });

      if (!textResult.hasTextLayer) {
        await store.applyExtraction(sql, tenantId, invoiceId, {
          status: 'needs_review', reviewReasons: ['no_text_layer'], extractionMethod: 'none', matchStatus: 'none',
          fields: {}, ivCandidates: [], excerpt: null,
        });
        await store.finishAttempt(sql, attempt.id, { outcome: 'ok', extractionMethod: 'none' });
        await store.insertEvent(sql, tenantId, invoiceId, { event: 'review_required', detail: { reasons: ['no_text_layer'] } });
        return { ok: true, status: 'needs_review' };
      }

      let extracted = extractInvoiceFromText(textResult.text);
      let method = 'pdf_text';
      // Line items (owner pull 2026-09-24): every printed line with its
      // quantity, unit price and total, checked against the printed subtotal.
      const textLines = String(textResult.text).split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim().length > 0);
      let lineItems = ALLOCATABLE_TYPES.has(extracted.documentType)
        ? extractLineItems(textLines, { subtotalCents: extracted.subtotalCents, totalCents: extracted.totalCents })
        : { lines: [], totalCents: 0, consistent: null, reason: 'not_applicable' };
      let lineSource = 'rule';
      let aiLineCategories = {};
      if (deps.aiExtract && (needsAi(extracted) || (ALLOCATABLE_TYPES.has(extracted.documentType) && lineItems.consistent !== true))) {
        try {
          const ai = await deps.aiExtract(textResult.text, extracted);
          if (ai) {
            extracted = mergeAi(extracted, ai);
            method = 'pdf_text+ai';
            const aiLines = Array.isArray(ai.lines) ? ai.lines : [];
            if (aiLines.length) {
              const aiTotal = aiLines.reduce((s, l) => s + (l.lineTotalCents || 0), 0);
              const sub = extracted.subtotalCents;
              const aiConsistent = sub != null && Math.abs(aiTotal - sub) <= Math.max(5, aiLines.length, Math.round(Math.abs(sub) * 0.005));
              // The model's lines replace the rules' only when they add up and the rules' did not.
              if (aiConsistent && lineItems.consistent !== true) {
                lineItems = { lines: aiLines.map((l, i) => ({ lineNo: i + 1, description: l.description, quantity: l.quantity, unit: l.unit, unitPriceCents: l.unitPriceCents, lineTotalCents: l.lineTotalCents, confidence: 'medium' })), totalCents: aiTotal, consistent: true, reason: null };
                lineSource = 'ai';
              }
              for (const l of aiLines) if (l.category && isCategory(l.category)) aiLineCategories[descriptionKey(l.description)] = l.category;
            }
          }
        } catch {
          // AI is an optional rung; its failure never fails the document.
        }
      }

      const supplierKey = normaliseSupplierName(extracted.supplierName);
      // File every line: a remembered decision for this supplier (or any) wins,
      // then the keyword rules, then the model's suggestion for what the rules
      // could not place.
      const keys = lineItems.lines.map((l) => descriptionKey(l.description));
      const learned = lineItems.lines.length ? await store.learnedCategories(sql, tenantId, supplierKey, keys) : {};
      const filedLines = lineItems.lines.map((l, i) => {
        const key = keys[i];
        const rule = categorise(l.description);
        let category = rule.category;
        let categorySource = lineSource === 'ai' ? 'ai' : 'rule';
        if (key && learned[key]) { category = learned[key]; categorySource = 'learned'; }
        else if (rule.category === 'other' && key && aiLineCategories[key]) { category = aiLineCategories[key]; categorySource = 'ai'; }
        return { ...l, descriptionKey: key || 'unknown', category, categorySource };
      });
      await store.replaceInvoiceLines(sql, tenantId, invoiceId, filedLines);
      // The supplier + number rule applies to allocatable documents only: a
      // STATEMENT lists invoice numbers it is not a duplicate of.
      const numberForDedupe = ALLOCATABLE_TYPES.has(extracted.documentType) ? extracted.supplierInvoiceNumber : null;
      const [byChecksum, bySupplierNumber] = await Promise.all([
        store.findInvoicesByChecksum(sql, tenantId, doc.sha256, invoiceId),
        supplierKey && numberForDedupe
          ? store.findInvoicesBySupplierNumber(sql, tenantId, supplierKey, normaliseInvoiceNumber(numberForDedupe), invoiceId)
          : Promise.resolve([]),
      ]);
      const dup = decideDuplicate({
        sha256: doc.sha256, supplierKey, supplierInvoiceNumber: numberForDedupe, byChecksum, bySupplierNumber,
      });

      const jobs = await deps.readJobs();
      const decision = decideMatch(extracted, jobs);
      const matchedJobUuid = decision.matchedJob ? await store.resolveJobUuid(sql, tenantId, decision.matchedJob.id) : null;

      // A statement is the supplier's list of what we owe: compare it with what
      // was captured so the invoice that never arrived is caught here, not when
      // the supplier chases it (docs/invoice-capture.md "Statement check").
      let statementCheck = null;
      if (extracted.documentType === 'statement' && supplierKey && !dup.duplicate) {
        const captured = await store.listSupplierInvoices(sql, tenantId, supplierKey, invoiceId);
        statementCheck = reconcileStatement(extractStatementLines(textResult.text), captured);
        if (statementCheck.missing.length) decision.reasons.push('statement_missing_invoices');
      }
      const matchReason = statementCheck ? { ...(decision.matchReason || {}), statement: statementCheck } : decision.matchReason;

      // Paperwork that is never a cost is set aside automatically (visible under
      // Excluded, restorable) — the review queue is for decisions, not dockets.
      const setAside = !dup.duplicate && NON_INVOICE_TYPES.has(extracted.documentType);
      const status = dup.duplicate ? 'duplicate' : setAside ? 'excluded' : decision.reasons.length === 0 && (decision.matchStatus === 'exact' || decision.matchStatus === 'inferred') ? 'matched' : 'needs_review';
      await store.applyExtraction(sql, tenantId, invoiceId, {
        excludedReason: setAside ? `not_an_invoice:${extracted.documentType}` : null,
        supplierName: extracted.supplierName,
        supplierKey,
        supplierAbn: extracted.supplierAbn,
        supplierInvoiceNumber: extracted.supplierInvoiceNumber,
        documentType: extracted.documentType,
        invoiceDate: extracted.invoiceDate,
        currency: extracted.currency,
        subtotalCents: extracted.subtotalCents,
        gstCents: extracted.gstCents,
        totalCents: extracted.totalCents,
        totalsConsistent: extracted.totalsConsistent,
        ivReferenceRaw: extracted.ivSelection.outcome === 'selected' ? extracted.ivSelection.raw : null,
        ivReference: extracted.ivSelection.outcome === 'selected' ? extracted.ivSelection.normalised : null,
        ivCandidates: extracted.ivCandidates,
        matchedJobId: decision.matchedJob ? decision.matchedJob.id : null,
        matchedJobUuid,
        matchStatus: decision.matchStatus,
        matchReason,
        status,
        reviewReasons: decision.reasons,
        failureCode: null,
        extractionMethod: method,
        fields: extracted.fields,
        excerpt: extracted.excerpt,
        duplicateOfId: dup.duplicate ? dup.ofId : null,
        duplicateReason: dup.duplicate ? dup.reason : null,
        linesTotalCents: lineItems.lines.length ? lineItems.totalCents : null,
        linesConsistent: lineItems.consistent,
      });
      await store.finishAttempt(sql, attempt.id, { outcome: 'ok', extractionMethod: method });
      await store.insertEvent(sql, tenantId, invoiceId, { event: 'extracted', detail: { method, documentType: extracted.documentType, pageCount: textResult.pageCount } });
      if (lineItems.reason !== 'not_applicable') {
        await store.insertEvent(sql, tenantId, invoiceId, { event: 'lines_read', detail: { count: filedLines.length, consistent: lineItems.consistent, reason: lineItems.reason, source: lineSource, categories: filedLines.reduce((m, l) => { m[l.category] = (m[l.category] || 0) + 1; return m; }, {}) } });
      }
      if (dup.duplicate) {
        await store.insertEvent(sql, tenantId, invoiceId, { event: 'duplicate_detected', detail: { ofId: dup.ofId, reason: dup.reason } });
      } else if (setAside) {
        await store.insertEvent(sql, tenantId, invoiceId, { event: 'auto_excluded', detail: { documentType: extracted.documentType } });
      } else if (status === 'matched') {
        await store.insertEvent(sql, tenantId, invoiceId, { event: 'matched', detail: { jobId: decision.matchedJob.id, reason: decision.matchReason } });
        await scheduleAutoBooking({ sql, tenantId, invoiceId, store, settings: deps.autoConfirm, supplierKey, jobLegacyId: decision.matchedJob.id, jobStatus: decision.matchedJob.status || 'active' });
      } else {
        await store.insertEvent(sql, tenantId, invoiceId, { event: 'review_required', detail: { reasons: decision.reasons, matchStatus: decision.matchStatus } });
      }
      return { ok: true, status };
    };
    return await withTimeout(run(), PROCESS_TIMEOUT_MS, 'invoice processing');
  } catch (e) {
    const code = (e && e.code) || (/timed out/.test(String(e && e.message)) ? 'timeout' : 'extraction_failed');
    return fail(String(code).slice(0, 60));
  }
}

/**
 * Evaluate the automatic-booking rules for a freshly matched invoice and
 * record the verdict. With the knob OFF the verdict is still recorded
 * (review-only mode: the inbox says "would have booked") but no deadline is
 * set, so nothing ever books. Failures here never fail the document.
 */
async function scheduleAutoBooking({ sql, tenantId, invoiceId, store, settings, supplierKey, jobLegacyId, jobStatus }) {
  if (!settings) return;
  try {
    const inv = await store.getInvoiceRow(sql, tenantId, invoiceId);
    if (!inv || inv.status !== 'matched') return;
    const [humanCount, onJob, pref] = await Promise.all([
      store.supplierHumanConfirmedCount(sql, tenantId, supplierKey),
      store.supplierConfirmedOnJob(sql, tenantId, supplierKey, jobLegacyId),
      store.getSupplierPref(sql, tenantId, supplierKey),
    ]);
    const verdict = evaluateAutoConfirm(inv, {
      capCents: settings.capCents,
      lookbackDays: settings.lookbackDays,
      supplierHumanConfirmed: humanCount > 0,
      supplierAlwaysReview: pref.alwaysReview,
      supplierConfirmedOnJob: onJob,
      jobStatus,
      allowInferred: settings.allowInferred === true,
    });
    const at = verdict.eligible && settings.enabled ? autoConfirmDeadline(settings.graceHours) : null;
    await store.scheduleAutoConfirm(sql, tenantId, invoiceId, { eligible: verdict.eligible, checks: verdict.checks, at });
    await store.insertEvent(sql, tenantId, invoiceId, {
      event: verdict.eligible ? (at ? 'auto_confirm_scheduled' : 'auto_confirm_eligible') : 'auto_confirm_ineligible',
      detail: { at, failed: verdict.checks.filter((c) => !c.ok).map((c) => c.code) },
    });
  } catch (e) {
    console.error('[invoices] auto-booking evaluation failed', { code: (e && e.code) || 'error' });
  }
}

function needsAi(extracted) {
  return extracted.documentType === 'unknown' || extracted.supplierInvoiceNumber == null || extracted.invoiceDate == null
    || extracted.subtotalCents == null || extracted.totalCents == null || extracted.supplierName == null
    || (extracted.ivSelection && extracted.ivSelection.outcome === 'none' && !extracted.deliveryAddress);
}

/** Fill ONLY still-missing fields from the AI result (provenance 'ai'). Never touches the IV selection. Pure. */
function mergeAi(extracted, ai) {
  const out = { ...extracted, fields: { ...extracted.fields } };
  const take = (key, aiKey, transform) => {
    if (out[key] != null || ai[aiKey] == null) return;
    const value = transform ? transform(ai[aiKey]) : ai[aiKey];
    if (value == null) return;
    out[key] = value;
    out.fields[key === 'subtotalCents' ? 'subtotalCents' : key === 'gstCents' ? 'gstCents' : key === 'totalCents' ? 'totalCents' : key] =
      { value, confidence: ai.confidence && ai.confidence[aiKey] ? ai.confidence[aiKey] : 'medium', provenance: 'ai', label: null, line: null };
  };
  if (out.documentType === 'unknown' && ai.documentType && ai.documentType !== 'unknown') {
    out.documentType = ai.documentType;
    out.fields.documentType = { value: ai.documentType, confidence: 'medium', provenance: 'ai', label: null, line: null };
  }
  take('supplierName', 'supplierName');
  take('supplierInvoiceNumber', 'supplierInvoiceNumber');
  take('invoiceDate', 'invoiceDate');
  take('subtotalCents', 'subtotalCents');
  take('gstCents', 'gstCents');
  take('totalCents', 'totalCents');
  if (out.deliveryAddress == null && typeof ai.deliveryAddress === 'string' && ai.deliveryAddress.trim()) out.deliveryAddress = ai.deliveryAddress.trim().slice(0, 200);
  if (Array.isArray(ai.customerReferences) && ai.customerReferences.length) out.customerReferences = Array.from(new Set([...(out.customerReferences || []), ...ai.customerReferences])).slice(0, 8);
  const totals = reconcileTotals({ subtotalCents: out.subtotalCents, gstCents: out.gstCents, totalCents: out.totalCents });
  out.subtotalCents = totals.subtotalCents;
  out.gstCents = totals.gstCents;
  out.totalCents = totals.totalCents;
  out.totalsConsistent = totals.consistent;
  out.totalsDerived = totals.derived;
  return out;
}

module.exports = { processInvoice, decideMatch, mergeAi, needsAi, scheduleAutoBooking, MAX_PDF_BYTES, PROCESS_TIMEOUT_MS };
