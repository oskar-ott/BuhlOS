'use strict';

// Real-world wiring for the inbound webhook (the only piece the Next route
// needs). Kept separate from webhook.js so the core stays dependency-free and
// unit-testable with fixtures.

const { isFlagOn } = require('../feature-flags');
const { getDb } = require('../supabase-db');
const store = require('./store');
const { ingestReceivedEmail } = require('./ingest');
const resend = require('./resend-inbound');
const { storeInvoicePdf, sha256Hex } = require('./document-store');

function webhookDeps() {
  return {
    isFlagOn,
    getDb,
    store,
    ingest: ingestReceivedEmail,
    resend,
    storePdf: storeInvoicePdf,
    sha256: sha256Hex,
  };
}

module.exports = { webhookDeps };
