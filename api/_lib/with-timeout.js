// Shared timeout race for the Supabase dual-write mirrors (#152).
//
// Both the hours mirror (in-request, awaited inside writeEntry) and the
// task-status PG-as-source write (in-request, awaited inside task-toggle
// BEFORE the Blob write-through) bound their PG work with this so a slow /
// unreachable pooler can never hang a field hot path — a timeout is swallowed
// like any other mirror error (Blob is authoritative).
//
// MIRROR_TIMEOUT_MS is deliberately ABOVE supabase-db.js's connect_timeout of
// 10s (POOL_OPTIONS.connect_timeout): a COLD pooler connect can take the full
// 10s, so a budget at/below that would abort every cold connect before it could
// complete, guaranteeing the mirror fails on the first flag-on request after an
// idle period. 12s leaves the cold connect room to finish while still bounding
// the worst-case user-facing delay. Keep these two in lockstep: if
// connect_timeout changes, this must stay strictly greater.
const MIRROR_TIMEOUT_MS = 12000;

// Race a promise against a timeout. On timeout the underlying query is left to
// settle on its own (best-effort), but the caller is unblocked. The timer is
// unref'd + cleared so it never keeps the process alive.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { withTimeout, MIRROR_TIMEOUT_MS };
