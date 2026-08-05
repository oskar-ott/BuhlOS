// Feature flags (#155) — minimal, boring, dependency-free.
//
// The repo's hard rule is "half-broken UI is hidden or labelled, never
// shipped live". Flags make that cheap: merge unfinished work DARK
// (default off), stage it to the admin tier first, kill a misbehaving
// feature without a revert deploy.
//
// Resolution order (first hit wins), per flag — the CUSTOMER baseline
// (isFlagOn, no viewer):
//   1. env var  FLAG_<SNAKE_UPPER>   ('1'/'true' → on, '0'/'false' → off)
//   2. flags.json blob override      ({ flags: { <key>: true|false } })
//   3. registry default              (always false — dark by default)
// Then TARGETING applies on top of enablement: a flag with
// target 'admin-tier' is only ever on for admin-tier viewers (tier-aware
// isAdminRole — never literal role strings); 'global' ignores the viewer.
//
// OWNER PREVIEW (isFlagEnabled, viewer-aware path only): the product owner
// can run a feature live while customers still can't see it. When the viewer
// is the owner (isOwnerRole) and flags.json has an ownerPreview[key] boolean,
// that value overrides the customer baseline FOR THE OWNER ALONE. Env still
// wins absolutely (the ops kill-switch beats owner preview). The data-plane
// path (isFlagOn / isFlagOnSync, no viewer) never reads ownerPreview, so
// owner preview can never alter request-time data behaviour.
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
const { isAdminRole, isOwnerRole } = require('./auth');

