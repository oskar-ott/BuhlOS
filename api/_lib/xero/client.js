// The shared server-only Xero client (#247) — the ONE seam every Xero API
// call goes through (payroll-boundary ADR: no ad hoc Xero fetches in feature
// code). Handles: token freshness + refresh, atomic rotation via the store's
// refresh_version CAS (persist-BEFORE-use), tenant header, timeouts, 401/429
// classification with ONE bounded retry each, correlation-id capture,
// typed errors, and connection-health timestamps.
//
// Refresh algorithm (integration-credential-storage-adr.md):
//   read row → decrypt → still valid? use it
//   → else refresh at Xero → encrypt → CAS-persist (version + 1) → use it
//   → CAS lost? re-read and use the WINNER's tokens (never overwrite; never
//     re-call Xero — the loser's rotated token pair is simply discarded,
//     inside Xero's old-token grace window)
//   → invalid_grant? mark reconnect_required (terminal until a human
//     reconnects) — never silent
//
// Plaintext tokens exist only inside these call frames — never logged,
// never returned to route handlers (routes get results, not tokens).

const store = require('./token-store');
const oauth = require('./oauth');
const { XeroError, categoryForStatus } = require('./errors');
const { xeroConfigured } = require('./config');

const REQUEST_TIMEOUT_MS = 10_000;
const EXPIRY_SKEW_MS = 60_000; // refresh a minute early — clock skew + flight time
const RETRY_AFTER_MAX_WAIT_S = 5; // wait-and-retry only for short 429s

function accessTokenValid(row) {
  if (!row.access_token_expires_at) return false;
  const exp = new Date(row.access_token_expires_at).getTime();
  return Number.isFinite(exp) && exp - EXPIRY_SKEW_MS > Date.now();
}

/**
 * A usable access token + the selected organisation, refreshing if needed.
 * @returns {Promise<{ accessToken: string, externalTenantId: string|null, connectionId: string }>}
 */
async function getAccessContext(deps = {}) {
  if (!xeroConfigured(deps.env || process.env)) throw new XeroError('not_configured');
  const s = deps.store || store;
  const row = await s.getConnection({ sql: deps.sql });
  if (!row) throw new XeroError('not_connected');
  if (row.status === 'reconnect_required') throw new XeroError('reconnect_required');

  // forceRefresh (the 401-retry path) skips the freshness fast-path: the row
  // says the token is valid but Xero just rejected it, so rotate.
  if (!deps.forceRefresh && accessTokenValid(row)) {
    const { accessToken } = s.decryptTokens(row, deps.env);
    return { accessToken, externalTenantId: row.external_tenant_id, connectionId: row.id };
  }

  // Refresh path. Decrypt failure = unusable credentials → reconnect.
  let refreshToken;
  try {
    ({ refreshToken } = s.decryptTokens(row, deps.env));
  } catch {
    await s.markFailure({ id: row.id, status: 'reconnect_required', errorCategory: 'decrypt_failed', sql: deps.sql })
      .catch(() => {});
    throw new XeroError('reconnect_required', { detail: 'decrypt_failed' });
  }

  let tokens;
  try {
    tokens = await oauth.refreshTokens(refreshToken, { env: deps.env, fetchImpl: deps.fetchImpl });
  } catch (err) {
    const category = err instanceof XeroError ? err.category : 'unexpected';
    if (category === 'reconnect_required') {
      await s.markFailure({ id: row.id, status: 'reconnect_required', errorCategory: category, sql: deps.sql })
        .catch(() => {});
      throw err;
    }
    // Transient — the row is degraded, not dead. Distinguishable from revoked.
    await s.markFailure({ id: row.id, status: 'degraded', errorCategory: category, sql: deps.sql })
      .catch(() => {});
    throw err instanceof XeroError ? err : new XeroError('unexpected', { detail: 'token_refresh' });
  }

  // Persist BEFORE use — a used-but-unpersisted rotation bricks the grant. A
  // DB failure here is NOT a successful refresh: typed persistence error, and
  // the row's next read self-heals inside Xero's old-token grace window.
  let updated;
  try {
    updated = await s.rotateTokens({
      id: row.id,
      expectedVersion: row.refresh_version,
      tokens,
      sql: deps.sql,
      env: deps.env,
    });
  } catch {
    throw new XeroError('persistence', { detail: 'token_rotation' });
  }
  if (updated) {
    return { accessToken: tokens.accessToken, externalTenantId: updated.external_tenant_id, connectionId: updated.id };
  }

  // CAS lost — another instance rotated first. Use the winner's row.
  const winner = await s.getConnection({ sql: deps.sql });
  if (winner && winner.status !== 'reconnect_required' && accessTokenValid(winner)) {
    const { accessToken } = s.decryptTokens(winner, deps.env);
    return { accessToken, externalTenantId: winner.external_tenant_id, connectionId: winner.id };
  }
  throw new XeroError(winner && winner.status === 'reconnect_required' ? 'reconnect_required' : 'server', {
    detail: 'refresh_cas_lost',
  });
}

