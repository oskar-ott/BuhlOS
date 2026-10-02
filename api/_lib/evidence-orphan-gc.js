// Evidence / photo blob orphan garbage-collector (FILE-02, part of #152).
//
// THE PROBLEM
//   Photo BYTES live in Vercel Blob under write-once keys
//   (jobs/<jobId>/{photos,snag-photos,evidence-photos,itp-photos,tag-photos}/…).
//   Their OWNING references live in per-job JSON documents (data.json.evidence[],
//   data.json.snags[].photos[], photos-index.json, itps.json, tags.json). There is
//   NO cascade between the two: a reference can be dropped (e.g. the legacy
//   api/photos.js DELETE stripped a photos-index entry without calling del()), and
//   the bytes are then orphaned forever with no reclaim path.
//
// THE DELETE SEMANTICS (why this is a SEPARATE opt-in sweeper, not a live trigger)
//   Evidence records are NEVER hard-deleted today: api/evidence.js has no DELETE
//   and no evidence[].filter removal — a "rejected" item stays in data.json and is
//   restorable (rejected→submitted). So there is no evidence hard-delete to wire a
//   live deleteBlob into, and wiring one into a soft/restorable path would destroy
//   a customer's site photo. Reclamation of EXISTING orphans therefore lives here,
//   entirely behind an explicit opt-in, and identifies an orphan ONLY as a blob
//   with NO live reference ANYWHERE in the job's JSON — the maximally-conservative
//   rule the brief demands. (The one genuine hard-removal path, api/photos.js
//   DELETE, gets a best-effort deleteBlob AFTER its index write commits — see
//   api/photos.js — so it stops MINTING new orphans; this sweeper reclaims the
//   historical backlog.)
//
// SAFETY
//   * DRY-RUN BY DEFAULT. Nothing is deleted unless the caller passes write:true.
//   * A blob is an orphan ONLY when its pathname, its public URL, AND its photoId
//     token are all absent from every reference string harvested from the job's
//     JSON docs. A single match anywhere → LIVE → kept. False-negative bias by
//     construction: we would rather keep an orphan than delete a live photo.
//   * Best-effort deletes: a del() failure is recorded and never throws, so one
//     bad key can't abort the sweep.
//   * Metadata-only cross-reference: we read the small JSON docs, never the
//     multi-MB binaries.

const PHOTO_SUBPREFIXES = [
  'photos/',
  'snag-photos/',
  'evidence-photos/',
  'itp-photos/',
  'tag-photos/',
];

// Per-job JSON documents that can hold a live photo reference. Every string
// value in these docs is harvested into the live-reference set. Keeping this a
// generous superset is the safe direction: an extra doc can only ADD live refs
// (protecting more blobs), never remove them.
const REF_DOC_SUFFIXES = [
  'data.json', // evidence[].photoUrl/thumbnailUrl, snags[].photos[].url, notes
  'photos-index.json', // dwelling/ITP index → per-dwelling photo url + id
  'itps.json', // recorded ITP point photos (photoUrl)
  'tags.json', // test-and-tag photos (tag-photos)
  'certificates.json', // certificate attachment urls, if photo-backed
];

/**
 * Recursively collect every string leaf from a JSON value into `out` (a Set).
 * URLs, ids, pathnames — anything a reference could be expressed as.
 */
function collectStrings(value, out) {
  if (value == null) return;
  if (typeof value === 'string') {
    if (value) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
    return;
  }
  if (typeof value === 'object') {
    for (const k of Object.keys(value)) collectStrings(value[k], out);
  }
}

/**
 * True when `blobPathname` / `blobUrl` is referenced by ANY harvested string.
 * A blob is live if any reference string:
 *   - equals or contains the full pathname (jobs/<id>/photos/<pid>.jpg), OR
 *   - equals or contains the public URL, OR
 *   - contains the photoId token (the trailing filename without extension) —
 *     covers the case where a doc stored the bare id (e.g. evidence.photoId,
 *     photos-index entry.id) rather than the full url.
 * The photoId match requires the token to be non-trivially long so a short,
 * ambiguous fragment can't accidentally "protect" (or, inversely, we never
 * over-delete because a match only ever KEEPS a blob).
 */
function isReferenced(blobPathname, blobUrl, refs) {
  // Full-pathname / full-URL containment.
  for (const ref of refs) {
    if (ref === blobPathname || ref.includes(blobPathname)) return true;
    if (blobUrl && (ref === blobUrl || ref.includes(blobUrl))) return true;
  }
  // photoId token: the filename stem after the last '/', before the extension.
  const file = blobPathname.slice(blobPathname.lastIndexOf('/') + 1);
  const stem = file.includes('.') ? file.slice(0, file.lastIndexOf('.')) : file;
  // itp-photos store as `<pointId>_<photoId>.<ext>`; also probe the trailing id.
  const candidates = new Set([stem]);
  if (stem.includes('_')) candidates.add(stem.slice(stem.lastIndexOf('_') + 1));
  for (const token of candidates) {
    if (token.length < 6) continue; // too short to be a safe unique id
    for (const ref of refs) {
      if (ref.includes(token)) return true;
    }
  }
  return false;
}

