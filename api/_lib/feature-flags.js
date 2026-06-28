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
  // Office "Field view" of a job (mobile-admin redesign): when on, the admin
  // job hub (/v2/jobs/[jobId]) offers an Office/Field segmented toggle whose
  // Field view is a READ-ONLY admin render of the Phil job command model (what
  // the crew sees on site). Admin-tier; resolved server-side and passed down as
  // a boolean (the client never reads the flag). Default OFF, unset in prod.
  admin_job_field_view: {
    description: 'Show the Office/Field view toggle + read-only Phil job render on /v2/jobs/[jobId] (mobile-admin redesign).',
    default: false,
    target: 'admin-tier',
    expires: '2026-09-25',
  },
  // Office "Proof to sign off" (#503): when on, the cross-job submitted-proof
  // queue (a Command Centre card + an Approvals view) and the approve /
  // send-back surface are shown to the admin tier, wired to the EXISTING
  // proof-review engine. Admin-tier; resolved server-side. Default OFF, unset
  // in prod. Gates only the OFFICE surface — the Phil submit path stays live.
  admin_proof_review: {
    description: 'Show the office Proof-to-sign-off approve/send-back surface + Command Centre queue (#503).',
    default: false,
    target: 'admin-tier',
    expires: '2026-09-25',
  },
  // Read-only pricing/BOQ workbook import PREVIEW (#365 first increment): gates
  // POST /api/job-doc-import + the /v2/tools/job-doc-import admin page. Parses an
  // uploaded .xlsx pricing sheet into a structured, reviewable BOQ (lines +
  // commercial reconciliation + ambiguity flags) and RETURNS it. It writes NO
  // job/quote/material/blob — turning a reviewed preview into job data is a later
  // slice (gated on #479). Admin-tier; dark by default so the surface is invisible
  // until proven on a preview deploy.
  job_doc_import: {
    description: 'Enable the read-only pricing/BOQ workbook import preview — POST /api/job-doc-import + /v2/tools/job-doc-import (#365). Writes nothing. Dark.',
    default: false,
    target: 'admin-tier',
    expires: '2026-12-31',
  },
  // Safety documents on the job + acknowledge-read in Phil (#219): gates
  // /api/safety-docs, the /v2/jobs/[jobId]/safety admin sub-route, and the Phil
  // Safety section/route. GLOBAL (not admin-tier) so assigned field crew can see
  // and acknowledge their SWMS/SDS once it's on — admin-only upload is enforced
  // in the handler, not by the flag. Default OFF; the Phil home hides the section
  // until real (presence-gated, no flag read on the LCP path).
  safety_docs: {
    description: 'Enable safety documents (SWMS/SDS) on the job with acknowledge-read in Phil — /api/safety-docs + /v2/jobs/[jobId]/safety + Phil Safety section (#219). Dark.',
    default: false,
    target: 'global',
    expires: '2026-12-31',
  },
  // Commissioning documents + certificates register (#231): gates /api/certificates,
  // the /v2/jobs/[jobId]/certificates admin register, and the Phil read-only certs
  // section. GLOBAL so assigned crew see the read-only list once on; admin-only
  // upload is enforced in the handler. Default OFF.
  certificates_register: {
    description: 'Enable the commissioning documents + certificates register — /api/certificates + /v2/jobs/[jobId]/certificates + Phil read-only certs (#231). Dark.',
    default: false,
    target: 'global',
    expires: '2026-12-31',
  },
  // Per-job RFI register (#276): gates /api/rfis + the /v2/jobs/[jobId]/rfis admin
  // register (raise / send / answer / close). GLOBAL flag; admin/managing-LH only
  // is enforced in the handler (RFIs are office-side — the field raises questions
  // via the Phil observation chip). Default OFF.
  rfi_register: {
    description: 'Enable the per-job RFI register — /api/rfis + /v2/jobs/[jobId]/rfis (#276). Dark.',
    default: false,
    target: 'global',
    expires: '2026-12-31',
  },
  // Per-job meeting-minutes register (#217): gates /api/job-minutes + the
  // /v2/jobs/[jobId]/minutes admin register (record minutes / add amendment).
  // An append-only record of meeting minutes (date, title, attendees, body
  // and/or a PDF attachment) with stamped amendments — the original is never
  // mutated. GLOBAL flag; admin/managing-LH only is enforced in the handler
  // (read admin/LH; write admin). Default OFF.
  minutes_register: {
    description: 'Enable the per-job meeting-minutes register — /api/job-minutes + /v2/jobs/[jobId]/minutes (#217). Dark.',
    default: false,
    target: 'global',
    expires: '2026-12-31',
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
  isFlagOnSync,
  isFlagEnabled,
  flagsForViewer,
  listFlags,
  expiredFlags,
};
