'use strict';

// Pure audit-log payload builders for job-creating actions (#581).
//
// A money-relevant, job-creating action — the Job Builder creating a job, or
// converting a won quote into a live job — left NO entry in the canonical audit
// journal (api/_lib/audit-log.js), so "who created this job, and where did it
// come from" had no durable trail. These builders shape the `append` payload;
// the handlers call appendAuditLog(builder(...)).catch(() => {}) AFTER the job
// write, so a journal failure never blocks the creation.
//
// Privacy: who/when, the job id + name + status, the source, and the originating
// quote id — never a dollar amount (the quote/job records hold the money).

/**
 * Build the audit-log payload for a job creation. `source` distinguishes the
 * Job Builder POST ('builder'), a won-quote conversion ('quote_convert'), a
 * BOQ workbook import ('boq-import', #365), the flag-gated Phil field
 * create ('phil' — "+ New job" on /phil/jobs, phil_sharpened W2b), and the
 * daily ServiceM8 auto-create ('servicem8_sync', api/_lib/servicem8-sync.js).
 * @param {{ actor: {id:string, username?:string, role?:string},
 *           job: {id:string, name?:string, status?:string},
 *           source: 'builder'|'quote_convert'|'boq-import'|'phil'|'servicem8_sync', fromQuoteId?: string|null }} input
 */
function buildJobCreatedEntry({ actor, job, source, fromQuoteId }) {
  const jobId = (job && job.id) || '';
  const name = (job && job.name) || jobId;
  return {
    action: 'job.created',
    actorId: (actor && actor.id) || '',
    actorName: (actor && actor.username) || '',
    actorRole: (actor && actor.role) || null,
    jobId: jobId || null,
    targetType: 'job',
    targetId: jobId,
    summary: `${(actor && actor.username) || 'someone'} created job ${name}${source === 'quote_convert' ? ' from a won quote' : ''}`.slice(0, 240),
    metadata: {
      source: source || 'builder',
      name: (job && job.name) || null,
      status: (job && job.status) || null,
      ...(fromQuoteId ? { fromQuoteId: String(fromQuoteId) } : {}),
    },
  };
}

/**
 * Build the audit-log payload for a quote→job conversion. The target is the
 * QUOTE (its lifecycle event), but `jobId` is the NEW job so the entry also
 * surfaces in that job's per-job activity feed.
 * @param {{ actor: object, quote: {id:string, name?:string}, jobId: string }} input
 */
function buildQuoteConvertedEntry({ actor, quote, jobId }) {
  const quoteId = (quote && quote.id) || '';
  const quoteName = (quote && quote.name) || quoteId;
  return {
    action: 'quote.converted',
    actorId: (actor && actor.id) || '',
    actorName: (actor && actor.username) || '',
    actorRole: (actor && actor.role) || null,
    jobId: jobId || null,
    targetType: 'quote',
    targetId: quoteId,
    summary: `${(actor && actor.username) || 'someone'} converted quote ${quoteName} to a job`.slice(0, 240),
    metadata: {
      jobId: jobId || null,
      quoteName: (quote && quote.name) || null,
    },
  };
}

module.exports = { buildJobCreatedEntry, buildQuoteConvertedEntry };
