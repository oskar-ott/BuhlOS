// Test & tag + calibration compliance — THE shared computation (#305).
//
// One implementation feeds three consumers so the numbers can never
// disagree: GET /api/tags-expiring (my-day card + the admin gear register),
// the daily threshold-alert cron in api/notifications.js, and Phil's gear
// flags. AS/NZS 3760 compliance must not depend on someone opening a page.
//
// Pure — callers load the blobs; this module only computes.

// Parse "dd/mm/yyyy" (canonical tag storage) → ms at local midnight.
// "yyyy-mm-dd" accepted as a defensive fallback. NaN when unparseable.
function parseDdmmyyyy(str) {
  if (!str) return NaN;
  const s = String(str).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]).getTime();
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  return NaN;
}

function toIsoDay(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function midnight(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const DAY_MS = 24 * 60 * 60 * 1000;

// (expiringTagRows — the per-job Test & Tag register scan — was deleted with
// the job-page rebuild teardown. This module now serves the asset-register
// calibration loop only; the shared threshold engine below is unchanged.)

/**
 * Expiring/expired instrument CALIBRATION rows from the asset register
 * (assets carry an optional ISO `calibrationDue`). Archived assets skipped.
 * Row: { kind:'calibration', key, assetId, assetName, identifier,
 *        holderId, holderName, calibrationDue, daysToExpiry, status }
 *
 * `holderName` is NOT stored on asset records (api/assets.js joins it from
 * users.json at response time) — pass opts.nameById ({ userId → name }) to
 * resolve it; falls back to an enriched record's own currentHolderName.
 */
function expiringCalibrationRows(assets, opts = {}) {
  const withinDays = Math.max(1, Math.min(365, Number(opts.withinDays) || 14));
  const todayMs = midnight(opts.now || new Date());
  const cutoffMs = todayMs + withinDays * DAY_MS;
  const nameById = opts.nameById || {};
  const rows = [];
  for (const a of assets || []) {
    if (!a || a.archived || !a.calibrationDue) continue;
    const ms = parseDdmmyyyy(a.calibrationDue);
    if (!Number.isFinite(ms) || ms > cutoffMs) continue;
    const daysToExpiry = Math.round((ms - todayMs) / DAY_MS);
    rows.push({
      kind: 'calibration',
      key: 'cal:' + a.id,
      assetId: a.id,
      assetName: a.name || a.id,
      identifier: a.identifier || null,
      holderId: a.currentHolderId || null,
      holderName: (a.currentHolderId && nameById[a.currentHolderId]) || a.currentHolderName || null,
      calibrationDue: a.calibrationDue,
      daysToExpiry,
      status: daysToExpiry < 0 ? 'expired' : 'expiring',
    });
  }
  return sortExpiredFirst(rows);
}

/** Expired first (oldest first), then earliest upcoming — the house sort. */
function sortExpiredFirst(rows) {
  return rows.sort((a, b) => a.daysToExpiry - b.daysToExpiry);
}

/**
 * Alert thresholds: which band a row is in. Crossing INTO a band (vs the
 * recorded state) is what triggers a push — same band twice stays silent,
 * so a tag can alert at most three times ever (14d, 7d, expired).
 */
function thresholdFor(daysToExpiry) {
  if (daysToExpiry < 0) return 'expired';
  if (daysToExpiry <= 7) return 't7';
  if (daysToExpiry <= 14) return 't14';
  return null;
}

/**
 * Dedupe: given current rows and the persisted alert state
 * ({ [key]: { threshold, notifiedAt } }), return the rows that newly
 * crossed a threshold plus the next state to persist. Rows that left the
 * window are pruned from state so a re-test resets the lifecycle.
 */
function newCrossings(rows, state, now) {
  const nowIso = new Date(now || Date.now()).toISOString();
  const prev = state && typeof state === 'object' ? state : {};
  const next = {};
  const crossed = [];
  for (const row of rows) {
    const threshold = thresholdFor(row.daysToExpiry);
    if (!threshold) continue;
    next[row.key] = { threshold, notifiedAt: (prev[row.key] || {}).notifiedAt || null };
    if ((prev[row.key] || {}).threshold !== threshold) {
      crossed.push({ ...row, threshold });
      next[row.key].notifiedAt = nowIso;
    }
  }
  return { crossed, nextState: next };
}

module.exports = {
  parseDdmmyyyy,
  toIsoDay,
  expiringCalibrationRows,
  thresholdFor,
  newCrossings,
};
