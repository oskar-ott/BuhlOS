// Xero OAuth2 protocol pieces (#247): signed state, authorize URL, code
// exchange, refresh, revocation, connections read.
//
// State: HMAC-signed + expiring, via the SAME sign/verify primitives as the
// session cookie (api/_lib/auth.js signSession/verifySession — SESSION_SECRET,
// timing-safe compare, exp enforced). The state binds the INITIATING ADMIN
// (userId) and a purpose tag; the callback re-verifies both against the live
// session, so a state minted for one user cannot complete another's connect.
// There is NO user-supplied return destination — every browser-facing result
// redirects to the fixed settings surface (no open-redirect surface at all).
// Replay: authorization codes are single-use at Xero, states expire in 10
// minutes and only ever complete for the same signed-in admin.
//
// Every network call here goes through fetchImpl (injectable for tests),
// carries a timeout, and NEVER logs or re-throws raw response bodies —
// failures become typed XeroErrors (./errors.js).

const { signSession, verifySession } = require('../auth');
const { XeroError, categoryForStatus } = require('./errors');
const {
  AUTHORIZE_URL,
  TOKEN_URL,
  REVOCATION_URL,
  CONNECTIONS_URL,
  SCOPES,
  clientId,
  clientSecret,
  redirectUri,
} = require('./config');
const crypto = require('crypto');

const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_PURPOSE = 'xero_oauth';
const REQUEST_TIMEOUT_MS = 10_000;

/** Mint a signed, expiring OAuth state bound to the initiating admin. */
function makeState(userId) {
  return signSession({
    purpose: STATE_PURPOSE,
    userId: String(userId),
    nonce: crypto.randomBytes(16).toString('base64url'),
    exp: Date.now() + STATE_TTL_MS,
  });
}

/**
 * Verify a callback state for this user. Returns the payload or null —
 * expired, tampered, wrong-purpose and wrong-user states all fail closed.
 */
function verifyState(state, userId) {
  const payload = verifySession(state); // HMAC + exp, timing-safe
  if (!payload) return null;
  if (payload.purpose !== STATE_PURPOSE) return null;
  if (String(payload.userId) !== String(userId)) return null;
  return payload;
}

/** The Xero authorization URL the browser is redirected to. */
function authorizeUrl(state, env = process.env) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId(env),
    redirect_uri: redirectUri(env),
    scope: SCOPES,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

function basicAuth(env) {
  return 'Basic ' + Buffer.from(`${clientId(env)}:${clientSecret(env)}`).toString('base64');
}

async function formPost(url, body, { env = process.env, fetchImpl = fetch, detail } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(env),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new XeroError(timedOut ? 'timeout' : 'network', { detail });
  }
  return res;
}

/**
 * Parse an identity-endpoint error response WITHOUT ever exposing the body.
 * invalid_grant is the one distinguished value (revoked/expired refresh token
 * → reconnect_required); everything else classifies by status.
 */
async function identityError(res, detail) {
  let code = '';
  try {
    const data = await res.json();
    code = data && typeof data.error === 'string' ? data.error : '';
  } catch {
    // unparseable body — classify by status alone
  }
  if (code === 'invalid_grant') return new XeroError('reconnect_required', { status: res.status, detail });
  return new XeroError(categoryForStatus(res.status), { status: res.status, detail });
}

function parseTokenResponse(data, detail) {
  const accessToken = data && typeof data.access_token === 'string' ? data.access_token : '';
  const refreshToken = data && typeof data.refresh_token === 'string' ? data.refresh_token : '';
  const expiresIn = data && Number.isFinite(data.expires_in) ? Number(data.expires_in) : NaN;
  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn)) {
    throw new XeroError('unexpected', { detail: `${detail}_shape` });
  }
  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    scope: data && typeof data.scope === 'string' ? data.scope : SCOPES,
  };
}

/** Exchange an authorization code for tokens. */
async function exchangeCode(code, opts = {}) {
  const env = opts.env || process.env;
  const res = await formPost(TOKEN_URL, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(env),
  }, { env, fetchImpl: opts.fetchImpl, detail: 'token_exchange' });
  if (!res.ok) throw await identityError(res, 'token_exchange');
  let data;
  try {
    data = await res.json();
  } catch {
    throw new XeroError('unexpected', { detail: 'token_exchange_body' });
  }
  return parseTokenResponse(data, 'token_exchange');
}

/** Refresh with a rotating refresh token. invalid_grant → reconnect_required. */
async function refreshTokens(refreshToken, opts = {}) {
  const env = opts.env || process.env;
  const res = await formPost(TOKEN_URL, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }, { env, fetchImpl: opts.fetchImpl, detail: 'token_refresh' });
  if (!res.ok) throw await identityError(res, 'token_refresh');
  let data;
  try {
    data = await res.json();
  } catch {
    throw new XeroError('unexpected', { detail: 'token_refresh_body' });
  }
  return parseTokenResponse(data, 'token_refresh');
}

/**
 * Revoke the grant (RFC 7009 — revoking the refresh token kills the whole
 * grant). Best-effort by contract: a revocation failure must not block the
 * local disconnect, so callers decide what to do with a thrown error.
 */
async function revokeRefreshToken(refreshToken, opts = {}) {
  const env = opts.env || process.env;
  const res = await formPost(REVOCATION_URL, { token: refreshToken },
    { env, fetchImpl: opts.fetchImpl, detail: 'revocation' });
  if (!res.ok) throw new XeroError(categoryForStatus(res.status), { status: res.status, detail: 'revocation' });
}

/**
 * List the organisations this grant can reach (GET /connections — the
 * "harmless read": tenant ids/names only, no business data, no extra scope).
 */
async function listConnections(accessToken, opts = {}) {
  let res;
  try {
    res = await (opts.fetchImpl || fetch)(CONNECTIONS_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new XeroError(timedOut ? 'timeout' : 'network', { detail: 'connections_read' });
  }
  const correlationId = res.headers && typeof res.headers.get === 'function'
    ? res.headers.get('xero-correlation-id')
    : null;
  if (!res.ok) {
    throw new XeroError(categoryForStatus(res.status), {
      status: res.status, correlationId, detail: 'connections_read',
    });
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new XeroError('unexpected', { correlationId, detail: 'connections_read_body' });
  }
  if (!Array.isArray(data)) throw new XeroError('unexpected', { correlationId, detail: 'connections_read_shape' });
  return data
    .filter((c) => c && c.tenantType === 'ORGANISATION' && typeof c.tenantId === 'string')
    .map((c) => ({
      tenantId: c.tenantId,
      tenantName: typeof c.tenantName === 'string' ? c.tenantName : '(unnamed organisation)',
    }));
}

module.exports = {
  STATE_TTL_MS,
  makeState,
  verifyState,
  authorizeUrl,
  exchangeCode,
  refreshTokens,
  revokeRefreshToken,
  listConnections,
};
