// Owner Console — per-feature config knob writes (#760 PR2).
//
//   PUT /api/owner-settings   { featureKey, key, value, expectedRev }
//
// The write companion for feature settings (the read projection ships in
// GET /api/owner). Same owner-only boundary as the rest of the console:
// requireAuth (HMAC-verified, fresh users.json) then canAccessOwnerConsole.
// Fails CLOSED (401 unauth, 403 non-owner).
//
// Validated against api/_lib/feature-settings.js SETTINGS_REGISTRY: an unknown
// featureKey/key is 404; an out-of-range / wrong-type value is 400 with an
// operator message. Writes are CAS-guarded (expectedRev) against the shared
// feature-settings.json blob and audited (feature_config.changed, best-effort).
//
// Like the rest of api/*.js this does not run under `next dev` (PR previews are
// the verification surface).

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canAccessOwnerConsole } = require('./_lib/auth');
const { definitionOf, validateWrite, getSetting } = require('./_lib/feature-settings');
const { writeGuardErrorResponse } = require('./_lib/blob-guards');
const { append } = require('./_lib/audit-log');

// Local literal (matches owner-flags.js) so the backup-manifest guard resolves it.
const SETTINGS_KEY = 'feature-settings.json';

function revOf(doc) {
  return doc && Number.isFinite(doc.__rev) ? doc.__rev : undefined;
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PUT') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  // Owner-only gate — the same authoritative boundary as GET /api/owner.
  const me = await requireAuth(req, res, {});
  if (!me) return; // 401 already sent
  if (!canAccessOwnerConsole(me)) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }

  const body = req.body || {};
  const featureKey = typeof body.featureKey === 'string' ? body.featureKey : '';
  const key = typeof body.key === 'string' ? body.key : '';

  // Known setting? definitionOf throws on an unknown feature/key → 404.
  try {
    definitionOf(featureKey, key);
  } catch {
    return res.status(404).json({ ok: false, error: 'unknown setting', code: 'unknown_setting' });
  }
  // Type / range / enum validation against the registry → 400 with a message.
  const check = validateWrite(featureKey, key, body.value);
  if (!check.ok) {
    return res.status(400).json({ ok: false, error: check.error, code: 'invalid_value' });
  }
  const value = check.value;

  // Read-modify-write the settings blob under CAS.
  let doc;
  try {
    doc = await readBlob(SETTINGS_KEY, { settings: {} });
  } catch {
    doc = { settings: {} };
  }
  const expectedRev = Number.isFinite(body.expectedRev) ? body.expectedRev : revOf(doc);

  const next = { ...doc, settings: { ...(doc.settings || {}) } };
  next.settings[featureKey] = { ...(next.settings[featureKey] || {}) };
  const previous =
    next.settings[featureKey][key] === undefined ? null : next.settings[featureKey][key];
  next.settings[featureKey][key] = value;

  try {
    await writeBlob(SETTINGS_KEY, next, {
      expectedRev,
      actor: { id: me.id, username: me.username, role: me.role || null },
    });
  } catch (err) {
    const mapped = writeGuardErrorResponse(err); // stale_write → 409, invalid → 400
    if (mapped) return res.status(mapped.status).json({ ok: false, ...mapped.body });
    throw err;
  }

  // Best-effort audit — never blocks the write.
  append({
    action: 'feature_config.changed',
    actorId: me.id,
    actorName: me.username || 'Unknown',
    actorRole: me.role || null,
    jobId: null,
    targetType: 'feature_config',
    targetId: `${featureKey}.${key}`,
    summary: `set ${featureKey}.${key} = ${value}`,
    metadata: { featureKey, key, from: previous, to: value },
  }).catch(() => {});

  // Echo the authoritative resolved value + new rev (read-after-write consistent
  // on this instance) so the UI updates without a refetch.
  let resolved = value;
  let newRev;
  try {
    resolved = await getSetting(featureKey, key);
  } catch {
    /* keep the written value */
  }
  try {
    newRev = revOf(await readBlob(SETTINGS_KEY, { settings: {} }));
  } catch {
    /* leave undefined */
  }

  return res.status(200).json({ ok: true, featureKey, key, value, resolved, rev: newRev });
};
