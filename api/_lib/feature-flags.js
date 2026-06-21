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
  // Jobs/tasks STRUCTURE dual-write (J8): when on, a jobs.json structure write
  // (create / edit / bulk-edit / publish) ALSO mirrors that ONE job's
  // tenant/job/groups/areas/templates into Postgres, best-effort, AFTER the Blob
  // write (Blob stays authoritative; a PG failure never fails the save). This is
  // what makes the J6/J7 read overlays load-bearing instead of serving a frozen
  // import snapshot. Separate from supabase_dual_write so jobs + hours cut over
  // independently. Default OFF, unset in prod. Task INSTANCES/status (the `tasks`
  // table, via data.json) are a SEPARATE rung, not mirrored here.
  supabase_dual_write_jobs: {
    description: 'Mirror jobs.json structure writes (one job) into Postgres best-effort, Blob authoritative (#152, J8). Dark.',
    default: false,
    target: 'global',
    expires: '2026-12-31',
  },
  // Task STATE dual-write (J9): when on, the scheduled mirror cron
  // (/api/internal/mirror-tasks) reconciles per-job task STATUS from the
  // authoritative data.json into Postgres tasks.status (+ append-only
  // task_status_events for real transitions), OFF the request path so the
  // high-frequency task-toggle gains ZERO latency. Blob authoritative; a PG
  // failure never affects field work. Separate flag so task state cuts over
  // independently of structure. Default OFF, unset in prod. Task READ stays Blob.
  supabase_dual_write_tasks: {
    description: 'Reconcile task status from data.json into Postgres (cron, off request path), best-effort, Blob authoritative (#152, J9). Dark.',
    default: false,
    target: 'global',
    expires: '2026-12-31',
  },
  // Phil task-status READ cutover (J10): when on, the FIELD/Phil task-status read
  // (/api/data) is served from the Postgres mirror, parity-gated per job
  // (byte-faithful or Blob fallback) so a not-yet-mirrored toggle can never show a
  // stale status. Output is identical to Blob; worker isolation is unchanged
  // (requireAuth({jobId})). Admin task reads stay on Blob (J11). Default OFF,
  // unset in prod. Pairs with supabase_dual_write_tasks (the mirror that feeds it).
  supabase_read_phil_tasks: {
    description: 'Serve the FIELD task-status read (/api/data) from Postgres, per-job parity-gated, with a Blob fallback (#152, J10). Dark.',
    default: false,
    target: 'global',
    expires: '2026-12-31',
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
  // Jobs/tasks read projection (J5) + admin read cutover (J6): when on, the
  // ADMIN jobs read (api/jobs.js) serves each job's migrated fields from the
  // Postgres reconstruction (api/_lib/job-read-projection) where PG is
  // byte-identical to Blob, else from Blob; any PG error → full Blob fallback.
  // DARK by default. The flag itself is global; the ADMIN-TIER restriction is
  // enforced at the call site (api/jobs.js gates the overlay on isAdminRole), so
  // Phil/field/clients always read Blob even when the flag is on. Flip
  // per-environment only after the structure sync-check +
  // read parity prove the PG graph reconstructs the Blob shape. Blob stays
  // authoritative when off, and unset in production keeps prod on Blob. The
  // /jobs-read-status admin page shows the live read source + parity.
  supabase_read_jobs: {
    description: 'Serve the ADMIN jobs read from Postgres (per-job parity-gated) with a Blob fallback (#152, J5/J6). Dark.',
    default: false,
    target: 'global',
    expires: '2026-12-31',
  },
  // Phil (field) read cutover (J7): when on, the FIELD/LEADING-HAND jobs read
  // (api/jobs.js — the same /api/jobs Phil uses for the list, My Day and job
  // detail) is served from the Postgres reconstruction using the SAME per-job
  // parity-gated Blob-spine overlay as J6, scoped to the worker's assigned
  // (visible) jobs so PG is never read for jobs they can't see (no cross-worker
  // leakage). DARK; flag is global but the field-tier restriction is at the call
  // site (api/jobs.js gates on isFieldRole/isLeadingHandRole). Default OFF, unset
  // in prod. Task STATUS (data.json dwellings) is a separate read, NOT in scope.
  supabase_read_phil_jobs: {
    description: 'Serve the FIELD/Phil jobs read from Postgres (per-job parity-gated, visible-scoped) with a Blob fallback (#152, J7). Dark.',
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
