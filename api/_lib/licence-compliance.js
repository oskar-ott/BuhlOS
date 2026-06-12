// Worker licence / ticket compliance (#331) — THE shared computation.
//
// One implementation feeds every consumer so the numbers can never disagree:
// GET /api/licences (register chips + drawer + Phil self-view) and the daily
// threshold-alert cron in api/notifications.js. Same philosophy as
// api/_lib/tag-compliance.js (#305) — current tickets are the licence to
// operate; compliance must not depend on someone opening a page.
//
// Pure — callers load the blobs; this module only computes.
//
// Differences from tag-compliance (deliberate, per the #331 audit):
//   - Dates are strict ISO (yyyy-mm-dd) — the NEW store never inherits the
//     legacy dd/mm/yyyy canon, and unparseable dates are rejected at WRITE
//     (api/licences.js), never silently dropped at read.
//   - Window default 60 days (humans need more renewal runway than gear);
//     alert bands 60d → 14d → expired.
//   - `expiryDate: null` is a real state ("doesn't expire") — never alerts.
//   - Renewals: two records of the same type on one worker → the one with
//     the LATEST expiry drives chips and alerting (an old expired ticket
//     superseded by its renewal must not nag anyone).

const DAY_MS = 24 * 60 * 60 * 1000;

/** Seeded type list (AC). `other` carries a free-text label on the record.
 *  Records store typeId + the label frozen at write, so renaming a type
 *  later never rewrites history. */
const LICENCE_TYPES = [
  { id: 'electrical', label: 'Electrical licence' },
  { id: 'white-card', label: 'White card' },
  { id: 'ewp', label: 'EWP' },
  { id: 'working-at-heights', label: 'Working at heights' },
  { id: 'first-aid', label: 'First aid' },
  { id: 'driver', label: 'Driver licence' },
  { id: 'other', label: 'Other' },
];

/** Strict ISO yyyy-mm-dd → ms at local midnight; NaN otherwise. */
function parseIsoDay(str) {
  if (!str) return NaN;
  const m = String(str).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return NaN;
  const ms = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  // Reject impossible dates (2026-02-31 rolls over in JS — round-trip check).
  const d = new Date(ms);
  if (d.getFullYear() !== +m[1] || d.getMonth() + 1 !== +m[2] || d.getDate() !== +m[3]) return NaN;
  return ms;
}

