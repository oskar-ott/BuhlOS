// Workflow validation for stage transitions. Central place where BuhlOS
// decides whether a stage can move to a given status. Returns either
// { ok: true } or { ok: false, error: '<reason_code>', missing?: {...} }.
//
// Reason codes (must match the strings Phil maps to plain site language):
//   photo_required, note_required, itp_required,
//   review_required, self_review_blocked,
//   job_closed, defect_open, permission_denied,
//   superseded_plan, gear_not_returned

const { list } = require('@vercel/blob');
const { readBlob } = require('./blob');
const { withRichStages, findStageInJob } = require('./stages');
const { normaliseStageStatus } = require('./status');

const token = () => process.env.BLOB_READ_WRITE_TOKEN;

function eq(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }

// Build a list of names that should be treated as the same stage. We accept
// either a rich stage object (preferred) or a string name (back-compat).
function stageAliases(stageOrName) {
  if (!stageOrName) return [];
  if (typeof stageOrName === 'string') return [stageOrName];
  const out = [];
  if (stageOrName.name) out.push(stageOrName.name);
  if (stageOrName.id)   out.push(stageOrName.id);
  if (Array.isArray(stageOrName.legacyNames)) out.push(...stageOrName.legacyNames);
  return out;
}
// Does this stored row (photo meta, note, snag) refer to the given stage,
// considering id / name / legacy aliases?
function stageMatches(row, stage) {
  const aliases = stageAliases(stage);
  if (!aliases.length) return false;
  const cand = [row && row.stage, row && row.stageId, row && row.stageName].filter(Boolean);
  return cand.some(c => aliases.some(a => eq(a, c)));
}

// ── Evidence counters ────────────────────────────────────────────────
async function countPhotosFor(jobId, areaId, stage) {
  // Photos store metadata in sidecar JSONs (api/photos.js). Walk the prefix,
  // fetch sidecars, and count matches by area + (stage name | id | legacy alias).
  const prefix = `jobs/${jobId}/photos/`;
  try {
    const { blobs } = await list({ prefix, token: token() });
    const sidecars = blobs.filter(b => b.pathname.endsWith('.meta.json'));
    if (!sidecars.length) return 0;
    let count = 0;
    await Promise.all(sidecars.map(async b => {
      try {
        const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
        if (!r.ok) return;
        const meta = await r.json();
        if (eq(meta.area, areaId) && stageMatches(meta, stage)) count++;
      } catch {}
    }));
    return count;
  } catch {
    return 0;
  }
}

function countNotesFor(data, areaId, stage) {
  const notes = Array.isArray(data && data.notes) ? data.notes : [];
  return notes.filter(n => eq(n.dwelling, areaId) && stageMatches({stage: n.stage, stageId: n.stageId}, stage)).length;
}

function openSnagsFor(data, areaId, stage) {
  const snags = Array.isArray(data && data.snags) ? data.snags : [];
  return snags.filter(s =>
    eq(s.status || 'Open', 'Open') &&
    eq(s.dwelling, areaId) &&
    (!stage || stageMatches({stage: s.stage, stageId: s.stageId}, stage))
  );
}

async function readItpDoc(jobId) {
  return await readBlob(`jobs/${jobId}/itp.json`, { templates: [], submissions: [] });
}
function findItpSubmission(itpDoc, areaId, stage) {
  const subs = Array.isArray(itpDoc && itpDoc.submissions) ? itpDoc.submissions : [];
  // stage may be an id string (legacy callers) or a rich stage. Match either.
  if (typeof stage === 'string') {
    return subs.filter(s => eq(s.areaId, areaId) && eq(s.stageId, stage));
  }
  const aliases = stageAliases(stage);
  return subs.filter(s => eq(s.areaId, areaId) &&
    aliases.some(a => eq(a, s.stageId) || eq(a, s.stageName)));
}

