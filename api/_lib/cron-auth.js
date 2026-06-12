// Shared cron-trigger authorisation (#381) — ONE implementation for every
// cron-gated endpoint (notification fan-outs, cash-watch, users sweep,
// payroll reminder, backup snapshot).
//
// FAIL-CLOSED IN PRODUCTION: with CRON_SECRET unset and
// VERCEL_ENV === 'production', the state is 'unconfigured' — handlers
// return 503 and log loudly, so a missing/rotated-out env var degrades to
// "crons fail visibly", never "anyone can fire pushes at the whole crew".
// Preview/dev without a secret stays permissive — explicitly, for local
// poking and PR previews, not by accident.
//
// Both header forms are accepted: `authorization: Bearer <secret>` (what
// Vercel Cron sends automatically when CRON_SECRET is set) and the manual
// `x-cron-secret`. The secret value itself never reaches logs or bodies.

/** @returns {'ok'|'denied'|'unconfigured'} */
function cronAuthState(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return process.env.VERCEL_ENV === 'production' ? 'unconfigured' : 'ok';
  }
  const headers = (req && req.headers) || {};
  if ((headers['authorization'] || '') === `Bearer ${expected}`) return 'ok';
  if ((headers['x-cron-secret'] || '') === expected) return 'ok';
  return 'denied';
}

/**
 * Gate + respond in one move. True when the caller may proceed; otherwise
 * the response has already been written (503 unconfigured / 401 denied).
 */
function requireCron(req, res) {
  const state = cronAuthState(req);
  if (state === 'ok') return true;
  if (state === 'unconfigured') {
    console.error('cron auth unconfigured: CRON_SECRET is not set in production — cron trigger refused');
    res.status(503).json({ error: 'cron auth unconfigured' });
    return false;
  }
  res.status(401).json({ error: 'unauthorised' });
  return false;
}

module.exports = { cronAuthState, requireCron };