function midnight(now) {
  const d = new Date(now || Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Status for one record. Day-0 semantics match tag-compliance: expired when
 * days < 0 (i.e. expiry day itself is still "expiring"), expiring when
 * 0 ≤ days ≤ window.
 * → { status: 'current'|'expiring'|'expired'|'no-expiry', daysToExpiry|null }
 */
function licenceStatusFor(expiryDate, opts = {}) {
  if (!expiryDate) return { status: 'no-expiry', daysToExpiry: null };
  const withinDays = Math.max(1, Math.min(365, Number(opts.withinDays) || 60));
  const ms = parseIsoDay(expiryDate);
  if (!Number.isFinite(ms)) return { status: 'no-expiry', daysToExpiry: null };
  const daysToExpiry = Math.round((ms - midnight(opts.now)) / DAY_MS);
  if (daysToExpiry < 0) return { status: 'expired', daysToExpiry };
  if (daysToExpiry <= withinDays) return { status: 'expiring', daysToExpiry };
  return { status: 'current', daysToExpiry };
}

/**
 * Renewal collapse: per (userId, typeId) keep the record that drives truth —
 * the latest expiry, with `null` expiry counting as "never expires" (latest
 * possible). Ties fall back to latest updatedAt/createdAt. Type 'other' is
 * NOT collapsed (free-label tickets are distinct things).
 */
function effectiveCredentials(credentials) {
  const byKey = new Map();
  const passthrough = [];
  for (const c of credentials || []) {
    if (!c || !c.userId || !c.typeId) continue;
    if (c.typeId === 'other') { passthrough.push(c); continue; }
    const key = c.userId + '|' + c.typeId;
    const cur = byKey.get(key);
    if (!cur || supersedes(c, cur)) byKey.set(key, c);
  }
  return passthrough.concat([...byKey.values()]);
}

function supersedes(a, b) {
  const ax = a.expiryDate ? parseIsoDay(a.expiryDate) : Infinity;
  const bx = b.expiryDate ? parseIsoDay(b.expiryDate) : Infinity;
  if (ax !== bx) return ax > bx;
  return String(a.updatedAt || a.createdAt || '') > String(b.updatedAt || b.createdAt || '');
}

/**
 * Alertable rows for the cron: effective records that are expiring/expired,
 * on LIVE workers only (archived/disabled keep their records but never
 * alert). Row: { kind:'licence', key, id, userId, userName, typeId, label,
 * expiryISO, daysToExpiry, status }. Expired first (the house sort).
 * NEVER includes the licence number — rows feed push payloads and PII stays
 * out of notification bodies.
 */
function licenceRows(credentials, users, opts = {}) {
  const withinDays = Math.max(1, Math.min(365, Number(opts.withinDays) || 60));
  const liveById = new Map();
  for (const u of users || []) {
    if (!u || !u.id) continue;
    const disabled = u.archived || u.disabled || u.status === 'disabled';
    if (!disabled) liveById.set(u.id, u);
  }
  const rows = [];
  for (const c of effectiveCredentials(credentials)) {
    const user = liveById.get(c.userId);
    if (!user) continue;
    const { status, daysToExpiry } = licenceStatusFor(c.expiryDate, { now: opts.now, withinDays });
    if (status !== 'expiring' && status !== 'expired') continue;
    rows.push({
      kind: 'licence',
      key: 'licence:' + c.id,
      id: c.id,
      userId: c.userId,
      userName: user.username || user.name || c.userId,
      typeId: c.typeId,
      label: c.label || c.typeId,
      expiryISO: c.expiryDate,
      daysToExpiry,
      status,
    });
  }
  return rows.sort((a, b) => a.daysToExpiry - b.daysToExpiry);
}

/** Alert bands: 60d → 14d → expired (a licence alerts at most three times). */
function licenceThresholdFor(daysToExpiry) {
  if (daysToExpiry < 0) return 'expired';
  if (daysToExpiry <= 14) return 't14';
  if (daysToExpiry <= 60) return 't60';
  return null;
}

/**
 * Dedupe (same engine shape as tag-compliance.newCrossings, licence bands):
 * given current rows and persisted state ({ [key]: { threshold, notifiedAt } }),
 * return rows that newly crossed a band + the next state. Rows that left the
 * window (renewed) are pruned so a renewal resets the lifecycle.
 */
function newLicenceCrossings(rows, state, now) {
  const nowIso = new Date(now || Date.now()).toISOString();
  const prev = state && typeof state === 'object' ? state : {};
  const next = {};
  const crossed = [];
  for (const row of rows) {
    const threshold = licenceThresholdFor(row.daysToExpiry);
    if (!threshold) continue;
    next[row.key] = { threshold, notifiedAt: (prev[row.key] || {}).notifiedAt || null };
    if ((prev[row.key] || {}).threshold !== threshold) {
      crossed.push({ ...row, threshold });
      next[row.key].notifiedAt = nowIso;
    }
  }
  return { crossed, nextState: next };
}

/**
 * Worst licence status per worker (register chips): 'expired' beats
 * 'expiring' beats 'current'/'no-expiry' (→ 'ok'). Workers with no records
 * are absent — the UI must say "none on file", never "all current".
 */
function worstStatusByUser(credentials, opts = {}) {
  const map = {};
  const rank = { ok: 0, expiring: 1, expired: 2 };
  for (const c of effectiveCredentials(credentials)) {
    const { status } = licenceStatusFor(c.expiryDate, opts);
    const worst = status === 'expired' ? 'expired' : status === 'expiring' ? 'expiring' : 'ok';
    if (!(c.userId in map) || rank[worst] > rank[map[c.userId]]) map[c.userId] = worst;
  }
  return map;
}

module.exports = {
  LICENCE_TYPES,
  parseIsoDay,
  licenceStatusFor,
  effectiveCredentials,
  licenceRows,
  licenceThresholdFor,
  newLicenceCrossings,
  worstStatusByUser,
};
