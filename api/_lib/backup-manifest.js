// Backup manifest — the single enumeration of every canonical JSON store.
//
// The snapshot job (api/backup-snapshot.js → ./backup.js) iterates EXACTLY
// this list; scripts/check-backup-manifest.js fails CI when api/ writes a
// blob key this manifest doesn't cover. If you add a store, add it here in
// the same PR — the guard makes forgetting loud.
//
// Only `*.json` documents are snapshotted. Binaries (evidence/snag/ITP/office
// photos) are deliberately EXCLUDED: they are write-once-under-a-fresh-key
// (never overwritten in place), so the clobber risk this system exists for
// does not apply to them — and they would dwarf the snapshots.

/** Top-level single-document stores (exact keys). */
const EXACT_STORES = [
  'users.json',
  'jobs.json',
  'jobs-summary.json', // DERIVED field jobs-summary projection (Phil LCP perf); rebuilt from jobs.json on read, freshness-gated — disposable, but written by api/, so listed here for the guard
  'observations.json',
  'employees.json',
  'invites.json',
  'material-requests.json',
  'expenses.json', // reimbursement expenses register (#536)
  'itp-templates.json',
  'job-types.json',
  'quotes.json',
  'quotes-v2.json', // v2 quote registry (#183)
  'quote-rate-presets.json', // quoting labour rate presets (#193)
  'suppliers.json',
  'wholesalers.json',
  'payroll-runs.json',
  'activity.json',
  'activity-archive.json',
  'user-activity.json',
  'policy.json',
  'flags.json', // feature-flag runtime overrides (#155)
  'structure-presets.json', // reusable area-group presets (#192)
  'job-blueprints.json', // reusable whole-job shapes (#191)
  'tag-reminder-state.json', // tag/calibration alert dedupe state (#305)
  'leave-requests.json', // workforce leave request/approval store (#333)
  'workforce/credentials.json', // worker licence/ticket register (#331)
  'licence-reminder-state.json', // licence alert dedupe state (#331)
  'temps/assets.json',
  'temps/movements.json',
];

/** Multi-document stores (path prefixes; every *.json under them). */
const PREFIX_STORES = [
  'jobs/', // per-job data.json, itps.json, tags.json, materials-list.json, plans-index.json, photos-index.json, templates.json, temps.json, inductions.json, prestart.json (pre-start readiness #371), scope-reconciliation.json (job-control L0), job-control.json (job-control L1) …
  'users/', // per-user time-entries/<date>.json (payroll data)
  'audit/', // audit-log monthly rollovers audit/<yyyy-mm>.json
  'assets/', // gear/asset documents
  'quotes/', // per-quote section documents (structure, pricing, …)
  'quotes-v2/', // v2 per-quote documents (sections/lines) (#183)
  'suppliers/', // per-supplier products.json (supplier-products.js)
  'access-requests/',
  'password-resets/',
];

/** The snapshot destination prefix — never itself snapshotted or app-read. */
const BACKUP_PREFIX = 'backups/';

/** True when a blob pathname is something the snapshot should copy. */
function isSnapshotTarget(pathname) {
  if (typeof pathname !== 'string' || !pathname.endsWith('.json')) return false;
  if (pathname.startsWith(BACKUP_PREFIX)) return false;
  return true;
}

/** True when a write key (literal or template prefix) is covered by the manifest. */
function isCoveredKey(keyOrPrefix) {
  if (EXACT_STORES.includes(keyOrPrefix)) return true;
  return PREFIX_STORES.some((p) => keyOrPrefix.startsWith(p));
}

module.exports = {
  EXACT_STORES,
  PREFIX_STORES,
  BACKUP_PREFIX,
  isSnapshotTarget,
  isCoveredKey,
};
