// integration_connections store (#247) — the ONE module that reads/writes the
// encrypted Xero connection row (docs/architecture/integration-credential-
// storage-adr.md). Postgres via the guarded server-only client
// (api/_lib/supabase-db.js); tokens pass through api/_lib/secret-box.js and
// exist as plaintext only inside ./client.js call frames.
//
// Concurrency contract (the ADR's rotation lock):
//   * every token write is an optimistic CAS on refresh_version
//     (UPDATE ... WHERE id = $1 AND refresh_version = $2)
//   * zero rows updated = another instance rotated first — the caller
//     RE-READS and uses the winner's tokens, never retries the write
//   * reconnect REPLACES the row (delete + insert, one transaction) so stale
//     ciphertext is never revived
//
// Every function takes an optional `sql` (a postgres.js tagged-template) so
// unit tests inject a scripted fake and no test ever opens a socket.

const { getDb } = require('../supabase-db');
const secretBox = require('../secret-box');
const { PROVIDER } = require('./config');

const TENANT_SLUG = 'buhl'; // single-tenant today — same resolution as hours-mirror.js

const AAD_ACCESS = `integration:${PROVIDER}:access`;
const AAD_REFRESH = `integration:${PROVIDER}:refresh`;

function db(sql) {
  return sql || getDb({ mode: 'write' });
}

async function resolveTenantId(sql) {
  const t = await sql`select id from public.tenants where slug = ${TENANT_SLUG}`;
  if (!t.length) throw new Error('[xero token-store] tenant row missing');
  return t[0].id;
}

/** The (single) Xero connection row, or null. Never returns decrypted tokens. */
async function getConnection(opts = {}) {
  const sql = db(opts.sql);
  const tenantId = await resolveTenantId(sql);
  const rows = await sql`
    select * from public.integration_connections
    where tenant_id = ${tenantId} and provider = ${PROVIDER}
  `;
  return rows.length ? rows[0] : null;
}

function encryptTokens(tokens, env) {
  return {
    accessEnc: secretBox.seal(tokens.accessToken, { aad: AAD_ACCESS, env }),
    refreshEnc: secretBox.seal(tokens.refreshToken, { aad: AAD_REFRESH, env }),
  };
}

/** Decrypt a row's tokens. Throws SecretBoxError on tamper/key problems. */
function decryptTokens(row, env) {
  return {
    accessToken: secretBox.open(row.access_token_enc, { aad: AAD_ACCESS, env }),
    refreshToken: secretBox.open(row.refresh_token_enc, { aad: AAD_REFRESH, env }),
  };
}

/**
 * Fresh authorisation completed: REPLACE any existing row with a new one
 * holding the just-minted tokens (status pending_selection until an
 * organisation is confirmed). Delete + insert in one transaction — reconnect
 * never revives stale ciphertext.
 */
async function replaceConnection({ tokens, actor, sql, env } = {}) {
  const client = db(sql);
  const { accessEnc, refreshEnc } = encryptTokens(tokens, env);
  const tenantId = await resolveTenantId(client);
  const rows = await client.begin(async (tx) => {
    await tx`
      delete from public.integration_connections
      where tenant_id = ${tenantId} and provider = ${PROVIDER}
    `;
    return tx`
      insert into public.integration_connections (
        tenant_id, provider, status,
        access_token_enc, refresh_token_enc, access_token_expires_at,
        granted_scopes, connected_by_legacy_id, connected_by_name
      ) values (
        ${tenantId}, ${PROVIDER}, 'pending_selection',
        ${accessEnc}, ${refreshEnc}, ${tokens.expiresAt},
        ${tokens.scope}, ${actor ? String(actor.id) : null}, ${actor ? String(actor.name || actor.username || '') : null}
      )
      returning *
    `;
  });
  return rows[0];
}

/** Confirm the selected organisation → status connected. */
async function selectOrganisation({ id, externalTenantId, externalTenantName, sql } = {}) {
  const client = db(sql);
  const rows = await client`
    update public.integration_connections
    set external_tenant_id = ${externalTenantId},
        external_tenant_name = ${externalTenantName},
        status = 'connected',
        connected_at = now(),
        last_success_at = now(),
        last_error_category = null
    where id = ${id} and status = 'pending_selection'
    returning *
  `;
  return rows.length ? rows[0] : null;
}

/**
 * Persist rotated tokens via CAS. Returns the updated row, or null when the
 * CAS lost (another instance already rotated) — the caller must re-read.
 */
async function rotateTokens({ id, expectedVersion, tokens, sql, env } = {}) {
  const client = db(sql);
  const { accessEnc, refreshEnc } = encryptTokens(tokens, env);
  const rows = await client`
    update public.integration_connections
    set access_token_enc = ${accessEnc},
        refresh_token_enc = ${refreshEnc},
        access_token_expires_at = ${tokens.expiresAt},
        granted_scopes = ${tokens.scope},
        refresh_version = refresh_version + 1,
        last_refresh_attempt_at = now(),
        last_refresh_success_at = now(),
        last_success_at = now(),
        last_error_category = null,
        status = case when status in ('degraded','refresh_failed') then 'connected' else status end
    where id = ${id} and refresh_version = ${expectedVersion}
    returning *
  `;
  return rows.length ? rows[0] : null;
}

/**
 * Record a refresh/API failure. `status` moves the row to degraded /
 * refresh_failed / reconnect_required; connected/pending rows keep their
 * status when `status` is omitted (attempt timestamp + category only).
 */
async function markFailure({ id, status, errorCategory, sql } = {}) {
  const client = db(sql);
  const rows = await client`
    update public.integration_connections
    set last_refresh_attempt_at = now(),
        last_error_category = ${errorCategory || null},
        status = coalesce(${status || null}, status)
    where id = ${id}
    returning *
  `;
  return rows.length ? rows[0] : null;
}

/** A successful harmless API call — keep the health surface honest. */
async function touchSuccess({ id, sql } = {}) {
  const client = db(sql);
  await client`
    update public.integration_connections
    set last_success_at = now(),
        last_error_category = null,
        status = case when status = 'degraded' then 'connected' else status end
    where id = ${id}
  `;
}

/** Disconnect: hard-delete (ADR — dead ciphertext is a liability). */
async function deleteConnection({ id, sql } = {}) {
  const client = db(sql);
  await client`delete from public.integration_connections where id = ${id}`;
}

module.exports = {
  TENANT_SLUG,
  AAD_ACCESS,
  AAD_REFRESH,
  resolveTenantId,
  getConnection,
  decryptTokens,
  replaceConnection,
  selectOrganisation,
  rotateTokens,
  markFailure,
  touchSuccess,
  deleteConnection,
};
