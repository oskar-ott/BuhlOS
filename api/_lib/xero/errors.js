// Typed Xero errors (#247) — the ONE error vocabulary every Xero exchange
// speaks. Feature code and UI never see raw fetch/SDK errors; the shared
// client (./client.js) classifies every failure into one of these categories
// so the health surface, audit trail and sync-log (#251, later) can render
// operator-honest states without parsing prose.
//
// Redaction rule: messages carry the CATEGORY and safe context (status code,
// correlation id) only — never tokens, authorization codes, client secrets or
// raw Xero response bodies.

const CATEGORIES = new Set([
  'not_configured',      // XERO_* env missing — connect cannot start
  'not_connected',       // no integration_connections row
  'pending_selection',   // authorised, organisation not yet chosen
  'reconnect_required',  // refresh token revoked/expired (invalid_grant)
  'auth',                // 401 after a fresh refresh — unexpected
  'forbidden',           // 403 — scope/permission
  'not_found',           // 404
  'conflict',            // 409
  'rate_limit',          // 429 (retry-after captured)
  'timeout',             // request timed out
  'network',             // socket/dns failure
  'validation',          // 400 Xero validation
  'server',              // 5xx transient
  'persistence',         // our own DB write failed mid-exchange
  'unexpected',          // anything else — never guessed into a softer bucket
]);

class XeroError extends Error {
  /**
   * @param {string} category one of CATEGORIES
   * @param {{ status?: number, correlationId?: string|null, retryAfterSeconds?: number|null, detail?: string }} [info]
   *   `detail` must already be safe (no secrets) — it is for operator context
   *   like 'token_exchange' or 'connections_read', not response bodies.
   */
  constructor(category, info = {}) {
    const cat = CATEGORIES.has(category) ? category : 'unexpected';
    super(`xero: ${cat}${info.detail ? ` (${info.detail})` : ''}`);
    this.name = 'XeroError';
    this.category = cat;
    this.status = info.status == null ? null : info.status;
    this.correlationId = info.correlationId == null ? null : info.correlationId;
    this.retryAfterSeconds = info.retryAfterSeconds == null ? null : info.retryAfterSeconds;
    this.retryable = ['rate_limit', 'timeout', 'network', 'server'].includes(cat);
  }
}

/** Classify an HTTP status from Xero into a category. */
function categoryForStatus(status) {
  if (status === 400) return 'validation';
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'unexpected';
}

module.exports = { XeroError, categoryForStatus, CATEGORIES };
