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
const { forwardStrayEmail } = require('./forward');
const { sendEmail } = require('../email');
const { readTimesheetRecipients } = require('../timesheet-email-settings');

function webhookDeps() {
  return {
    isFlagOn,
    getDb,
    store,
    ingest: ingestReceivedEmail,
    resend,
    storePdf: storeInvoicePdf,
    sha256: sha256Hex,
    forward: async ({ emailId, address, env }) => forwardStrayEmail({
      emailId, address,
      deps: { resend, apiKey: env.RESEND_API_KEY, sendEmail, recipients: await readTimesheetRecipients(), from: env.INBOUND_FORWARD_FROM || env.EMAIL_FROM || null },
    }),
    processOne: async ({ sql, tenant, invoiceId }) => {
      let autoConfirm = { enabled: false, capCents: 0, graceHours: 12, lookbackDays: 90 };
      try {
        const s = await getSettings('invoice_capture');
        autoConfirm = { enabled: s.autoConfirm === true, capCents: Math.round(Number(s.autoConfirmCapDollars) * 100), graceHours: Number(s.autoConfirmGraceHours), lookbackDays: Number(s.autoConfirmLookbackDays) };
      } catch { /* defaults */ }
      await store.claimOne(sql, tenant.id, invoiceId);
      return processInvoice({
        sql, tenantId: tenant.id, invoiceId, trigger: 'webhook',
        deps: {
          store, fetchPdf: fetchInvoicePdf, extractText: extractPdfText,
          readJobs: async () => { const d = await readBlob('jobs.json', { jobs: [] }); return Array.isArray(d.jobs) ? d.jobs : []; },
          aiExtract: aiExtract.enabled() ? aiExtract.aiExtract : null,
          autoConfirm,
        },
      });
    },
  };
}

module.exports = { webhookDeps };
