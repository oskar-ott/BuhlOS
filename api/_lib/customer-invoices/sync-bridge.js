'use strict';

// Customer stage invoices → the Xero sync log (#1150). Every send outcome is
// recorded as `invoice_export`, one operation per stage (`inv:<stage id>`), so
// a failed or unconfirmed send shows on the sync health panel with a Retry
// that can only travel the original code path (xero-send.retry — which looks
// the number up in Xero before it ever sends again).
//
// The retry handler is registered at LOAD; api/xero-sync-log.js requires this
// module so the registration exists in that function's process.

const syncLog = require('../xero-sync-log');
const { readBlob } = require('../blob');
const { getDb } = require('../supabase-db');
const store = require('./store');
const sendSvc = require('./xero-send');

const SYNC_TYPE = 'invoice_export';
const RETRY_ACTOR = { id: 'sync-log-retry', name: 'Sync health retry' };

const operationOf = (invoiceId) => `inv:${invoiceId}`;

function reasonOf(result) {
  const n = result.invoiceNumber || 'stage invoice';
  if (result.outcome === 'sent') return result.verified ? `${n} created as a draft and read back` : `${n} created as a draft; read-back differs (${(result.mismatches || []).join(', ')})`;
  if (result.outcome === 'adopted') return `${n} was already in Xero — taken over, nothing sent twice`;
  if (result.outcome === 'failed') return `${n} refused by Xero${result.detail ? `: ${result.detail}` : ''}`;
  if (result.outcome === 'unknown') return `${n}: no answer from Xero — it may or may not exist there`;
  return `${n}: ${result.outcome}`;
}

/**
 * Record one send / retry result. Returns a warning string when the recorder
 * write failed (the caller surfaces it — the send result is authoritative),
 * else null. `blocked` and `reset` reach Xero with nothing to record.
 */
async function recordSendOutcome({ invoiceId, result }) {
  if (!result || result.outcome === 'blocked' || result.outcome === 'reset') return null;
  const ok = result.outcome === 'sent' || result.outcome === 'adopted';
  try {
    await syncLog.record({
      syncType: SYNC_TYPE,
      operation: operationOf(invoiceId),
      recordRef: result.invoiceNumber || invoiceId,
      status: ok ? 'ok' : 'failed',
      reason: reasonOf(result),
      ...(ok ? {} : { category: result.category || 'unexpected' }),
    });
    return null;
  } catch (e) {
    console.error('customer-invoices sync-bridge: outcome not recorded', e);
    return `sync-log write failed (${e.message}) — the result above is authoritative; the health dashboard may lag`;
  }
}

syncLog.registerRetryHandler(SYNC_TYPE, async (item) => {
  const invoiceId = String(item.operation || '').replace(/^inv:/, '');
  const sql = getDb({ mode: 'write' });
  const tenant = await store.resolveTenant(sql);
  const invoice = tenant ? await store.getInvoice(sql, tenant.id, invoiceId) : null;
  if (!invoice) return { outcome: 'resolved_meanwhile', reason: 'the stage no longer exists' };
  if (invoice.state === 'sent') return { outcome: 'resolved_meanwhile', reason: `${invoice.invoiceNumber} is already in Xero` };
  if (invoice.state === 'planned' || invoice.state === 'cancelled') {
    return { outcome: 'resolved_meanwhile', reason: 'the stage was put back to planned or replaced' };
  }
  const data = await readBlob('jobs.json', { jobs: [] });
  const job = (Array.isArray(data.jobs) ? data.jobs : []).find((j) => j && j.id === invoice.jobId && j.deleted !== true && !j.deletedAt);
  if (!job) return { outcome: 'failed', reason: 'the job no longer exists', category: 'unexpected' };
  const result = await sendSvc.retry({ tenant, invoice, job, actor: RETRY_ACTOR, deps: { sql } });
  if (result.outcome === 'sent' || result.outcome === 'adopted') return { outcome: 'resolved', reason: reasonOf(result) };
  if (result.outcome === 'blocked') {
    return { outcome: 'failed', reason: `can't retry yet (${result.blockers.map((b) => b.code).join(', ')})`, category: 'unexpected' };
  }
  return { outcome: 'failed', reason: reasonOf(result), category: result.category || 'unexpected' };
});

module.exports = { SYNC_TYPE, operationOf, reasonOf, recordSendOutcome };