/** @type {Record<string, {description: string, default: boolean, target: 'global'|'admin-tier', expires: string}>} */
const REGISTRY = {
  // #249 — the first Xero WRITE. Its OWN gate, independent of xero_connection:
  // turning Xero writes off never touches time capture, the CSV fallback, or the
  // read-only reference sync. Default OFF, admin-tier, owner-previewable.
  xero_payroll_export: {
    description: 'The first Xero WRITE — push a LOCKED payroll batch to Xero Payroll AU as DRAFT timesheets with readback reconciliation (#249). Independent of xero_connection; default off, admin-tier. No pay runs / approval / STP.',
    default: false,
    target: 'admin-tier',
    expires: '2026-12-31',
  },
  // Phil FIELD jobs-summary READ path (perf, not Supabase): when on, the
  // field/leading-hand job LIST GET (/api/jobs, no ?id, no ?withStats) is served
  // from a small derived jobs-summary.json projection instead of reading+parsing
  // the full jobs.json monolith (~3.5s). The summary is rebuilt lazily on read
  // when stale (validated against jobs.json's blob uploadedAt) so it can never
  // serve stale data, and any miss/error falls back to the full jobs.json read.
  // Checked ENV-ONLY on the hot path (isFlagOnSync) so DARK adds ZERO cost — no
  // flags.json read on the field path. Default OFF, unset in prod. Field LIST
  // only; admin/client/single-job/withStats keep the full read. TAKES PRECEDENCE
  // over the supabase_read_phil_jobs PG overlay for the field list (the overlay
  // rides on the full jobs.json read and doesn't fix LCP; the summary does, from
  // the same dual-written Blob spine — see docs/architecture/phil-jobs-summary-projection.md).
  phil_jobs_summary_read: {
    description: 'Serve the FIELD job LIST read (/api/jobs) from a derived jobs-summary.json projection, freshness-gated with full jobs.json fallback (Phil LCP perf). Dark.',
    default: false,
    target: 'global',
    expires: '2026-12-31',
  },
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
  // Evidence-metadata dual-write: when on, the scheduled mirror cron
  // (/api/internal/mirror-evidence) reconciles per-job blob evidence
  // (data.json.evidence[]) into Postgres evidence_files + evidence_links, OFF the
  // request path so the field CAPTURE write (api/evidence.js) is unchanged (zero
  // added latency). Closes the gap the evidence read overlay had (captured evidence
  // never reached PG without this). Reuses the J4 importer's writer; metadata only
  // (binaries stay in Blob). Blob authoritative; a PG failure never affects capture.
  // Separate flag so evidence cuts over independently. Default OFF, unset in prod.
  supabase_dual_write_evidence: {
    description: 'Reconcile evidence metadata from data.json into Postgres evidence_files/links (cron, off request path), best-effort, Blob authoritative (#152). Dark.',
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
  // Task-status PG-AS-SOURCE (Stage A): when on, /api/task-toggle writes the task
  // status to Postgres with a per-row CAS update (revision bump + status_event) AT
  // REQUEST TIME — fixing Blob's whole-document "last writer wins" lost-update flaw —
  // in addition to the Blob write-through (Blob stays current for rollback + the
  // snags/notes envelope). Reads stay parity-gated in Stage A (a PG lag falls back to
  // current Blob — never stale); the PG-authoritative read is a later sub-step.
  // Best-effort: a PG write failure falls back to the Blob-only write so field work
  // never stops. Default OFF, unset in prod. See task-status-pg-source-promotion-adr.md.
  supabase_source_tasks: {
    description: 'Write task status to Postgres with CAS at request time (/api/task-toggle), Blob write-through, parity-gated read (#152, PG-as-source Stage A). Dark.',
    default: false,
    target: 'global',
    expires: '2026-12-31',
  },
  // Hours PG-AS-SOURCE (Stage A): promotes the EXISTING synchronous hours mirror
  // (api/_lib/hours-mirror.js, called in-request from the writeEntry seam) to the
  // domain's source-authoritative write. Unlike tasks — whose mirror was an async
  // cron, so #738 added a NEW synchronous CAS write — the hours mirror is ALREADY a
  // synchronous, in-request, per-row upsert (`on conflict (tenant,user,work_date) do
  // update ... where <distinct from>`, revision bumped by trigger) with the entry's
  // allocations reconciled in the same txn. So no new write file is needed: this flag
  // simply designates that upsert as the source write (it runs when EITHER this flag
  // OR the generic supabase_dual_write is on). The integrity character also differs
  // from tasks: the hours Blob write already has optimistic-lock CAS (writeBlob
  // expectedRev: entry.__rev), so hours has no lost-update flaw — the PG win is
  // REFERENTIAL (real job FKs + per-allocation rows + schema CHECKs) and it unlocks a
  // PG-authoritative payroll read (Stage B). Read stays parity-gated in Stage A.
  // Best-effort + Blob write-through always (field work never stops). Default OFF,
  // unset in prod. See supabase-served-source-roadmap.md.
  supabase_source_hours: {
    description: 'Designate the synchronous hours mirror as the source-authoritative PG write (in addition to supabase_dual_write), Blob write-through, parity-gated read (#152, PG-as-source Stage A). Dark.',
    default: false,
    target: 'global',
    expires: '2026-12-31',
  },
  // Admin task-status READ cutover (J11): when on, the ADMIN tier's task-status
  // read (/api/data) is served from the Postgres mirror using the SAME per-job
  // parity-gated overlay as J10 (byte-faithful or Blob fallback), so the office
  // can never see a stale status. Output is identical to Blob. The flag is global
  // but the admin-tier restriction is at the call site (api/data.js gates the
  // admin overlay on isAdminRole), so field/leading-hand keep the J10 path and
  // CLIENTS always read pure Blob. Separate from supabase_read_phil_tasks so the
  // office cuts over independently of the field, AFTER the field path is proven.
  // Default OFF, unset in prod. Pairs with supabase_dual_write_tasks (the feed).
  supabase_read_admin_tasks: {
    description: 'Serve the ADMIN task-status read (/api/data) from Postgres, per-job parity-gated, with a Blob fallback (#152, J11). Dark.',
    default: false,
    target: 'global',
    expires: '2026-12-31',
  },
  // Admin evidence-metadata READ OVERLAY (the evidence domain, after the J10–J12
  // task-status cutover + the evidence parity probe): when on, the ADMIN-tier
  // evidence read (/api/data evidence[]) is served from the Postgres evidence_files
  // mirror using the SAME per-job parity gate (byte-faithful migrated fields or
  // Blob fallback). Output is identical to Blob; photo bytes + excluded fields
  // (URLs, note bodies, labels, timestamps) stay Blob. The flag is global but the
  // admin-tier restriction is at the call site (api/data.js gates on isAdminRole),
  // so field/leading-hand keep pure-Blob evidence and CLIENTS are untouched.
  // Evidence METADATA only — proof-status (job-control.json) is Blob-only and not
  // touched. Default OFF, unset in prod. Pairs with the evidence parity probe.
  supabase_read_admin_evidence: {
    description: 'Serve the ADMIN evidence-metadata read (/api/data) from Postgres, per-job parity-gated, with a Blob fallback (#152). Dark.',
    default: false,
    target: 'global',
    expires: '2026-12-31',
  },
  // Phil/FIELD evidence-metadata READ OVERLAY: the field-tier counterpart of
  // supabase_read_admin_evidence (admin-first; this is the next rung). When on, the
  // FIELD/leading-hand evidence read (/api/data evidence[]) is served from the PG
  // evidence_files mirror using the SAME per-job parity gate (byte-faithful migrated
  // fields or Blob fallback), chained AFTER the field task-status overlay. Output is
  // identical to Blob; photo bytes + excluded fields (URLs, note bodies, labels,
  // timestamps) stay Blob. Global flag, field-tier restriction at the call site
  // (api/data.js gates on isFieldRole/isLeadingHandRole); independent of the admin
  // evidence flag so the field cuts over separately; CLIENTS untouched. Evidence
  // METADATA only — proof-status (job-control.json) is Blob-only and not touched.
  // Default OFF, unset in prod.
  supabase_read_phil_evidence: {
    description: 'Serve the FIELD/Phil evidence-metadata read (/api/data) from Postgres, per-job parity-gated, with a Blob fallback (#152). Dark.',
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
  // ADMIN single-job PG DIRECT read (perf — the /v2/jobs/[jobId] hub LCP): when
  // on, the ADMIN single-job GET (/api/jobs?id=…) is served WITHOUT reading the
  // jobs.json monolith (~2.5s cold): the migrated structure comes from the
  // Postgres mirror (scoped to that ONE job) and the Blob-only remainder (money,
  // customFields, scopeOfWork, modules, …) from a tiny derived per-job
  // jobs/<id>/admin-extras.json. DOUBLE-gated per read — the extras must be
  // fresh against jobs.json's blob uploadedAt AND the PG structure must
  // hash-match the Blob structure stamped at build time — so a write or a
  // lagging dual-write mirror always falls back to the full Blob read (never
  // stale, output == Blob). Distinct from supabase_read_jobs (J6), which is the
  // LIST-level overlay riding ON TOP of the monolith read and has different
  // semantics. Flag is global; the ADMIN-TIER restriction is at the call site
  // (api/jobs.js gates on isAdminRole) — field/LH keep field-detail.json and
  // clients always read pure Blob. Default OFF, unset in prod; prove parity on
  // /jobs-read-status (single-job read card) before flipping.
  supabase_read_job_detail: {
    description: 'Serve the ADMIN single-job GET from Postgres structure + a per-job extras projection (freshness+parity-gated, full Blob fallback) — skips the jobs.json monolith (#152). Dark.',
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

  // Daily ServiceM8 → BuhlOS job sync. A cron pulls the active 'Work Order'
  // jobs from ServiceM8 and auto-creates any missing from BuhlOS, so a field
  // worker is never blocked from logging hours because the office booked the
  // job in ServiceM8 only. Gates the cron run AND the command-centre card.
  // Dark until SERVICEM8_API_KEY is configured and the owner turns it on.
  servicem8_sync: {
    description: 'Daily ServiceM8 job sync — auto-create missing Work Order jobs + command-centre card. Needs SERVICEM8_API_KEY. Dark.',
    default: false,
    target: 'admin-tier',
    expires: '2027-06-30',
  },
  // Phil "sharpened" field-surface redesign (campaign). Re-skins the ratified
  // Phil package in coordinated WAVES behind this dark gate (Wave 1 = design
  // system + global nav; screen re-skins follow). Behavioural change to the
  // ratified Phil package, so it flips ONLY via governance (P15 —
  // docs/phil-governance.md §3): build + preview dark, ratify with field
  // evidence, then flip. Global target — the surface under test is the field
  // worker's, not the admin tier's.
  phil_sharpened: {
    description: "Phil field-surface redesign ('sharpened'): 5-slot global nav (Today·Jobs·Capture·Hours·Gear, account on header avatar) + screen re-skins. Behavioural change to the ratified Phil package — flips only via governance (P15). Dark.",
    default: false,
    target: 'global',
    expires: '2026-12-31',
  },
  // The #133 tabbed-job experiment: four in-page rooms (Now·Work·Proof·Site +
  // Capture) on /phil/jobs/[jobId]. Judged by the tabs criterion
  // (phil-constitution-ratification.md): critical state never hidden behind a
  // tab; interruption recovery ≤1 gesture. Its own flag (separate from
  // phil_sharpened) so the re-skin can ship without the room navigation; the
  // resolver helper (src/lib/phil/sharpened.ts) only turns rooms on when
  // phil_sharpened is also on. Dark until #132/#133 clears it.
  phil_job_rooms: {
    description: 'In-job four-rooms navigation (Now·Work·Proof·Site + Capture) on /phil/jobs/[jobId] — the #133 tabbed-job experiment, judged by the tabs criterion (critical state never hidden; ≤1-gesture recovery). Requires phil_sharpened. Dark.',
    default: false,
    target: 'global',
    expires: '2026-12-31',
  },
  // Xero connection foundation (#247, Epic 8): gates the OAuth connect/callback
  // routes (api/xero/*.js) and the /settings/integrations/xero admin surface.
  // CONNECTION ONLY — no payroll read scopes (#610) and no writes (#249) ride
  // this flag; the write path will get its own independent gate
  // (xero_timesheet_export) so Xero writes can be killed without touching the
  // connection. Admin-tier: the integration is an office concern; Phil renders
  // nothing (payroll-boundary ADR — no field-visible Xero complexity).
  // Default OFF, unset in prod — dark until proven against a test organisation
  // on a preview deploy.
  xero_connection: {
    description: 'Enable the Xero payroll foundation — connection, read-only reference sync, worker + work-type mappings, and the immutable payroll-batch review on /hours/period (#247/#610/#248/#611/#893/#894). No Xero writes exist behind this flag. Dark.',
    default: false,
    target: 'admin-tier',
    expires: '2026-12-31',
  },
  // ── #760: owner feature-control kill-switches (LIVE features, default ON) ──
  // Each gates a whole shipped feature so the owner can hide it from customers
  // (and preview it) from /owner, without a revert deploy. killSwitch:true is the
  // ONLY way a flag defaults on (see docs/feature-flags.md → Two flag kinds).
  // Turning one off hides its nav/section AND 404s its routes + API. Nothing
  // changes until the owner flips it. `jobs`/`hours`/`evidence` are the CORE
  // spine — gateable but the board warns before you turn them off.
  //
  // Lean reset (2026-07) + the gut (2026-07-27): only the lean core keeps a
  // default-ON kill-switch — jobs, hours, evidence, employees, gear, job_photos.
  // Every other shipped feature was hidden by the reset and then DELETED from
  // the tree by the gut (docs/product/02-lean-reset.md → "The gut"); its flag is
  // gone with it. Restore point: the `pre-gut-archive` tag.
  jobs: {
    description: 'CORE. The jobs list + job hub — /v2/jobs + api/jobs. Live; owner kill-switch (turning off hides the whole Jobs surface).',
    default: true, killSwitch: true, target: 'global', expires: '2027-06-30',
  },
  hours: {
    description: 'CORE. The hours workflow — /hours (day/approvals/weekly) + time-entry APIs. Live; owner kill-switch.',
    default: true, killSwitch: true, target: 'global', expires: '2027-06-30',
  },
  evidence: {
    description: 'CORE. Per-job evidence capture + admin review — /v2/jobs/[id]/evidence + api/evidence. Live; owner kill-switch.',
    default: true, killSwitch: true, target: 'global', expires: '2027-06-30',
  },
  employees: {
    description: 'The employees/people admin surface — /employees. Live; owner kill-switch.',
    default: true, killSwitch: true, target: 'global', expires: '2027-06-30',
  },
  gear: {
    description: 'The gear / test-and-tag register — /gear. Live; owner kill-switch.',
    default: true, killSwitch: true, target: 'global', expires: '2027-06-30',
  },

  // NEW build mandated BY the lean reset (step 5): the crew sign-up link,
  // dark until the owner preview-verifies and flips it. (Step 6's itp_simple
  // flag was deleted with the ITP-builder teardown — the job-page rebuild.)
  signup_link: {
    description: 'Crew sign-up link — one shareable /onboarding/<code> URL for the group chat; workers self-signup and are in straight away (instant account + welcome email; gates: link expiry/cap/pause, field roles only, duplicate refusal). Public side api/signup.js, admin side /employees. Dark.',
    default: false,
    target: 'global',
    expires: '2027-06-30',
  },

  // job_photos left the hidden list by owner decision (#916 call 2,
  // 2026-07-18): the gallery completes the capture loop, so it is lean-core —
  // a kill-switch (default ON).
  job_photos: {
    description: 'The read-only job photo gallery ("Job Bible") — /v2/jobs/[id]/photos + /phil/jobs/[id]/photos. Lean-core (capture loop); owner kill-switch.',
    default: true, killSwitch: true, target: 'global', expires: '2027-06-30',
  },
};

// ── Board presentation (#760) ────────────────────────────────────────────────
// Human label + domain + surface for the owner Feature Control Board — kept out
// of the core flag def. Only NON-protected (product) flags appear; protected
// data-plane flags are intentionally omitted (the board shows them in a separate
// read-only "System" group).
// `previewHref` = where the owner clicks "Open to test" on the board. Top-level
// features point at their own route; job-scoped features (sections inside a job)
// point at /v2/jobs — open any job and the section is visible while previewing.
const FLAG_PRESENTATION = {
  signup_link: { label: 'Crew sign-up link', domain: 'Company', surface: 'Shared', previewHref: '/employees' },
  admin_flags_readout: { label: 'Flags readout card', domain: 'Platform', surface: 'BuhlOS', previewHref: '/command-centre' },
  servicem8_sync: { label: 'ServiceM8 job sync', domain: 'Jobs', surface: 'BuhlOS', previewHref: '/command-centre' },
  phil_sharpened: { label: 'Phil sharpened redesign', domain: 'Phil', surface: 'Phil', previewHref: '/phil/my-day' },
  phil_job_rooms: { label: 'Phil in-job rooms (#133)', domain: 'Phil', surface: 'Phil', previewHref: '/phil/jobs' },
  xero_connection: { label: 'Xero connection', domain: 'Platform', surface: 'BuhlOS', previewHref: '/settings/integrations/xero' },
  xero_payroll_export: { label: 'Xero payroll export (draft timesheets)', domain: 'Platform', surface: 'BuhlOS', previewHref: '/hours/period' },

  // #760 kill-switches. `core: true` = load-bearing spine; the board warns
  // before the owner turns one off.
  jobs: { label: 'Jobs', domain: 'Jobs', surface: 'Shared', core: true, previewHref: '/v2/jobs' },
  hours: { label: 'Hours', domain: 'Hours', surface: 'Shared', core: true, previewHref: '/hours' },
  evidence: { label: 'Evidence', domain: 'Field capture', surface: 'Shared', core: true, previewHref: '/v2/jobs' },
  employees: { label: 'Employees', domain: 'People & gear', surface: 'BuhlOS', previewHref: '/employees' },
  gear: { label: 'Gear / test & tag', domain: 'People & gear', surface: 'BuhlOS', previewHref: '/gear' },
  job_photos: { label: 'Photos (Job Bible)', domain: 'Field capture', surface: 'Shared', previewHref: '/v2/jobs' },
};

/** Board presentation (label/domain/surface) for a flag, or null if none. */
function presentationOf(key) {
  return FLAG_PRESENTATION[key] || null;
}

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

// Protected flags are operational data-plane levers (the Supabase migration
// switches + the perf read-path), NOT product features. They must never be
// toggled from the owner UI — only via env/ops. The owner console renders
// them read-only and the write route rejects writes to them (both scopes).
function isProtectedFlag(key) {
  return /^supabase_/.test(String(key)) || key === 'phil_jobs_summary_read';
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
 * Cheap ENV-ONLY enablement check (no blob read), for hot paths that must add
 * ZERO cost when the flag is dark. Returns true only when FLAG_<KEY> is set to a
 * truthy value in the environment; an unset/blob-only override reads as false
 * here. Use for perf gates where paying a flags.json read on every request just
 * to discover "off" would defeat the optimisation. The async isFlagOn (env >
 * blob > default) remains the general path.
 */
function isFlagOnSync(key) {
  return parseEnv(process.env[envName(key)]) === true;
}

/** The owner-preview override for one flag, or undefined if unset. Reads the
 *  same flags.json blob as isFlagOn (rides the 5s TTL cache), so it adds no
 *  network cost; only owner viewers ever reach this. */
async function ownerPreviewOf(key) {
  try {
    const doc = await readBlob(FLAGS_KEY, { flags: {} });
    const v = doc && doc.ownerPreview ? doc.ownerPreview[key] : undefined;
    return typeof v === 'boolean' ? v : undefined;
  } catch {
    return undefined; // Blob unavailable → no preview override.
  }
}

/**
 * Enablement + targeting for a viewer ({ role } or null for anonymous /
 * system callers — who only ever see 'global' flags).
 *
 * Precedence: env wins absolutely (ops kill-switch); else, for the OWNER, an
 * ownerPreview override (if set) beats the customer baseline; else the
 * customer baseline (isFlagOn = blob → default). Targeting (admin-tier) then
 * applies on top of enablement. The owner is always an admin-tier role, so an
 * owner-preview'd admin-tier flag still passes the targeting gate.
 */
async function isFlagEnabled(key, viewer) {
  const def = definitionOf(key);
  const fromEnv = parseEnv(process.env[envName(key)]);
  let enabled;
  if (fromEnv !== null) {
    enabled = fromEnv;
  } else if (viewer && isOwnerRole(viewer.role)) {
    const preview = await ownerPreviewOf(key);
    enabled = preview !== undefined ? preview : await isFlagOn(key);
  } else {
    enabled = await isFlagOn(key);
  }
  if (!enabled) return false;
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
  isFlagOnSync,
  isFlagEnabled,
  flagsForViewer,
  isProtectedFlag,
  presentationOf,
  listFlags,
  expiredFlags,
};
