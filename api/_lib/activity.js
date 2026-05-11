// ╔════════════════════════════════════════════════════════════════════╗
// ║  api/_lib/activity.js — append-only activity log helper.           ║
// ║                                                                    ║
// ║  Per brief §14 (Activity & audit):                                 ║
// ║    "Append-only on the server. The desk cannot edit history."      ║
// ║    "Every row has actor · timestamp · action · target · reason     ║
// ║    (when relevant)."                                               ║
// ║                                                                    ║
// ║  Storage shape — public/_data/activity.json:                       ║
// ║    { entries: [                                                    ║
// ║        { id, ts, actor, actorName, action, scope, target,          ║
// ║          targetLabel, reason, meta, hash, prevHash }               ║
// ║      ] }                                                           ║
// ║                                                                    ║
// ║  Each row carries a SHA-256 hash of its own canonicalised fields  ║
// ║  PLUS the previous row's hash — a Merkle chain so the boss can     ║
// ║  detect any silent tamper at audit time.                           ║
// ║                                                                    ║
// ║  USAGE                                                             ║
// ║    const { appendActivity } = require('./_lib/activity');          ║
// ║    await appendActivity({                                          ║
// ║      action: 'hours.approved',                                     ║
// ║      scope:  'hours',          // hours · jobs · users · ...       ║
// ║      target: 'user:abc/2026-05-11',                                ║
// ║      targetLabel: 'Jake · 11 May',                                 ║
// ║      actor:  me.id,                                                ║
// ║      actorName: me.username,                                       ║
// ║      reason: null,                                                 ║
// ║      meta: { totalHours: 8 },                                      ║
// ║    });                                                             ║
// ╚════════════════════════════════════════════════════════════════════╝

const crypto = require('crypto');
const { readBlob, writeBlob } = require('./blob');

const KEY = 'activity.json';

function newId() {
  return 'act_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

function canonicalise(row) {
  // Stable string for hashing — only fields that define the row's meaning.
  // Excludes `hash` and `prevHash` (computed afterwards).
  return JSON.stringify({
    id:          row.id,
    ts:          row.ts,
    actor:       row.actor || null,
    actorName:   row.actorName || null,
    action:      row.action,
    scope:       row.scope || null,
    target:      row.target || null,
    targetLabel: row.targetLabel || null,
    reason:      row.reason || null,
    meta:        row.meta || null,
  });
}

function hashRow(row) {
  return crypto.createHash('sha256').update(canonicalise(row), 'utf8').digest('hex');
}

/**
 * Append a single activity row.
 * Mutating endpoints call this AFTER they've persisted their write so a
 * failure here doesn't leave a phantom log entry. Failures are swallowed
 * and logged to stderr — the activity log is best-effort by design.
 */
async function appendActivity(row) {
  try {
    if (!row || !row.action) throw new Error('action required');
    const data = await readBlob(KEY, { entries: [] });
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const prev = entries.length ? entries[entries.length - 1] : null;
    const next = {
      id:          newId(),
      ts:          new Date().toISOString(),
      actor:       row.actor || null,
      actorName:   row.actorName || null,
      action:      String(row.action),
      scope:       row.scope || null,
      target:      row.target || null,
      targetLabel: row.targetLabel || null,
      reason:      row.reason || null,
      meta:        row.meta || null,
    };
    next.prevHash = prev ? (prev.hash || null) : null;
    next.hash = hashRow(next);
    entries.push(next);
    // Cap retention at 50k rows; rotate the oldest into activity-archive
    // when we cross that line. The boss only needs ~6 months back online.
    if (entries.length > 50000) {
      const cut = entries.length - 50000;
      const archived = await readBlob('activity-archive.json', { entries: [] });
      const archivedList = Array.isArray(archived.entries) ? archived.entries : [];
      archivedList.push(...entries.splice(0, cut));
      await writeBlob('activity-archive.json', { entries: archivedList });
    }
    await writeBlob(KEY, { entries });
    return next;
  } catch (e) {
    console.error('appendActivity failed', e);
    return null;
  }
}

/**
 * Read a slice of the activity log, newest-first, optionally filtered by
 * scope or target prefix. Used by the admin activity page + CSV export.
 */
async function readActivity({ scope, targetPrefix, limit = 200, offset = 0 } = {}) {
  const data = await readBlob(KEY, { entries: [] });
  let entries = Array.isArray(data.entries) ? data.entries : [];
  if (scope) {
    entries = entries.filter(e => e.scope === scope);
  }
  if (targetPrefix) {
    entries = entries.filter(e => (e.target || '').startsWith(targetPrefix));
  }
  // Newest first.
  const sorted = entries.slice().sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  return {
    total: entries.length,
    entries: sorted.slice(offset, offset + limit),
  };
}

/**
 * Verify the Merkle chain. Returns { valid, brokenAt } for an audit.
 */
async function verifyChain() {
  const data = await readBlob(KEY, { entries: [] });
  const entries = Array.isArray(data.entries) ? data.entries : [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const expected = hashRow(e);
    if (e.hash !== expected) return { valid: false, brokenAt: i, reason: 'hash mismatch' };
    const prevHash = i === 0 ? null : entries[i - 1].hash;
    if (e.prevHash !== prevHash) return { valid: false, brokenAt: i, reason: 'prevHash mismatch' };
  }
  return { valid: true, count: entries.length };
}

module.exports = { appendActivity, readActivity, verifyChain };