/**
 * Sweep one job for orphaned photo blobs.
 *
 * @param {object}   opts
 * @param {string}   opts.jobId
 * @param {boolean} [opts.write=false]  delete orphans (default: dry-run — report only)
 * @param {object}  [deps]  injectable Blob deps (for tests); default to the real SDK/lib
 * @param {(prefix:string)=>Promise<Array<{pathname:string,url:string}>>} [deps.listAll]
 * @param {(key:string, fallback:any)=>Promise<any>} [deps.readBlob]
 * @param {(urls:string[])=>Promise<void>} [deps.del]
 * @returns {Promise<{jobId, scanned, live, orphans:Array, deleted, deleteErrors:Array, write}>}
 */
async function sweepJob({ jobId, write = false }, deps = {}) {
  if (!jobId || typeof jobId !== 'string') {
    throw new Error('sweepJob: jobId (string) is required');
  }
  const { listAll, readBlob, del } = resolveDeps(deps);
  const jobPrefix = `jobs/${jobId}/`;

  // 1. Harvest every live reference string from the job's JSON docs.
  const refs = new Set();
  for (const suffix of REF_DOC_SUFFIXES) {
    let doc;
    try {
      doc = await readBlob(`${jobPrefix}${suffix}`, null);
    } catch {
      // A doc we can't READ is treated as "might reference everything": we skip
      // the sweep-defeating risk by aborting THIS job rather than deleting blobs
      // whose owning doc we failed to load. Fail closed on read failure.
      return {
        jobId,
        scanned: 0,
        live: 0,
        orphans: [],
        deleted: 0,
        deleteErrors: [],
        write,
        aborted: `could not read ${suffix} — skipped job to avoid unsafe delete`,
      };
    }
    if (doc != null) collectStrings(doc, refs);
  }

  // 2. Enumerate candidate photo blobs under the job's photo sub-prefixes.
  const candidates = [];
  for (const sub of PHOTO_SUBPREFIXES) {
    const blobs = await listAll(`${jobPrefix}${sub}`);
    for (const b of blobs) {
      if (b && typeof b.pathname === 'string' && !b.pathname.endsWith('.json')) {
        candidates.push({ pathname: b.pathname, url: b.url });
      }
    }
  }

  // 3. Classify.
  const orphans = [];
  let live = 0;
  for (const c of candidates) {
    if (isReferenced(c.pathname, c.url, refs)) live += 1;
    else orphans.push(c);
  }

  // 4. Reclaim (opt-in only).
  let deleted = 0;
  const deleteErrors = [];
  if (write && orphans.length) {
    for (const o of orphans) {
      try {
        await del([o.url || o.pathname]);
        deleted += 1;
      } catch (e) {
        deleteErrors.push({ pathname: o.pathname, error: (e && e.message) || 'del failed' });
      }
    }
  }

  return {
    jobId,
    scanned: candidates.length,
    live,
    orphans: orphans.map((o) => o.pathname),
    deleted,
    deleteErrors,
    write,
  };
}

/**
 * Sweep every job (jobs.json). Aggregates per-job results. Dry-run by default.
 * @param {object}  [opts]
 * @param {boolean} [opts.write=false]
 * @param {object}  [deps]
 */
async function sweepAll({ write = false } = {}, deps = {}) {
  const { readBlob } = resolveDeps(deps);
  const jobsDoc = await readBlob('jobs.json', null);
  const jobs = jobsDoc && Array.isArray(jobsDoc.jobs) ? jobsDoc.jobs : [];
  const perJob = [];
  let scanned = 0;
  let live = 0;
  let orphanCount = 0;
  let deleted = 0;
  const deleteErrors = [];
  for (const job of jobs) {
    if (!job || !job.id) continue;
    const r = await sweepJob({ jobId: job.id, write }, deps);
    perJob.push(r);
    scanned += r.scanned;
    live += r.live;
    orphanCount += r.orphans.length;
    deleted += r.deleted;
    for (const e of r.deleteErrors) deleteErrors.push({ jobId: job.id, ...e });
  }
  return {
    jobs: jobs.length,
    scanned,
    live,
    orphans: orphanCount,
    deleted,
    deleteErrors,
    write,
    perJob,
  };
}

// Lazy-resolve real Blob deps so tests can inject fakes without loading the SDK.
function resolveDeps(deps) {
  const listAll =
    deps.listAll ||
    (async (prefix) => {
      const { list } = require('@vercel/blob');
      const token = process.env.BLOB_READ_WRITE_TOKEN;
      const out = [];
      let cursor;
      do {
        const page = await list({ prefix, token, limit: 1000, cursor });
        out.push(...(page.blobs || []));
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return out;
    });
  const readBlob = deps.readBlob || require('./blob').readBlob;
  const del =
    deps.del ||
    (async (urls) => {
      const { del: blobDel } = require('@vercel/blob');
      await blobDel(urls, { token: process.env.BLOB_READ_WRITE_TOKEN });
    });
  return { listAll, readBlob, del };
}

module.exports = {
  sweepJob,
  sweepAll,
  // exported for unit tests
  collectStrings,
  isReferenced,
  PHOTO_SUBPREFIXES,
  REF_DOC_SUFFIXES,
};
