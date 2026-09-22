'use strict';

// The Resend `email.received` webhook for supplier invoices — transport-
// agnostic core. The Next route handler (src/app/api/inbound/invoices/route.ts)
// hands in the RAW body + headers and returns whatever this decides; tests
// call it directly with a signed fixture.
//
// Order of checks (fail closed at every step; the response never explains
// which step failed beyond a stable code):
//   1. signature  — RESEND_INBOUND_WEBHOOK_SECRET unset → 503; invalid → 401
//   2. shape      — not email.received → 200 { ignored } (verified, irrelevant)
//   3. replay     — one row per svix id; a repeat → 200 { replay }
//   4. address    — recipient must be invoices+<token>@… → else 200 { ignored }
//   5. flag       — invoice_capture OFF → 200 { quarantined }: the receipt row
//                   (email id only) is kept, NOTHING is fetched, nothing lost;
//                   the sweep re-ingests it once the flag is on
//   6. ingest     — download PDFs, create rows (bounded); extraction is left to
//                   the sweep / inbox so the provider gets a fast 200
//
// Logs carry only counts and stable codes — never addresses, subjects, secrets
// or content.

const { verifySvixSignature, parseReceivedEvent, matchInboundAddress } = require('./resend-inbound');
const { withTimeout } = require('../with-timeout');

const INGEST_BUDGET_MS = 20_000;
const INLINE_PROCESS_BUDGET_MS = 25_000;

function inboundExpected(env) {
  return { token: env.INVOICE_INBOUND_TOKEN, localPart: env.INVOICE_INBOUND_LOCAL_PART || 'invoices', domain: env.INVOICE_INBOUND_DOMAIN || null };
}

/**
 * @param {{ rawBody: string, headers: Record<string, string|undefined>, env?: Record<string, string|undefined>,
 *           deps: { isFlagOn: Function, getDb: Function, store: any, ingest: Function, resend: any, storePdf: Function, sha256: Function, nowSec?: number } }} input
 * @returns {Promise<{ status: number, body: object }>}
 */
async function handleInboundWebhook({ rawBody, headers, env = process.env, deps }) {
  const secret = env.RESEND_INBOUND_WEBHOOK_SECRET;
  if (!secret) return { status: 503, body: { error: 'inbound_unconfigured' } };
  const sig = verifySvixSignature({ secret, headers, rawBody, nowSec: deps.nowSec });
  if (!sig.ok) return { status: 401, body: { error: 'invalid_signature' } };

  let json;
  try { json = JSON.parse(rawBody); } catch { return { status: 400, body: { error: 'invalid_json' } }; }
  const event = parseReceivedEvent(json);
  if (!event) return { status: 200, body: { ignored: true } };

  let sql;
  let tenant;
  try {
    sql = deps.getDb({ mode: 'write' });
    tenant = await deps.store.resolveTenant(sql);
  } catch {
    // The store is the durable receipt; without it we must NOT ack (Resend retries).
    return { status: 503, body: { error: 'store_unavailable' } };
  }
  if (!tenant) return { status: 503, body: { error: 'store_unprovisioned' } };

  const toMatched = matchInboundAddress([...event.to, ...event.receivedFor], inboundExpected(env));
  const flagOn = toMatched ? await deps.isFlagOn('invoice_capture') : false;
  const status = !toMatched ? 'ignored' : !flagOn ? 'quarantined' : 'received';

  const receipt = await deps.store.recordInboundEvent(sql, {
    svixId: sig.id,
    tenantId: tenant.id,
    emailId: event.emailId,
    toMatched,
    from: event.from,
    subject: event.subject,
    attachmentCount: event.attachments.length,
    status,
  });
  if (!receipt.inserted) return { status: 200, body: { replay: true } };
  if (status === 'ignored') return { status: 200, body: { ignored: true } };
  if (status === 'quarantined') return { status: 200, body: { quarantined: true } };

  try {
    const result = await withTimeout(
      deps.ingest({ sql, tenant, emailId: event.emailId, deps: { store: deps.store, resend: deps.resend, storePdf: deps.storePdf, sha256: deps.sha256, apiKey: env.RESEND_API_KEY } }),
      INGEST_BUDGET_MS,
      'inbound ingest',
    );
    await deps.store.finishInboundEvent(sql, sig.id, { status: 'processed' });
    // The common case is one invoice per email: read it now (bounded) so the
    // office sees it matched within seconds instead of on the next sweep.
    // Best-effort — a timeout leaves it `received` for the sweep.
    let processedInline = false;
    if (result.created.length === 1 && typeof deps.processOne === 'function') {
      try {
        await withTimeout(deps.processOne({ sql, tenant, invoiceId: result.created[0] }), INLINE_PROCESS_BUDGET_MS, 'inline processing');
        processedInline = true;
      } catch {
        // stays received; the sweep / inbox picks it up
      }
    }
    console.log('[invoices] inbound ingested', { created: result.created.length, skipped: result.skipped.length, reviewItem: !!result.reviewItem, processedInline });
    return { status: 200, body: { received: true, created: result.created.length, skipped: result.skipped.length, reviewItem: !!result.reviewItem, processedInline } };
  } catch (e) {
    // The receipt row stays `received` with processed_at null → the sweep re-ingests.
    const code = String((e && e.code) || 'ingest_failed').slice(0, 40);
    console.error('[invoices] inbound ingest deferred', { code });
    return { status: 200, body: { received: true, deferred: true } };
  }
}

module.exports = { handleInboundWebhook, INGEST_BUDGET_MS, INLINE_PROCESS_BUDGET_MS };
