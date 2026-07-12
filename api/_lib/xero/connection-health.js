// Connection-health read model (#247) — the ONE projection admin surfaces
// render. Strict allow-list of safe fields: token columns, envelopes and
// secrets can never leak because they are never picked. P7/P8: every state is
// honest (not_configured ≠ disconnected ≠ degraded), and reconnect_required
// says what to do next.

const STATES = [
  'not_configured',    // XERO_* env incomplete in this environment
  'disconnected',      // configured, no connection row (never connected, or disconnected)
  'connecting',        // authorised, organisation selection pending
  'connected',
  'degraded',          // transient refresh/API failure — retryable
  'refresh_failed',
  'reconnect_required',// grant revoked/expired — human must reconnect
];

const ROW_STATUS_TO_STATE = {
  pending_selection: 'connecting',
  connected: 'connected',
  degraded: 'degraded',
  refresh_failed: 'refresh_failed',
  reconnect_required: 'reconnect_required',
};

/**
 * Derive the health payload a route may return to an admin browser.
 * @param {{ configured: boolean, configReport?: object, row?: object|null }} input
 */
function deriveConnectionHealth({ configured, configReport, row }) {
  if (!configured) {
    return {
      state: 'not_configured',
      // presence booleans only — which env pieces are missing, never values
      config: configReport || null,
    };
  }
  if (!row) {
    return { state: 'disconnected', config: null };
  }
  return {
    state: ROW_STATUS_TO_STATE[row.status] || 'degraded',
    organisationName: row.external_tenant_name || null,
    externalTenantId: row.external_tenant_id || null,
    grantedScopes: row.granted_scopes || null,
    connectedAt: row.connected_at || null,
    lastSuccessAt: row.last_success_at || null,
    lastRefreshAttemptAt: row.last_refresh_attempt_at || null,
    lastRefreshSuccessAt: row.last_refresh_success_at || null,
    errorCategory: row.last_error_category || null,
    config: null,
  };
}

module.exports = { STATES, deriveConnectionHealth };
