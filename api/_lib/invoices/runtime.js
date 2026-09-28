'use strict';

// Real-world wiring for the inbound webhook (the only piece the Next route
// needs). Kept separate from webhook.js so the core stays dependency-free and
// unit-testable with fixtures.

const { isFlagOn } = require('../feature-flags');
const { getDb } = require('../supabase-db');
const store = require('./store');
const { ingestReceivedEmail } = require('./ingest');
const resend = require('./resend-inbound');
const { storeInvoicePdf, fetchInvoicePdf, sha256Hex } = require('./document-store');
const { processInvoice } = require('./pipeline');
const { extractPdfText } = require('./pdf-text');
const { readBlob } = require('../blob');
const { getSettings } = require('../feature-settings');
const aiExtract = require('./ai-extract');
const { jobsFromEntry } = require('./purchaser');
const { readEntry } = require('../time-entries');
const { forwardStrayEmail } = require('./forward');
const { sendEmail } = require('../email');
const { readInvoiceRecipients } = require('./recipients');
const { createRateLimiter } = require('../rate-limit');

// Task H: burst limiters live at MODULE scope (a limiter created inside
// webhookDeps() would reset on every request). One per (window, max) so a
// knob change simply starts a fresh window. In-memory = per warm instance =
// a soft ceiling, never a cluster-wide lockout (api/_lib/rate-limit.js).
const burstLimiters = new Map();
function burstLimiterFor(windowMs, max) {
  const k = `${windowMs}:${max}`;
  if (!burstLimiters.has(k)) burstLimiters.set(k, createRateLimiter({ windowMs, max }));
  return burstLimiters.get(k);
}
/** The owner's inbound burst setting → { limiter, key } or null when off (max 0). */
async function inboundBurst() {
  let s;
  try { s = await getSettings('invoice_capture'); } catch { return null; }
  const max = Math.floor(Number(s.inboundBurstMax) || 0);
  if (max <= 0) return null;
  const minutes = Math.max(1, Math.floor(Number(s.inboundBurstWindowMinutes) || 5));
  return { limiter: burstLimiterFor(minutes * 60_000, max), key: 'inbound:invoices' };
}

function webhookDeps() {
  return {
    burst: inboundBurst,
    isFlagOn,
    getDb,
    store,
    ingest: ingestReceivedEmail,
    resend,
    storePdf: storeInvoicePdf,
    sha256: sha256Hex,
    forward: async ({ emailId, address, env }) => forwardStrayEmail({
      emailId, address,
      deps: { resend, apiKey: env.RESEND_API_KEY, sendEmail, recipients: await readInvoiceRecipients(), from: env.INBOUND_FORWARD_FROM || env.EMAIL_FROM || null },
    }),
    processOne: async ({ sql, tenant, invoiceId }) => {
      let autoConfirm = { enabled: false, capCents: 0, graceHours: 12, lookbackDays: 90, allowInferred: false, allowReceipts: false };
      try {
        const s = await getSettings('invoice_capture');
        autoConfirm = { enabled: s.autoConfirm === true, capCents: Math.round(Number(s.autoConfirmCapDollars) * 100), graceHours: Number(s.autoConfirmGraceHours), lookbackDays: Number(s.autoConfirmLookbackDays), allowInferred: s.autoConfirmInferred === true, allowReceipts: s.autoConfirmReceipts === true };
      } catch { /* defaults */ }
      await store.claimOne(sql, tenant.id, invoiceId);
      return processInvoice({
        sql, tenantId: tenant.id, invoiceId, trigger: 'webhook',
        deps: {
          store, fetchPdf: fetchInvoicePdf, extractText: extractPdfText,
          readJobs: async () => { const d = await readBlob('jobs.json', { jobs: [] }); return Array.isArray(d.jobs) ? d.jobs : []; },
          readUsers: async () => { const d = await readBlob('users.json', { users: [] }); return Array.isArray(d.users) ? d.users : []; },
          workerJobsOn: async (userId, date) => jobsFromEntry(await readEntry(userId, date)),
          aiExtract: aiExtract.enabled() ? aiExtract.aiExtract : null,
          autoConfirm,
        },
      });
    },
  };
}

module.exports = { webhookDeps };
