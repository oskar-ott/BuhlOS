// Evidence-metadata read-cutover READINESS probe (#152). DARK, read-only,
// diagnostics-only — there is NO served overlay in this slice.
//
// Follows the proof/evidence read-cutover audit decision
// (docs/architecture/proof-evidence-read-cutover-audit.md): EVIDENCE METADATA
// (jobs/{jobId}/data.json.evidence[]) has a Postgres home (evidence_files +
// evidence_links, J4) and an inverse projection already exists
// (api/_lib/job-read-projection.js). This probe MEASURES how faithful that PG
// mirror is to Blob across a bounded sample of jobs, so a future dark evidence
// read overlay can be gated on real readiness evidence — exactly the J12
// task-status probe (probeTaskReadParity) pattern, applied to evidence.
//
// Scope (hard): evidence METADATA only. PROOF-STATUS (job-control.json:
// requiredEvidence/evidenceLinks/proofReviews/workPackages) is Blob-only with NO
// PG table and is NOT touched here. Read-only (getDb({mode:'read'})), best-effort
// (never throws into a route), no flag, no serving change, Blob authoritative.
//
// Parity is NORMALISED, not byte-identical: we compare only the migrated, stable
// identity/classification/state fields and DELIBERATELY EXCLUDE volatile or
// sensitive data — photo/thumbnail Blob URLs and photo ids (refs/bytes), the note
// body, capturedBy/reviewedBy labels + ids (lossy: PG nulls the id and keeps a
// label when the user is unresolved; Blob nests capturedBy differently), exif
// coords, and all timestamps (::text format differs). The probe output is COUNTS
// and BOOLEANS only — never an evidence URL, note body, or any field value.

const crypto = require('node:crypto');
const { isFlagOn } = require('./feature-flags');
const { getDb } = require('./supabase-db');
const { loadJobStructureFromPg, reconstructFromPg } = require('./job-read-projection');

function realReadBlob(key, fallback) {
  return require('./blob').readBlob(key, fallback);
}

// The migrated, stable evidence fields we compare. Everything else is excluded
// (see header) — bytes, URLs, note body, labels, timestamps, exif.
const COMPARE_FIELDS = ['kind', 'areaId', 'stage', 'taskId', 'status', 'source'];

function norm(v) {
  return v === undefined || v === '' ? null : v;
}
// sha256 over the COMPARE_FIELDS of one evidence item — order-fixed, null-normalised.
function evidenceSig(item) {
  const picked = COMPARE_FIELDS.map((f) => `${f}=${JSON.stringify(norm(item ? item[f] : null))}`);
  return crypto.createHash('sha256').update(picked.join('|')).digest('hex');
}

/**
 * Compare one job's Blob evidence[] against its reconstructed-from-PG evidence[].
 * Matches by evidence `id`; compares only COMPARE_FIELDS. Returns counts only.
 */
function compareEvidence(blobEv = [], pgEv = []) {
  const blobById = new Map();
  for (const e of blobEv) if (e && e.id != null) blobById.set(e.id, evidenceSig(e));
  const pgById = new Map();
  for (const e of pgEv) if (e && e.id != null) pgById.set(e.id, evidenceSig(e));

  let matched = 0, mismatched = 0, missingInPg = 0, missingInBlob = 0;
  for (const [id, sig] of blobById) {
    if (!pgById.has(id)) missingInPg += 1;
    else if (pgById.get(id) === sig) matched += 1;
    else mismatched += 1;
  }
  for (const id of pgById.keys()) if (!blobById.has(id)) missingInBlob += 1;
  return { matched, mismatched, missingInPg, missingInBlob };
}

const PROBE_SAMPLE_LIMIT = 25; // bounded so the admin probe stays cheap; jobsTotal vs jobsSampled makes truncation visible.

/**
 * Evidence-metadata cutover READINESS probe. Read-only, best-effort, never throws.
 * Reconstructs PG evidence via the proven inverse projection, then compares a
 * bounded sample of jobs' Blob evidence[] to it under NORMALISED parity. Nothing
 * is served and nothing is written. Returns counts + booleans only.
 *
 * Per sampled job:
 *   - not in the PG reconstruction       → unavailable (job not mirrored)
 *   - evidence matches (no drift)         → faithful
 *   - any mismatch / missing either side  → drifted
 * `readyForOverlay` is the strict gate a future dark overlay would want: every
 * sampled job faithful, none drifted/unavailable/errored. Injectable deps for tests.
 */
