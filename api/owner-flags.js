// Owner Console — runtime feature-flag control (#760).
//
//   POST /api/owner-flags   { key, scope, value, expectedRev }
//
// The WRITE companion to GET /api/owner (which stays read-only). Same
// owner-only boundary: requireAuth (HMAC-verified, fresh users.json) then
// canAccessOwnerConsole (role 'owner' OR OWNER_EMAILS). Fails CLOSED
// (401 unauth, 403 non-owner).
//
// Two dials per flag, both stored in the flags.json blob:
//   * scope 'customer'     → doc.flags[key]        — the launch gate: what
//                            customers see (the existing isFlagOn baseline).
//   * scope 'ownerPreview' → doc.ownerPreview[key] — owner-only override so the
//                            owner can run a feature LIVE while it's dark for
//                            customers (see api/_lib/feature-flags.js).
// value: true|false pins the dial; null clears the override (falls back to env /
// registry default). Env vars (FLAG_*) ALWAYS WIN over both dials — a flag
// pinned by env can't be changed here (the console renders it disabled).
//
// Protected (data-plane) flags — supabase_* and phil_jobs_summary_read — are
// NEVER writable here (isProtectedFlag → 409): they're ops levers, not product
// features. Writes are CAS-guarded (expectedRev) against the shared blob and
// audited (feature_flag.toggled, best-effort — the toggle never blocks on it).
//
// Like the rest of api/*.js this does not run under `next dev` (PR previews are
// the verification surface).

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canAccessOwnerConsole } = require('./_lib/auth');
const { REGISTRY, isFlagOn, isFlagEnabled, isProtectedFlag } = require('./_lib/feature-flags');
const { writeGuardErrorResponse } = require('./_lib/blob-guards');
const { append } = require('./_lib/audit-log');

// Local literal (matches api/owner.js) — the backup-manifest guard resolves a
// same-file string const; flags.json is already in api/_lib/backup-manifest.js.
const FLAGS_KEY = 'flags.json';

// scope → the blob sub-map it writes.
const SCOPE_FIELD = { customer: 'flags', ownerPreview: 'ownerPreview' };

/** The stored revision (writeBlob stamps __rev); absent on a never-written doc. */
function revOf(doc) {
  return doc && Number.isFinite(doc.__rev) ? doc.__rev : undefined;
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  // Owner-only gate — the same authoritative boundary as GET /api/owner.
  const me = await requireAuth(req, res, {});
  if (!me) return; // 401 already sent
  if (!canAccessOwnerConsole(me)) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }

  const body = req.body || {};
  const key = typeof body.key === 'string' ? body.key : '';
  const scope = typeof body.scope === 'string' ? body.scope : '';
  const value = body.value;

  // Known flag only — mirrors the resolver's "unknown keys throw" guarantee so
  // a typo can never write a phantom override.
  if (!key || !REGISTRY[key]) {
    return res.status(400).json({ ok: false, error: 'unknown flag', code: 'unknown_flag' });
  }
  const field = SCOPE_FIELD[scope];
  if (!field) {
    return res
      .status(400)
      .json({ ok: false, error: 'scope must be "customer" or "ownerPreview"', code: 'bad_scope' });
  }
  if (value !== true && value !== false && value !== null) {
    return res
      .status(400)
      .json({ ok: false, error: 'value must be true, false, or null', code: 'bad_value' });
  }
  // Data-plane flags are ops-only — never toggleable from the owner UI (both
  // scopes). The console also renders them read-only, so this is defence in depth.
  if (isProtectedFlag(key)) {
    return res
      .status(409)
      .json({ ok: false, error: 'flag is protected (data-plane / ops-only)', code: 'protected' });
  }

  // Read-modify-write the shared flags blob under CAS.
  let doc;
  try {
    doc = await readBlob(FLAGS_KEY, { flags: {} });
  } catch {
    doc = { flags: {} };
  }
  // Prefer the client's expectedRev (true optimistic concurrency from the
  // rendered console); fall back to the just-read rev.
  const expectedRev = Number.isFinite(body.expectedRev) ? body.expectedRev : revOf(doc);

  // Mutate a clone — never the cached object.
  const next = {
    ...doc,
    flags: { ...(doc.flags || {}) },
    ownerPreview: { ...(doc.ownerPreview || {}) },
  };
  const previous = next[field][key] === undefined ? null : next[field][key];
  if (value === null) delete next[field][key];
  else next[field][key] = value;

  try {
    await writeBlob(FLAGS_KEY, next, {
      expectedRev,
      actor: { id: me.id, username: me.username, role: me.role || null },
    });
  } catch (err) {
    const mapped = writeGuardErrorResponse(err); // stale_write → 409, invalid → 400
    if (mapped) return res.status(mapped.status).json({ ok: false, ...mapped.body });
    throw err; // genuine failure — let the platform surface a 500
  }

  // Best-effort audit — never blocks the toggle.
  append({
    action: 'feature_flag.toggled',
    actorId: me.id,
    actorName: me.username || 'Unknown',
    actorRole: me.role || null,
    jobId: null,
    targetType: 'feature_flag',
    targetId: key,
    summary: `${scope === 'ownerPreview' ? 'owner-preview' : 'customer'} ${key} → ${
      value === null ? 'default' : value ? 'on' : 'off'
    }`,
    metadata: { scope, value, previous },
  }).catch(() => {});

  // Recompute resolved state so the UI updates without a refetch. writeBlob made
  // this instance read-after-write consistent (it cached the stamped doc), so
  // these reads + the re-read for the new rev reflect the write just made.
  let resolvedCustomer = null;
  let resolvedOwner = null;
  let newRev;
  try {
    resolvedCustomer = await isFlagOn(key);
  } catch {
    /* leave null */
  }
  try {
    resolvedOwner = await isFlagEnabled(key, { role: 'owner' });
  } catch {
    /* leave null */
  }
  try {
    newRev = revOf(await readBlob(FLAGS_KEY, { flags: {} }));
  } catch {
    /* leave undefined */
  }

  return res.status(200).json({
    ok: true,
    key,
    scope,
    value,
    rev: newRev,
    resolved: { customer: resolvedCustomer, owner: resolvedOwner },
  });
};
