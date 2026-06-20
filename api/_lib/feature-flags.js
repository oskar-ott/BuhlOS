// Feature flags (#155) — minimal, boring, dependency-free.
//
// The repo's hard rule is "half-broken UI is hidden or labelled, never
// shipped live". Flags make that cheap: merge unfinished work DARK
// (default off), stage it to the admin tier first, kill a misbehaving
// feature without a revert deploy.
//
// Resolution order (first hit wins), per flag:
//   1. env var  FLAG_<SNAKE_UPPER>   ('1'/'true' → on, '0'/'false' → off)
//   2. flags.json blob override      ({ flags: { <key>: true|false } })
//   3. registry default              (always false — dark by default)
// Then TARGETING applies on top of enablement: a flag with
// target 'admin-tier' is only ever on for admin-tier viewers (tier-aware
// isAdminRole — never literal role strings); 'global' ignores the viewer.
//
// Cost: env flags are free; the blob override rides readBlob's 5s TTL
// cache, so hot paths never add a blocking fetch beyond one per 5s per
// instance. Unknown flag names THROW (and fail typecheck via the .d.ts) —
// a typo must never silently resolve to false.
//
// Flags are temporary by default: every entry declares `expires`
// (YYYY-MM-DD). scripts/check-flag-expiry.js fails CI once a flag
// outlives its date — clean it up (delete the flag + dead branch) or
// consciously extend it. Inventory + conventions: docs/feature-flags.md.

const { readBlob } = require('./blob');
const { isAdminRole } = require('./auth');

/** @type {Record<string, {description: string, default: boolean, target: 'global'|'admin-tier', expires: string}>} */
const REGISTRY = {
  // Supabase per-domain dual-write (issue #152's rollout switch — the
  // importers land dark behind this).
  supabase_dual_write: {
    description: 'Mirror blob writes into Supabase per migrated domain (#152).',
    default: false,
    target: 'global',
    expires: '2026-09-30',
  },
  // The read-only Supabase connectivity proving slice (#533) — gates
  // GET /api/supabase-health, the first real DB caller. Dark until a preview
  // is wired; flip on per-environment to prove the guard→pooler→client path.
  supabase_read_health: {
    description: 'Enable GET /api/supabase-health, the read-only Supabase connectivity proving slice (#533).',
    default: false,
    target: 'global',
    expires: '2026-12-31',
  },
  // Hours read-cutover (#152 rung 3): when on, the hours DISPLAY read
  // (listUserEntries) is served from Postgres with a Blob fallback. Dark until a
  // domain's PG data is proven IN SYNC; flip per-environment. readEntry (the
  // write path) deliberately stays on Blob.
  supabase_read_hours: {
    description: 'Serve the hours display read (listUserEntries) from Postgres with a Blob fallback (#152).',
    default: false,
    target: 'global',
    expires: '2026-12-31',
  },
  // Jobs/tasks read projection (J5): when on, the jobs/tasks DISPLAY read can be
  // reconstructed from Postgres (api/_lib/job-read-projection) with a Blob
  // fallback. DARK — no consumer is wired yet (no route/UI cutover); flip
  // per-environment only after the structure sync-check + read parity prove the
  // PG graph reconstructs the Blob shape. Blob stays authoritative when off.
  supabase_read_jobs: {
    description: 'Reconstruct the jobs/tasks display read from Postgres with a Blob fallback (#152, J5). Dark.',
    default: false,
    target: 'global',
    expires: '2026-12-31',
  },
  // The role-targeting exemplar + ops aid: a small "active flags" readout
  // on the command centre, visible only to the admin tier when enabled.
  admin_flags_readout: {
    description: 'Show the active-flags readout card on /command-centre (admin tier only).',
    default: false,
    target: 'admin-tier',
    expires: '2026-09-30',
  },
};

const FLAGS_KEY = 'flags.json';

function envName(key) {
  return 'FLAG_' + String(key).toUpperCase();
}

function parseEnv(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const v = String(raw).toLowerCase();
  if (v === '1' || v === 'true' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'off') return false;
  return null; // unparseable → fall through, never guess
}

function definitionOf(key) {
  const def = REGISTRY[key];
  if (!def) throw new Error(`unknown feature flag "${key}" — flags must be declared in api/_lib/feature-flags.js`);
  return def;
}

/** Enablement only (no targeting): env > blob override > default. */
async function isFlagOn(key) {
  const def = definitionOf(key);
  const fromEnv = parseEnv(process.env[envName(key)]);
  if (fromEnv !== null) return fromEnv;
  try {
    const doc = await readBlob(FLAGS_KEY, { flags: {} });
    const override = doc && doc.flags ? doc.flags[key] : undefined;
    if (typeof override === 'boolean') return override;
  } catch {
    // Blob unavailable → behave as if no override exists. Dark by default.
  }
  return def.default;
}

/**
 * Enablement + targeting for a viewer ({ role } or null for anonymous /
 * system callers — who only ever see 'global' flags).
 */
async function isFlagEnabled(key, viewer) {
  const def = definitionOf(key);
  if (!(await isFlagOn(key))) return false;
  if (def.target === 'admin-tier') return Boolean(viewer && isAdminRole(viewer.role));
  return true;
}

/** Resolved map for one viewer — what a server page serializes to a client.
 *  Never ship the raw flags blob; only this viewer-scoped projection. */
async function flagsForViewer(viewer) {
  const out = {};
  for (const key of Object.keys(REGISTRY)) {
    out[key] = await isFlagEnabled(key, viewer);
  }
  return out;
}

/** Registry listing for docs/ops surfaces. */
function listFlags() {
  return Object.entries(REGISTRY).map(([key, def]) => ({ key, ...def }));
}

/** Flags whose expiry has passed — the CI guard fails on any. */
function expiredFlags(now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  return listFlags().filter((f) => f.expires < today);
}

module.exports = {
  REGISTRY,
  FLAGS_KEY,
  isFlagOn,
  isFlagEnabled,
  flagsForViewer,
  listFlags,
  expiredFlags,
};