async function probeEvidenceReadParity(input = {}) {
  const {
    getDb: db = getDb,
    readBlob = realReadBlob,
    tenantSlug = 'buhl',
    now = Date.now,
    sampleLimit = PROBE_SAMPLE_LIMIT,
    loadStructure = loadJobStructureFromPg, // injectable: reuses the ONE inverse projection
  } = input;
  const started = now();
  const elapsed = () => Math.max(0, now() - started);
  const base = (over = {}) => ({
    available: true, jobsTotal: 0, jobsSampled: 0,
    faithful: 0, drifted: 0, unavailable: 0,
    matchedEvidence: 0, mismatchedEvidence: 0, missingInPg: 0, missingInBlob: 0,
    readyForOverlay: false, latencyMs: elapsed(), fallbackReason: null, ...over,
  });

  if (!process.env.SUPABASE_DB_URL) return base({ available: false, fallbackReason: 'no supabase env' });
  try {
    const sql = db({ mode: 'read' }); // readiness probe — never a write
    const tenant = await sql`select id from public.tenants where slug = ${tenantSlug}`;
    if (!tenant.length) return base({ fallbackReason: 'no tenant' });

    const recon = await loadStructure(sql, tenant[0].id); // { jobs: { jobs }, jobData }
    const pgJobIds = new Set(((recon && recon.jobs && recon.jobs.jobs) || []).map((j) => j.id));
    const jobData = (recon && recon.jobData) || {};

    const jobsBlob = await readBlob('jobs.json', { jobs: [] });
    const allJobs = (jobsBlob.jobs || []).filter((j) => j && j.id);
    const sample = allJobs.slice(0, Math.max(0, sampleLimit));

    const agg = { faithful: 0, drifted: 0, unavailable: 0, matchedEvidence: 0, mismatchedEvidence: 0, missingInPg: 0, missingInBlob: 0 };
    for (const job of sample) {
      if (!pgJobIds.has(job.id)) { agg.unavailable += 1; continue; } // job not mirrored to PG
      const data = await readBlob(`jobs/${job.id}/data.json`, { dwellings: {}, snags: [], notes: [], evidence: [] });
      const blobEv = Array.isArray(data.evidence) ? data.evidence : [];
      const pgEv = (jobData[job.id] && jobData[job.id].evidence) || [];
      const c = compareEvidence(blobEv, pgEv);
      agg.matchedEvidence += c.matched;
      agg.mismatchedEvidence += c.mismatched;
      agg.missingInPg += c.missingInPg;
      agg.missingInBlob += c.missingInBlob;
      if (c.mismatched === 0 && c.missingInPg === 0 && c.missingInBlob === 0) agg.faithful += 1;
      else agg.drifted += 1;
    }
    const readyForOverlay = sample.length > 0 && agg.drifted === 0 && agg.unavailable === 0;
    return base({ jobsTotal: allJobs.length, jobsSampled: sample.length, readyForOverlay, ...agg });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn('[evidence-read] readiness probe failed (best-effort):', msg);
    return base({ fallbackReason: 'error', error: msg });
  }
}

// ── Admin evidence-metadata READ OVERLAY (dark, parity-gated, Blob fallback) ──
//
// The first SERVED read overlay for evidence, ADMIN-tier only, behind
// supabase_read_admin_evidence (default OFF). Mirrors the J11 admin task-status
// overlay: at the /api/data admin seam, the job's evidence[] is confirmed against
// the PG evidence_files mirror and, ONLY on a clean per-job parity PASS, the
// migrated fields are sourced from PG onto the EXISTING Blob evidence items in
// place. Because PASS means those fields are already byte-equal to Blob, the
// overlay is a no-op on the served bytes — output is byte-identical to Blob. It
// NEVER adds/removes an evidence item, never touches non-evidence sections
// (dwellings/snags/notes), never serves the EXCLUDED fields from PG (note body,
// URLs, labels, timestamps stay Blob), and never writes. Best-effort → Blob.
//
// Scope: evidence METADATA only. Proof-status (job-control.json) is untouched.
// Photo bytes stay in Vercel Blob. Phil/client reads are unchanged (admin-first).

const EV_BLOB_DIAG = (reason, latencyMs, flagOn) => ({
  source: 'blob', reason, flagOn: flagOn === true, parityPass: null,
  matched: 0, mismatched: 0, missingInPg: 0, missingInBlob: 0,
  latencyMs, fallbackUsed: false, error: null,
});

// One job's evidence rows, reconstructed into the Blob shape via the ONE inverse
// projection (reconstructFromPg) — same column list as the tenant-wide query in
// job-read-projection.js loadJobStructureFromPg, scoped to a single job.
async function reconstructJobEvidence(sql, tenantId, jobId, jobUuid) {
  const rows = await sql`
    select ef.legacy_id, jb.legacy_id as job_legacy, ar.legacy_id as area_legacy,
           tk.legacy_template_id as task_legacy_template_id, ef.kind, ef.photo_blob_id, ef.blob_url,
           ef.thumbnail_url, ef.note, ef.stage, cu.legacy_user_id as captured_by_legacy, ef.captured_by_label,
           ef.captured_at::text as captured_at, ef.client_captured_at::text as client_captured_at,
           ef.exif_lat, ef.exif_lng, ef.status, ef.source, ru.legacy_user_id as reviewed_by_legacy,
           ef.reviewed_by_label, ef.reviewed_at::text as reviewed_at, ef.rejection_reason, ef.created_at::text as created_at
    from public.evidence_files ef join public.jobs jb on jb.id = ef.job_id
    left join public.site_areas ar on ar.id = ef.site_area_id
    left join public.tasks tk on tk.id = ef.task_id
    left join public.user_profiles cu on cu.id = ef.captured_by
    left join public.user_profiles ru on ru.id = ef.reviewed_by
    where ef.tenant_id = ${tenantId} and ef.job_id = ${jobUuid} and ef.legacy_id is not null and ef.deleted_at is null
    order by ef.created_at, ef.legacy_id`;
  const recon = reconstructFromPg({ jobs: [{ legacy_id: jobId }], evidence: rows });
  return (recon.jobData[jobId] && recon.jobData[jobId].evidence) || [];
}

