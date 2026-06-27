// Evidence-metadata dual-write mirror (#152). Best-effort, Blob-authoritative.
//
// Reconciles per-job blob evidence (data.json.evidence[]) into Postgres
// evidence_files + evidence_links, delivered OFF the request path by the scheduled
// cron (api/internal/mirror-evidence) — exactly the J9 task-mirror pattern. The
// field CAPTURE write path (api/evidence.js) is UNCHANGED: it still writes only to
// Blob (zero added latency), and this async worker drains it. This closes the gap
// the evidence read overlay had: without a mirror, captured evidence never reached
// PG and the overlay Blob-fell-back for those jobs.
//
// Reuses the importer's ONE writer (scripts/importers/lib/evidence-writer.writeEvidence)
// so the operator import and this mirror can never diverge. Idempotent (upsert with
// IS DISTINCT FROM + links DO NOTHING → a re-run with no change writes 0 rows).
//
// Triple-gated so production is inert: no SUPABASE_DB_URL → skip;
// supabase_dual_write_evidence flag off (default) → skip; getDb({mode:'write'})
// runs the env guard. metadata only — binaries stay in Blob.
//
// QUARANTINE is all-or-nothing for the batch (the importer's fail-closed writer
// rolls back the whole tx on any unresolvable coordinate). The mirror does NOT
// crash on it — it reports {quarantined} and writes nothing that run (Blob stays
// authoritative; the structure drift-check + evidence read probe surface the gap).
// This is rare (an unresolvable coordinate means structure isn't mirrored for that
// job); fix by mirroring structure first.

const { isFlagOn } = require('./feature-flags');
const { getDb } = require('./supabase-db');
const { writeEvidence, QuarantineError } = require('../../scripts/importers/lib/evidence-writer');

const DATA_CONCURRENCY = 8;

function realReadBlob(key, fallback) {
  return require('./blob').readBlob(key, fallback);
}

// Load jobs.json + every per-job data.json (the evidence writer's `sources` shape).
async function loadSources(readBlob) {
  const jobs = await readBlob('jobs.json', null);
  const jobData = {};
  const ids = (jobs && Array.isArray(jobs.jobs) ? jobs.jobs : []).filter((j) => j && j.id).map((j) => j.id);
  for (let i = 0; i < ids.length; i += DATA_CONCURRENCY) {
    const chunk = ids.slice(i, i + DATA_CONCURRENCY);
    const results = await Promise.all(chunk.map((id) => readBlob(`jobs/${id}/data.json`, null)));
    chunk.forEach((id, idx) => { jobData[id] = results[idx]; });
  }
  return { jobs, jobData };
}

/**
 * Reconcile ALL jobs' evidence metadata into Postgres. Best-effort — never throws.
 * Triple-gated (env + flag + write guard). Quarantine → reported, not thrown.
 * Injectable deps for tests.
 */
async function mirrorEvidenceIfEnabled(deps = {}) {
  const flagOn = deps.isFlagOn || isFlagOn;
  const db = deps.getDb || getDb;
  const readBlob = deps.readBlob || realReadBlob;
  const write = deps.writeEvidence || writeEvidence;
  const tenantSlug = deps.tenantSlug || 'buhl';
  const startedMs = deps.nowMs ? deps.nowMs() : Date.now();

  if (!process.env.SUPABASE_DB_URL) return { ran: false, reason: 'no supabase env' };
  if (!(await flagOn('supabase_dual_write_evidence'))) return { ran: false, reason: 'flag off' };

  const sql = db({ mode: 'write' }); // env guard runs here; fail-closed
  const sources = await loadSources(readBlob);

  try {
    const result = await write(sql, sources);
    return {
      ran: true,
      evidenceInserted: result.evidence.inserted,
      evidenceUpdated: result.evidence.updated,
      evidenceUnchanged: result.evidence.unchanged,
      linksInserted: result.links.inserted,
      after: result.after,
      latencyMs: (deps.nowMs ? deps.nowMs() : Date.now()) - startedMs,
    };
  } catch (err) {
    if (err instanceof QuarantineError) {
      // Fail-closed batch: nothing written. Report so the cron shows it; never crash.
      return { ran: true, quarantined: err.quarantine.length, wrote: false, latencyMs: (deps.nowMs ? deps.nowMs() : Date.now()) - startedMs };
    }
    throw err;
  }
}

/** Best-effort wrapper — NEVER throws (the cron stays green; Blob authoritative). */
async function mirrorEvidence(deps = {}) {
  try {
    return await mirrorEvidenceIfEnabled(deps);
  } catch (err) {
    console.error('[evidence-mirror] mirror run failed (best-effort, Blob authoritative):', err && err.message ? err.message : err);
    return { ran: false, reason: 'error', error: err && err.message ? err.message : String(err) };
  }
}

module.exports = { mirrorEvidenceIfEnabled, mirrorEvidence, loadSources };
