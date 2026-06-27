'use strict';

// Quote client-delivery lifecycle (#240, Epic 7). CJS so api/quotes.js AND
// api/quote-stats.js share one definition; the UI renders the derived state the
// GET returns.
//
// After a quote is sent the pipeline went dark. This tracks the CLIENT-facing
// lifecycle on the quote: sent (when/to whom/how) → viewed (manual today; an
// automatic channel is Epic 16) → accepted/declined. "sent" is distinct from
// the internal `submitted` status and repeatable per revision. Viewed is NEVER
// inferred — untracked reads "not tracked" (P7). Each acceptance/decline pins
// the revision it applies to (the quote IS the revision: its `version`).

/**
 * Derive the client-facing lifecycle state of a quote from its stored fields.
 * Pure. Terminal accept/decline (from status) outranks delivery events.
 * @returns {{ state: 'never_sent'|'sent'|'viewed'|'accepted'|'declined',
 *             lastSentAt: string|null, lastViewedAt: string|null,
 *             recipient: string|null, method: string|null, since: string|null }}
 */
function deriveDeliveryState(quote) {
  const q = quote || {};
  const d = q.delivery || {};
  const sent = Array.isArray(d.sentEvents) ? d.sentEvents : [];
  const viewed = Array.isArray(d.viewedEvents) ? d.viewedEvents : [];
  const lastSent = sent.length ? sent[sent.length - 1] : null;
  const lastViewed = viewed.length ? viewed[viewed.length - 1] : null;

  let state;
  let since = null;
  const status = String(q.status || '');
  if (status === 'accepted' || status === 'won' || status === 'converted_to_job') {
    state = 'accepted';
    since = (q.acceptance && q.acceptance.acceptedAt) || q.updatedAt || null;
  } else if (status === 'declined' || status === 'lost') {
    state = 'declined';
    since = q.updatedAt || null;
  } else if (lastViewed) {
    state = 'viewed';
    since = lastViewed.at || null;
  } else if (lastSent) {
    state = 'sent';
    since = lastSent.at || null;
  } else {
    state = 'never_sent';
  }

  return {
    state,
    lastSentAt: lastSent ? lastSent.at || null : null,
    lastViewedAt: lastViewed ? lastViewed.at || null : null,
    recipient: lastSent ? lastSent.recipient || null : null,
    method: lastSent ? lastSent.method || null : null,
    since,
  };
}

/** True when a quote is sent (or viewed) but not yet accepted/declined — the
 *  "waiting on the client" population pipeline follow-ups care about. Pure. */
function isAwaitingClient(quote) {
  const s = deriveDeliveryState(quote).state;
  return s === 'sent' || s === 'viewed';
}

const SEND_METHODS = ['email', 'portal', 'hand', 'post', 'other'];

/** Validate + normalise a markSent payload. Returns { ok, value } | { ok:false, error }. */
function validateSent(body) {
  const b = body || {};
  const at = String(b.at || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(at)) return { ok: false, error: 'at must be a YYYY-MM-DD date' };
  const recipient = String(b.recipient || '').trim();
  if (!recipient) return { ok: false, error: 'recipient required' };
  const method = SEND_METHODS.includes(b.method) ? b.method : 'email';
  return { ok: true, value: { at, recipient: recipient.slice(0, 160), method } };
}

/** Append a sent event to a quote (mutates a copy of delivery), returns delivery. */
function appendSent(quote, value, actor) {
  const d = (quote && quote.delivery) || {};
  const sentEvents = Array.isArray(d.sentEvents) ? d.sentEvents.slice() : [];
  sentEvents.push({
    at: value.at,
    recipient: value.recipient,
    method: value.method,
    by: (actor && actor.username) || '',
    recordedAt: new Date().toISOString(),
  });
  return { ...d, sentEvents, viewedEvents: Array.isArray(d.viewedEvents) ? d.viewedEvents : [] };
}

/** Append a (manual) viewed event. */
function appendViewed(quote, value, actor) {
  const d = (quote && quote.delivery) || {};
  const viewedEvents = Array.isArray(d.viewedEvents) ? d.viewedEvents.slice() : [];
  viewedEvents.push({
    at: value && value.at && /^\d{4}-\d{2}-\d{2}$/.test(value.at) ? value.at : new Date().toISOString().slice(0, 10),
    by: (actor && actor.username) || '',
    note: value && value.note ? String(value.note).slice(0, 240) : null,
    recordedAt: new Date().toISOString(),
  });
  return { ...d, sentEvents: Array.isArray(d.sentEvents) ? d.sentEvents : [], viewedEvents };
}

module.exports = {
  SEND_METHODS,
  deriveDeliveryState,
  isAwaitingClient,
  validateSent,
  appendSent,
  appendViewed,
};