/**
 * Parity-gated PG evidence-metadata read for ONE job. Returns { data, diag }. The
 * data is byte-identical to Blob; on a clean PASS the migrated evidence fields are
 * sourced from PG onto the EXISTING items (a no-op, since PASS ⇒ equal). Best-effort
 * — never throws. flagKey is pinned by the audience wrapper (caller can't spoof it).
 */
async function readEvidenceOverlay(input = {}) {
  const { jobId, data, getDb: db = getDb, isFlagOn: flagOn = isFlagOn, tenantSlug = 'buhl', now = Date.now, flagKey } = input;
  const started = now();
  const elapsed = () => Math.max(0, now() - started);

  if (!process.env.SUPABASE_DB_URL) return { data, diag: EV_BLOB_DIAG('no supabase env', elapsed(), false) };
  let flagIsOn = false;
  try {
    flagIsOn = (await flagOn(flagKey)) === true;
    if (!flagIsOn) return { data, diag: EV_BLOB_DIAG('flag off', elapsed(), false) };

    const sql = db({ mode: 'read' }); // read cutover — never a write
    const tenant = await sql`select id from public.tenants where slug = ${tenantSlug}`;
    if (!tenant.length) return { data, diag: { ...EV_BLOB_DIAG('no tenant', elapsed(), true), fallbackUsed: true } };
    const tenantId = tenant[0].id;
    const jobUuid = (await sql`select id from public.jobs where tenant_id = ${tenantId} and legacy_id = ${jobId} and deleted_at is null`)[0];
    if (!jobUuid) return { data, diag: { ...EV_BLOB_DIAG('job not in pg', elapsed(), true), fallbackUsed: true } };

    const pgEvidence = await reconstructJobEvidence(sql, tenantId, jobId, jobUuid.id);
    const blobEvidence = Array.isArray(data.evidence) ? data.evidence : [];
    const c = compareEvidence(blobEvidence, pgEvidence);
    const pass = c.mismatched === 0 && c.missingInPg === 0 && c.missingInBlob === 0;

    if (!pass) {
      return { data, diag: { ...EV_BLOB_DIAG('parity mismatch → blob', elapsed(), true), parityPass: false, ...c, fallbackUsed: true } };
    }

    // PASS: source the migrated fields from PG onto the EXISTING evidence items in
    // place (never add/remove an item; never touch excluded fields or other
    // sections). PASS ⇒ those fields already equal Blob, so output == Blob.
    const out = JSON.parse(JSON.stringify(data));
    const pgById = new Map();
    for (const e of pgEvidence) if (e && e.id != null) pgById.set(e.id, e);
    for (const item of Array.isArray(out.evidence) ? out.evidence : []) {
      const pg = item && item.id != null ? pgById.get(item.id) : null;
      if (!pg) continue;
      for (const f of COMPARE_FIELDS) if (Object.prototype.hasOwnProperty.call(item, f)) item[f] = pg[f];
    }
    return { data: out, diag: { source: 'postgres', reason: 'served from postgres', flagOn: true, parityPass: true, ...c, latencyMs: elapsed(), fallbackUsed: false, error: null } };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn('[evidence-read] PG evidence read failed (Blob authoritative):', msg);
    return { data, diag: { ...EV_BLOB_DIAG('error', elapsed(), flagIsOn), fallbackUsed: flagIsOn === true, error: msg } };
  }
}

// Audience wrappers — each pins its evidence flag. Passing `flagKey` in `input`
// is ignored (the wrapper overrides it), so the audience can never be spoofed.
// Same parity engine for both; only the flag (and the call-site role gate) differ.
function readAdminEvidence(input = {}) {
  return readEvidenceOverlay({ ...input, flagKey: 'supabase_read_admin_evidence' });
}
function readPhilEvidence(input = {}) {
  return readEvidenceOverlay({ ...input, flagKey: 'supabase_read_phil_evidence' });
}

// readEvidenceOverlay is INTENTIONALLY not exported — callers use the audience
// wrappers (which pin the flag). Same guardrail as task-read.js.
module.exports = { probeEvidenceReadParity, compareEvidence, readAdminEvidence, readPhilEvidence };