async function rawFetch(url, { method = 'GET', accessToken, tenantId, body, fetchImpl }) {
  try {
    return await (fetchImpl || fetch)(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...(body != null ? { 'Content-Type': 'application/json' } : {}),
        ...(tenantId ? { 'Xero-tenant-id': tenantId } : {}),
      },
      ...(body != null ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new XeroError(timedOut ? 'timeout' : 'network', { detail: 'api_request' });
  }
}

function correlationIdOf(res) {
  return res.headers && typeof res.headers.get === 'function'
    ? res.headers.get('xero-correlation-id')
    : null;
}

/**
 * One authenticated Xero API request with the connection-milestone safety
 * behaviours: auto-refresh, ONE 401→refresh→retry, ONE short-429 wait+retry,
 * timeout, typed errors, correlation id, last_success_at touch.
 *
 * @param {string} url absolute Xero API URL
 * @param {{ method?: string, body?: object, tenanted?: boolean, deps?: object }} [opts]
 *   `body` (any JSON-serialisable value) is sent as an application/json request
 *   body — used by the timesheet push (#249). Absent = no body, unchanged GET behaviour.
 * @returns {Promise<{ data: any, correlationId: string|null }>}
 */
async function xeroFetch(url, opts = {}) {
  const deps = opts.deps || {};
  const s = deps.store || store;
  let ctx = await getAccessContext(deps);
  const tenantId = opts.tenanted === false ? null : ctx.externalTenantId;

  let res = await rawFetch(url, {
    method: opts.method,
    accessToken: ctx.accessToken,
    tenantId,
    body: opts.body,
    fetchImpl: deps.fetchImpl,
  });

  if (res.status === 401) {
    // One forced refresh + retry: the access token may have been revoked or
    // expired under skew. getAccessContext refreshes because the row's expiry
    // is stale relative to a 401 — force by marking the attempt.
    ctx = await getAccessContext({ ...deps, forceRefresh: true });
    res = await rawFetch(url, {
      method: opts.method,
      accessToken: ctx.accessToken,
      tenantId,
      body: opts.body,
      fetchImpl: deps.fetchImpl,
    });
  }

  if (res.status === 429) {
    const retryAfter = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : NaN);
    if (Number.isFinite(retryAfter) && retryAfter <= RETRY_AFTER_MAX_WAIT_S) {
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      res = await rawFetch(url, {
        method: opts.method,
        accessToken: ctx.accessToken,
        tenantId,
        body: opts.body,
        fetchImpl: deps.fetchImpl,
      });
    }
    if (res.status === 429) {
      throw new XeroError('rate_limit', {
        status: 429,
        correlationId: correlationIdOf(res),
        retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null,
        detail: 'api_request',
      });
    }
  }

  const correlationId = correlationIdOf(res);
  if (!res.ok) {
    // For 400s, surface Xero's element-level ValidationErrors MESSAGES (and
    // nothing else from the body — they are operator-safe field sentences like
    // "Timesheet line date is not within the period"). Without them a
    // rejection is an unactionable black box: the first #249 proving run
    // stalled on `validation (api_request)` with the real reason discarded.
    let detail = 'api_request';
    if (res.status === 400) {
      try {
        const body = await res.json();
        const messages = [];
        const walk = (node) => {
          if (!node || typeof node !== 'object' || messages.length >= 5) return;
          if (Array.isArray(node)) return node.forEach(walk);
          if (Array.isArray(node.ValidationErrors)) {
            for (const v of node.ValidationErrors) {
              if (v && typeof v.Message === 'string' && messages.length < 5) messages.push(v.Message);
            }
          }
          for (const k of Object.keys(node)) walk(node[k]);
        };
        walk(body);
        if (typeof body?.Message === 'string' && !messages.length) messages.push(body.Message);
        if (messages.length) detail = messages.join(' | ').slice(0, 400);
      } catch {
        // body unreadable → keep the generic detail
      }
    }
    throw new XeroError(categoryForStatus(res.status), {
      status: res.status,
      correlationId,
      detail,
    });
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new XeroError('unexpected', { correlationId, detail: 'api_response_body' });
  }

  await s.touchSuccess({ id: ctx.connectionId, sql: deps.sql }).catch(() => {});
  return { data, correlationId };
}

module.exports = {
  getAccessContext,
  xeroFetch,
  EXPIRY_SKEW_MS,
};
