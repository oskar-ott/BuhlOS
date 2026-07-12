// /api/xero/reference (#610) — the read-only reference-data cache surface.
//   GET                → cache summary (per-group counts, last sync, staleness,
//                        whether the grant has the reference read scopes)
//   GET ?kind=<kind>   → the cached items of one kind (allow-listed fields)
//   POST {action:'refresh', groups?} → fetch from Xero + replace the cache;
//                        per-group outcomes, never a whole-batch false success
//
// Admin-only, xero_connection flag-gated (reference data rides the connection
// flag — it is read-only; the future write path #249 gets its own gate).
// Nothing here writes to Xero: every upstream call is a GET via the shared
// client. Failures render as loud per-group errors with the previous cache
// intact — never an empty list that reads as "the org has no employees".

const { requireAuth } = require('../_lib/auth');
const { isFlagEnabled } = require('../_lib/feature-flags');
const audit = require('../_lib/audit-log');
const { xeroConfigured, hasReferenceReadScopes } = require('../_lib/xero/config');
const store = require('../_lib/xero/token-store');
const refSync = require('../_lib/xero/reference-sync');
const { XeroError } = require('../_lib/xero/errors');

const FLAG = 'xero_connection';

const VALID_KINDS = new Set(Object.values(refSync.GROUP_KINDS).flat());

function xeroErrorStatus(err) {
  if (!(err instanceof XeroError)) return 500;
  if (err.category === 'not_connected' || err.category === 'pending_selection') return 409;
  if (err.category === 'not_configured') return 503;
  return 502;
}

module.exports = async function handler(req, res) {
  const user = await requireAuth(req, res, { roles: ['admin'] });
  if (!user) return;
  if (!(await isFlagEnabled(FLAG, user))) return res.status(404).json({ error: 'not found' });
  if (!xeroConfigured()) return res.status(503).json({ error: 'xero not configured' });

  if (req.method === 'GET') {
    const kind = req.query && typeof req.query.kind === 'string' ? req.query.kind : null;
    try {
      res.setHeader('Cache-Control', 'no-store');
      if (kind) {
        if (!VALID_KINDS.has(kind)) return res.status(400).json({ error: 'unknown kind' });
        const items = await refSync.getReferenceItems(kind);
        return res.status(200).json({ kind, items });
      }
      const summary = await refSync.getReferenceSummary();
      const row = await store.getConnection();
      return res.status(200).json({
        ...summary,
        // A pre-#610 connection lacks the read scopes — the panel says
        // "reconnect to grant payroll read access" instead of failing 403s.
        scopesOk: hasReferenceReadScopes(row ? row.granted_scopes : ''),
        organisationName: row ? row.external_tenant_name : null,
      });
    } catch (err) {
      const category = err instanceof XeroError ? err.category : 'unexpected';
      return res.status(xeroErrorStatus(err)).json({ error: 'reference cache unavailable', errorCategory: category });
    }
  }

  if (req.method === 'POST') {
    const action = req.body && req.body.action;
    if (action !== 'refresh') return res.status(400).json({ error: 'unknown action' });
    const groups = Array.isArray(req.body.groups)
      ? req.body.groups.filter((g) => refSync.SYNC_GROUPS.includes(g))
      : undefined;

    let results;
    try {
      results = await refSync.syncReferenceData({ groups, actor: user });
    } catch (err) {
      // A throw here means the sync could not START (no connection / org
      // pending) — per-group failures come back as results, not throws.
      const category = err instanceof XeroError ? err.category : 'unexpected';
      return res.status(xeroErrorStatus(err)).json({ error: 'refresh could not start', errorCategory: category });
    }

    const failed = results.filter((r) => r.status === 'failed');
    await audit.append({
      action: 'xero.reference_synced',
      actorId: user.id,
      actorName: user.name || user.username || '',
      actorRole: user.role,
      targetType: 'integration',
      targetId: 'xero',
      summary: failed.length
        ? `Xero reference refresh: ${results.length - failed.length}/${results.length} groups ok (${failed.map((f) => `${f.group}: ${f.errorCategory}`).join(', ')})`
        : `Xero reference refresh: all ${results.length} groups ok`,
      metadata: { results },
    }).catch(() => {});

    let summary = null;
    try {
      summary = await refSync.getReferenceSummary();
    } catch {
      summary = null; // results still carry the honest outcome
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: failed.length === 0, results, summary });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method not allowed' });
};
