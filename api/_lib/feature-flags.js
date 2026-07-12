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
  // Per-job progress claims (#372): gates /api/job-claims (+ /export), the
  // /v2/jobs/[jobId]/claims register + print view, and the job-hub claims card.
  // Claim lines seed from the linked quote's priced lines (where #365/#828
  // imported BOQ lines land) or compiled work packages; evidence links per line;
  // submit freezes; CSV export matches Payapps keying. ADMIN-TIER (billing) and
  // dark by default so the money surface is invisible until proven on preview.
  progress_claims: {
    description: 'Enable per-job progress claims — /api/job-claims + /v2/jobs/[jobId]/claims: lines from BOQ/packages, evidence per line, immutable submit, Payapps-ready CSV (#372). Dark.',
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
  // Per-job variation-claims register (#280): gates the /v2/jobs/[jobId]/variations
  // admin register UI + the observations "Convert to variation claim" promotion
  // (api/variations.js itself stays admin-tier-gated regardless — money is never
  // flag-open). ADMIN-TIER target (not global): claims are billing, an office
  // concern — the LH job hub never advertises the section and the API 403s
  // non-admin anyway. Default OFF.
  variations_register: {
    description: 'Enable the per-job variation-claims register UI — /v2/jobs/[jobId]/variations over api/variations.js (#280). Dark.',
    default: false,
    target: 'admin-tier',
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

  // Per-job site-instructions register (#283): gates /api/site-instructions +
  // the /v2/jobs/[jobId]/instructions admin register. Records builder
  // instructions (who/what/when/channel), a formal acknowledgement back, and a
  // cost/time-implication flag so costed instructions spawn an RFI/variation
  // instead of becoming free work. GLOBAL flag; admin/managing-LH only is
  // enforced in the handler (read admin/LH; write admin). Default OFF.
  site_instructions_register: {
    description: 'Enable the per-job site-instructions register — /api/site-instructions + /v2/jobs/[jobId]/instructions (#283). Dark.',
    default: false,
    target: 'global',
    expires: '2026-12-31',
  },
  // AI assistant foundation (#170, Epic 6): gates /api/ai-assistant — the
  // permission-scoped tool layer's first consumer (the job-summary backend for
  // #173). GLOBAL flag; the handler + tool gates enforce admin/managing-LH
  // (canManageJob) per tool, admin-tier for company-wide tools. No UI yet.
  // Default OFF so the endpoint is invisible until proven on a preview deploy.
  ai_assistant: {
    description: 'Enable the AI assistant endpoint — /api/ai-assistant (permission-scoped tool layer + job summary backend, #170). No UI. Dark.',
    default: false,
    target: 'global',
    expires: '2026-12-31',
  },
  // Standalone AI batch (2026-07): five suggestion features on the #170
  // foundation. All launch-gates, default OFF — AI output is draft/suggested
  // until a human reviews it; the flags keep each surface invisible until
  // proven on a preview deploy. Admin-tier: every one is an office review
  // surface; Phil renders none of them.
  ai_photo_labels: {
    description: 'AI photo classification on the evidence queue — suggested labels with confidence, human correct/override (#262). Dark.',
    default: false,
    target: 'admin-tier',
    expires: '2026-12-31',
  },
  ai_snag_suggestions: {
    description: 'Suggest a snag from photos labelled possible-defect — accept/dismiss in evidence review, snag created only on accept (#267). Dark.',
    default: false,
    target: 'admin-tier',
    expires: '2026-12-31',
  },
  ai_insights_digest: {
    description: 'Weekly plain-English digest of deterministic anomalies, every number grounded in the findings payload (#347). Dark.',
    default: false,
    target: 'admin-tier',
    expires: '2026-12-31',
  },
  ai_quote_drafts: {
    description: 'AI draft quote lines from pasted scope on the v2 builder — per-line accept/edit/discard, nothing enters totals unreviewed (#246). Dark.',
    default: false,
    target: 'admin-tier',
    expires: '2026-12-31',
  },
  ai_contract_obligations: {
    description: 'Extract contract obligations from pasted contract text into a review queue — accepted items become scope clauses (#373). Dark.',
    default: false,
    target: 'admin-tier',
    expires: '2026-12-31',
  },
  ai_office_daily_summary: {
    description: 'Morning summary of yesterday across jobs — deterministic facts (hours/snags/evidence/blockers), AI only rephrases, every number grounded (#171). Dark.',
    default: false,
    target: 'admin-tier',
    expires: '2026-12-31',
  },
  // Epic 5 — AI Drawing Interpretation, foundation slice (#197): gates
  // /api/ai-drawings (page understanding — sheet classification + title-block
  // parse with per-field confidence, behind a human review-and-correct loop)
  // and the sheet-understanding panel on /v2/jobs/[jobId]/documents.
  // Extractions persist in Supabase (first extraction tables); vision spend
  // rides the SHARED per-job AI cap (#510 ledger). Default OFF until proven
  // on a real uploaded drawing set.
  ai_drawings: {
    description: 'Enable AI drawing interpretation — /api/ai-drawings page understanding + the review panel on job documents (#197). Dark.',
    default: false,
    target: 'admin-tier',
    expires: '2026-12-31',
  },
  // BuhlOS Job Builder redesign (campaign). The office job-builder is re-skinned
  // to the Claude-Design prototype in coordinated WAVES; this dark gate lets each
  // redesigned surface be preview-verified before it becomes the admin default
  // (Wave 1 = the New Job screen; cockpit polish + gap steps follow). Admin-only
  // surface. Default OFF. See docs/job-builder-redesign.md.
  job_builder_redesign: {
    description: 'Render the redesigned BuhlOS Job Builder surfaces (Wave 1: New Job; cockpit polish + gap steps follow). Dark. See docs/job-builder-redesign.md.',
    default: false,
    target: 'admin-tier',
    expires: '2026-12-31',
  },
  // Plan Studio — suggest tasks from detected fittings (#213 adjacent): a
  // REVIEW-ONLY proposal of job-level rough-in / fit-off tasks derived from the
  // AI fitting counts. Its OWN flag (separate from ai_drawings) so the
  // rooms→areas bridge ships without the task-suggestion step. Keys off
  // job-level task templates + canonical task identity — never deepens
  // area-owned task arrays (task-led ADR) — and never auto-seeds. Dark.
  ai_plan_tasks: {
    description: 'Suggest job tasks from AI-detected plan fittings — review-only, admin adds them to the job-level task templates (#213). Dark.',
    default: false,
    target: 'admin-tier',
    expires: '2026-12-31',
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
    description: 'Enable the Xero connection + read-only payroll reference sync — api/xero/* + /settings/integrations/xero (#247/#610). No Xero writes exist behind this flag. Dark.',
    default: false,
    target: 'admin-tier',
    expires: '2026-12-31',
  },
  // Per-job ITP / QA (#474/#476): hold/witness/record points + office sign-off.
  // Unlike the registers above, ITPs are ALREADY LIVE — so this is a KILL SWITCH,
  // not a launch gate: default ON (killSwitch:true), and the owner can turn the
  // whole feature OFF from the console. Gates /api/job-itps + /api/itp-templates,
  // the /v2/jobs/[jobId]/itps surface, the Command Centre sign-off card, and the
  // Phil Checks panel.
  itp: {
    description: 'Per-job ITP / QA — hold/witness/record points + office sign-off (#474/#476). Live; owner kill-switch.',
    default: true,
    killSwitch: true,
    target: 'global',
    expires: '2027-06-30',
  },

  // ── #760: owner feature-control kill-switches (LIVE features, default ON) ──
  // Each gates a whole shipped feature so the owner can hide it from customers
  // (and preview it) from /owner, without a revert deploy. killSwitch:true is the
  // ONLY way a flag defaults on (see docs/feature-flags.md → Two flag kinds).
  // Turning one off hides its nav/section AND 404s its routes + API. Nothing
  // changes until the owner flips it. `jobs`/`hours`/`evidence` are the CORE
  // spine — gateable but the board warns before you turn them off.
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
  observations_inbox: {
    description: 'The From-site inbox + per-job observations — /observations + api/observations. Live; owner kill-switch.',
    default: true, killSwitch: true, target: 'global', expires: '2027-06-30',
  },
  material_requests: {
    description: 'Field-to-office material requests — /material-requests + per-job register + api/material-requests. Live; owner kill-switch.',
    default: true, killSwitch: true, target: 'global', expires: '2027-06-30',
  },
  expenses: {
    description: 'Reimbursements — field receipts the office reviews — /expenses + api/expenses. Live; owner kill-switch.',
    default: true, killSwitch: true, target: 'global', expires: '2027-06-30',
  },
  quotes: {
    description: 'The quote builder — /v2/quotes + api/quotes. Live; owner kill-switch.',
    default: true, killSwitch: true, target: 'global', expires: '2027-06-30',
  },
  defects: {
    description: 'The cross-job defects register — /defects. Live; owner kill-switch.',
    default: true, killSwitch: true, target: 'global', expires: '2027-06-30',
  },
  dayworks: {
    description: 'The daywork dockets register — /v2/dayworks + per-job dayworks + api/dayworks. Live; owner kill-switch.',
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
  reports: {
    description: 'The owner-numbers reports surface — /reports. Live; owner kill-switch.',
    default: true, killSwitch: true, target: 'global', expires: '2027-06-30',
  },
  job_photos: {
    description: 'The read-only job photo gallery ("Job Bible") — /v2/jobs/[id]/photos. Live; owner kill-switch.',
    default: true, killSwitch: true, target: 'global', expires: '2027-06-30',
  },
  snags: {
    description: 'Per-job snags/defects raised by the field — /v2/jobs/[id]/snags + api/snags. Live; owner kill-switch.',
    default: true, killSwitch: true, target: 'global', expires: '2027-06-30',
  },
  scope_reconciliation: {
    description: 'Scope-vs-quote reconciliation — /v2/jobs/[id]/scope. Live; owner kill-switch.',
    default: true, killSwitch: true, target: 'global', expires: '2027-06-30',
  },
  job_control: {
    description: 'Required-proof authoring (job control) — /v2/jobs/[id]/job-control. Live; owner kill-switch.',
    default: true, killSwitch: true, target: 'global', expires: '2027-06-30',
  },
  closeout: {
    description: 'The handover closeout matrix — /v2/jobs/[id]/closeout. Live; owner kill-switch.',
    default: true, killSwitch: true, target: 'global', expires: '2027-06-30',
  },
  documents: {
    description: 'The per-job document & specs register — /v2/jobs/[id]/documents + api/documents. Live; owner kill-switch.',
    default: true, killSwitch: true, target: 'global', expires: '2027-06-30',
  },
  circuit_schedule: {
    description: 'AS/NZS-3000 circuit schedules — /v2/jobs/[id]/circuit-schedule + api/job-circuits. Live; owner kill-switch.',
    default: true, killSwitch: true, target: 'global', expires: '2027-06-30',
  },
  diary: {
    description: 'The per-job site diary — /v2/jobs/[id]/diary + api/diary. Live; owner kill-switch.',
    default: true, killSwitch: true, target: 'global', expires: '2027-06-30',
  },
  job_activity: {
    description: 'The per-job activity/audit trail — /v2/jobs/[id]/history. Live; owner kill-switch.',
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
  itp: { label: 'ITPs', domain: 'QA & compliance', surface: 'Shared', previewHref: '/itp-templates' },
  rfi_register: { label: 'RFIs', domain: 'QA & compliance', surface: 'Shared', previewHref: '/v2/jobs' },
  certificates_register: { label: 'Certificates', domain: 'QA & compliance', surface: 'BuhlOS', previewHref: '/v2/jobs' },
  safety_docs: { label: 'Safety docs (SWMS/SDS)', domain: 'QA & compliance', surface: 'Shared', previewHref: '/v2/jobs' },
  admin_proof_review: { label: 'Proof sign-off', domain: 'QA & compliance', surface: 'BuhlOS', previewHref: '/command-centre' },
  minutes_register: { label: 'Meeting minutes', domain: 'Site records', surface: 'BuhlOS', previewHref: '/v2/jobs' },
  site_instructions_register: { label: 'Site instructions', domain: 'Site records', surface: 'BuhlOS', previewHref: '/v2/jobs' },
  job_doc_import: { label: 'BOQ / pricing import', domain: 'Commercial', surface: 'BuhlOS', previewHref: '/v2/tools/job-doc-import' },
  variations_register: { label: 'Variation claims', domain: 'Commercial', surface: 'BuhlOS', previewHref: '/v2/jobs' },
  progress_claims: { label: 'Progress claims', domain: 'Commercial', surface: 'BuhlOS', previewHref: '/v2/jobs' },
  admin_job_field_view: { label: 'Office / Field job view', domain: 'Jobs', surface: 'BuhlOS', previewHref: '/v2/jobs' },
  admin_flags_readout: { label: 'Flags readout card', domain: 'Platform', surface: 'BuhlOS', previewHref: '/command-centre' },
  ai_assistant: { label: 'AI assistant (API foundation)', domain: 'Platform', surface: 'BuhlOS', previewHref: '/v2/jobs' },
  ai_photo_labels: { label: 'AI photo labels', domain: 'Field capture', surface: 'BuhlOS', previewHref: '/v2/jobs' },
  ai_snag_suggestions: { label: 'AI snag suggestions', domain: 'Field capture', surface: 'BuhlOS', previewHref: '/v2/jobs' },
  ai_insights_digest: { label: 'AI insights digest', domain: 'Company', surface: 'BuhlOS', previewHref: '/reports' },
  ai_quote_drafts: { label: 'AI quote drafts', domain: 'Commercial', surface: 'BuhlOS', previewHref: '/v2/quotes' },
  ai_contract_obligations: { label: 'AI contract obligations', domain: 'Jobs', surface: 'BuhlOS', previewHref: '/v2/jobs' },
  ai_office_daily_summary: { label: 'AI office daily summary', domain: 'Company', surface: 'BuhlOS', previewHref: '/reports' },
  ai_drawings: { label: 'AI drawings — sheet understanding', domain: 'Jobs', surface: 'BuhlOS', previewHref: '/v2/jobs' },
  job_builder_redesign: { label: 'Job Builder redesign', domain: 'Jobs', surface: 'BuhlOS', previewHref: '/v2/jobs/new' },
  ai_plan_tasks: { label: 'AI plan tasks from fittings', domain: 'Jobs', surface: 'BuhlOS', previewHref: '/v2/jobs' },
  phil_sharpened: { label: 'Phil sharpened redesign', domain: 'Phil', surface: 'Phil', previewHref: '/phil/my-day' },
  phil_job_rooms: { label: 'Phil in-job rooms (#133)', domain: 'Phil', surface: 'Phil', previewHref: '/phil/jobs' },
  xero_connection: { label: 'Xero connection', domain: 'Platform', surface: 'BuhlOS', previewHref: '/settings/integrations/xero' },

  // #760 kill-switches. `core: true` = load-bearing spine; the board warns
  // before the owner turns one off.
  jobs: { label: 'Jobs', domain: 'Jobs', surface: 'Shared', core: true, previewHref: '/v2/jobs' },
  hours: { label: 'Hours', domain: 'Hours', surface: 'Shared', core: true, previewHref: '/hours' },
  evidence: { label: 'Evidence', domain: 'Field capture', surface: 'Shared', core: true, previewHref: '/v2/jobs' },
  observations_inbox: { label: 'From site (observations)', domain: 'Field capture', surface: 'Shared', previewHref: '/observations' },
  material_requests: { label: 'Material requests', domain: 'Commercial', surface: 'Shared', previewHref: '/material-requests' },
  expenses: { label: 'Expenses', domain: 'Commercial', surface: 'Shared', previewHref: '/expenses' },
  quotes: { label: 'Quotes', domain: 'Commercial', surface: 'BuhlOS', previewHref: '/v2/quotes' },
  defects: { label: 'Defects', domain: 'QA & compliance', surface: 'BuhlOS', previewHref: '/defects' },
  dayworks: { label: 'Dayworks', domain: 'Commercial', surface: 'BuhlOS', previewHref: '/v2/dayworks' },
  employees: { label: 'Employees', domain: 'People & gear', surface: 'BuhlOS', previewHref: '/employees' },
  gear: { label: 'Gear / test & tag', domain: 'People & gear', surface: 'BuhlOS', previewHref: '/gear' },
  reports: { label: 'Reports', domain: 'Company', surface: 'BuhlOS', previewHref: '/reports' },
  job_photos: { label: 'Photos (Job Bible)', domain: 'Field capture', surface: 'Shared', previewHref: '/v2/jobs' },
  snags: { label: 'Snags', domain: 'Field capture', surface: 'Shared', previewHref: '/v2/jobs' },
  scope_reconciliation: { label: 'Scope reconciliation', domain: 'Jobs', surface: 'BuhlOS', previewHref: '/v2/jobs' },
  job_control: { label: 'Job control (required proof)', domain: 'Jobs', surface: 'Shared', previewHref: '/v2/jobs' },
  closeout: { label: 'Closeout', domain: 'QA & compliance', surface: 'BuhlOS', previewHref: '/v2/jobs' },
  documents: { label: 'Documents & specs', domain: 'Site records', surface: 'Shared', previewHref: '/v2/jobs' },
  circuit_schedule: { label: 'Circuit schedules', domain: 'QA & compliance', surface: 'Shared', previewHref: '/v2/jobs' },
  diary: { label: 'Site diary', domain: 'Site records', surface: 'BuhlOS', previewHref: '/v2/jobs' },
  job_activity: { label: 'Activity (audit trail)', domain: 'Platform', surface: 'BuhlOS', previewHref: '/v2/jobs' },
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
