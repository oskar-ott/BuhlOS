// /api/xero-sync-log (#251, M5 #890) — read / acknowledge / retry for the
// Xero sync-health panel.
//
//   GET                          → { items, counts, lastSuccessAt }   (open working set)
//   GET  ?month=YYYY-MM          → { entries }                        (terminal history)
//   POST {action:'acknowledge', operation, note}  → close with a REQUIRED note
//   POST {action:'retry',       operation}        → re-run via the registered handler
//   POST {action:'retry_all'}                     → sequential; pauses on rate limit
//
// Admin-only (retry writes to Xero); rides the `xero_connection` flag →
// 404 dark like every Xero surface. Connection health itself comes from
// /api/xero/status — this endpoint owns only the outcome store.
//
// Requiring the BRIDGE here is load-bearing: retry handlers register at its
// module load, and each serverless function is its own process — without
// this require the registry would be empty in this function.

const { setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');
const { isFlagEnabled } = require('./_lib/feature-flags');
const audit = require('./_lib/audit-log');
const syncLog = require('./_lib/xero-sync-log');
require('./_lib/xero/sync-log-bridge');
const { readBlob } = require('./_lib/blob');
const { XeroError } = require('./_lib/xero/errors');

const MONTH_RE = /^\d{4}-\d{2}$/;

function auditSync(user, action, operation, summary, metadata) {
  return audit
    .append({
      action,
      actorId: user.id,
      actorName: user.name || user.username || '',
      actorRole: user.role,
      targetType: 'xero_sync_item',
      targetId: String(operation),
      summary,
      metadata,
    })
    .catch(() => {});
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res, { roles: ['admin'] });
  if (!user) return;
  if (!(await isFlagEnabled('xero_connection', user))) return res.status(404).json({ error: 'not found' });

  try {
    if (req.method === 'GET') {
      const month = (req.query && req.query.month) || '';
      if (month) {
        if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
        const doc = await readBlob(syncLog.monthKey(`${month}-01T00:00:00Z`), { entries: [] });
        return res.status(200).json({ entries: Array.isArray(doc.entries) ? doc.entries : [] });
      }
      const state = await syncLog.openState();
      return res.status(200).json(state);
    }

    if (req.method === 'POST') {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const action = body.action;

      if (action === 'acknowledge') {
        const operation = String(body.operation || '');
        if (!operation) return res.status(400).json({ error: 'operation required' });
        const note = String(body.note || '').trim();
        if (!note) return res.status(400).json({ error: 'a note is required to acknowledge a sync failure' });
        const out = await syncLog.acknowledge(operation, { by: user.username || user.id, note });
        if (!out.acknowledged) return res.status(404).json({ error: 'not an open item' });
        await auditSync(user, 'xero.sync_acknowledged', operation, `Acknowledged Xero sync failure ${operation}`, { note });
        return res.status(200).json(out);
      }

      if (action === 'retry') {
        const operation = String(body.operation || '');
        if (!operation) return res.status(400).json({ error: 'operation required' });
        const out = await syncLog.retry(operation);
        if (!out.retried) return res.status(404).json({ error: 'not an open item' });
        await auditSync(user, 'xero.sync_retried', operation, `Retried Xero sync ${operation} → ${out.outcome}`, { outcome: out.outcome });
        return res.status(200).json(out);
      }

      if (action === 'retry_all') {
        // Sequential through the shared client; a rate limit pauses the run
        // honestly instead of hammering on (#251 AC).
        const state = await syncLog.openState();
        const outcomes = [];
        let pausedOnRateLimit = false;
        for (const item of state.items) {
          try {
            const out = await syncLog.retry(item.operation);
            outcomes.push({ operation: item.operation, ...out });
          } catch (e) {
            outcomes.push({ operation: item.operation, retried: false, error: e.message });
            if (e instanceof XeroError && e.category === 'rate_limit') {
              pausedOnRateLimit = true;
              break;
            }
          }
        }
        await auditSync(user, 'xero.sync_retried', 'retry_all',
          `Retried ${outcomes.length} open Xero sync items${pausedOnRateLimit ? ' (paused on rate limit)' : ''}`,
          { count: outcomes.length, pausedOnRateLimit });
        return res.status(200).json({ outcomes, pausedOnRateLimit });
      }

      return res.status(400).json({ error: 'unknown action' });
    }

    return res.status(405).end();
  } catch (e) {
    console.error('xero-sync-log:', e);
    return res.status(500).json({ error: e.message || 'sync-log failed' });
  }
};