// ── Main validator ───────────────────────────────────────────────────
//
// args: { job, stage, areaId, toStatus, user, jobData, itpDoc, photoCount }
// Returns { ok, error?, missing?, recommendedStatus? }
//   recommendedStatus: 'submitted' if a worker tried Done but the stage
//                      requires independent review.
async function canSetStageStatus(args) {
  const { job, stage, areaId, toStatus, user, jobData } = args;
  if (!job)   return { ok: false, error: 'job_closed' };
  if (!stage) return { ok: false, error: 'permission_denied' };
  if (!areaId) return { ok: false, error: 'permission_denied' };

  const tgt = normaliseStageStatus(toStatus);

  // Job-level guard
  if (job.status === 'closed' || job.status === 'archived') {
    return { ok: false, error: 'job_closed' };
  }

  // Permission guard
  if (!user) return { ok: false, error: 'permission_denied' };
  const isAdmin   = user.role === 'admin';
  const isTradie  = user.role === 'tradie';
  if (!isAdmin && !isTradie) return { ok: false, error: 'permission_denied' };

  // Tradies cannot directly approve / mark done independent-review stages.
  // They submit; an admin approves.
  if (stage.requires.independentReview && tgt === 'done' && !isAdmin) {
    return { ok: false, error: 'review_required', recommendedStatus: 'submitted' };
  }

  // Admin sign-off path: an admin doing approve cannot be the same person
  // who submitted (if blocksSelfReview).
  if (stage.requires.blocksSelfReview && tgt === 'done' && isAdmin) {
    const row = (jobData && jobData.dwellings && jobData.dwellings[areaId] && jobData.dwellings[areaId][stage.name]) || {};
    if (row.completedBy && user.id && row.completedBy === user.id) {
      return { ok: false, error: 'self_review_blocked' };
    }
  }

  // The terminal "we want to count evidence" target. Both submitted (worker
  // submitting for review) and done (admin approving / direct done on
  // requires-less stages) need to satisfy the evidence requirements.
  if (tgt === 'submitted' || tgt === 'done') {
    const reqPhoto = stage.requires.photo;
    const reqNote  = stage.requires.note;
    const reqItp   = stage.requires.itp;
    const minPhotos = Math.max(stage.evidence.minPhotos || 0, reqPhoto ? 1 : 0);
    const minNotes  = Math.max(stage.evidence.minNotes  || 0, reqNote  ? 1 : 0);

    // Photos — counters now match on stage id / name / legacy aliases.
    if (minPhotos > 0) {
      const have = (args.photoCount != null)
        ? args.photoCount
        : await countPhotosFor(job.id, areaId, stage);
      if (have < minPhotos) {
        return { ok: false, error: 'photo_required', missing: { photos: minPhotos - have } };
      }
    }
    // Notes
    if (minNotes > 0) {
      const have = countNotesFor(jobData, areaId, stage);
      if (have < minNotes) {
        return { ok: false, error: 'note_required', missing: { notes: minNotes - have } };
      }
    }
    // Open snags blocking completion
    if (stage.requires.blockIfOpenSnags) {
      const open = openSnagsFor(jobData, areaId, stage);
      if (open.length) {
        return { ok: false, error: 'defect_open', missing: { snags: open.length } };
      }
    }
    // ITP
    if (reqItp) {
      if (!stage.itpTemplateId) {
        // Required but no template assigned — can only happen on
        // misconfiguration. Block with a clear reason.
        return { ok: false, error: 'itp_required', missing: { reason: 'no_template' } };
      }
      const itpDoc = args.itpDoc || await readItpDoc(job.id);
      const subs   = findItpSubmission(itpDoc, areaId, stage);
      const accepted = subs.some(s => s.status === 'submitted' || s.status === 'approved');
      if (!accepted) {
        return { ok: false, error: 'itp_required', missing: { reason: 'not_submitted' } };
      }
      // For done with independent review, the ITP must be approved.
      if (tgt === 'done' && stage.requires.independentReview && !subs.some(s => s.status === 'approved')) {
        return { ok: false, error: 'review_required', missing: { reason: 'itp_not_approved' } };
      }
    }
  }

  return { ok: true };
}

module.exports = {
  canSetStageStatus,
  countPhotosFor,
  countNotesFor,
  openSnagsFor,
  readItpDoc,
  findItpSubmission,
};
