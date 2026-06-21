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
const { getDb } = require('./supabase-db');
const { loadJobStructureFromPg } = require('./job-read-projection');

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

module.exports = { probeEvidenceReadParity, compareEvidence };
