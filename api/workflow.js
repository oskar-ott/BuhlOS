// Workflow actions — the place stage transitions and snag closures happen.
// BuhlOS decides; Phil / Switchboard call here.
//
// POST /api/workflow?jobId=X
// Body shapes (selected by `action`):
//
//   action: 'set-stage-status'
//     areaId, stageId (id or name), toStatus, note?
//     → validates via canSetStageStatus; if ok, persists into the job data
//       blob and appends audit; returns { ok, stage } else { error, missing }
//
//   action: 'close-snag'
//     snagId, note?
//     → admin-only. Sets snag.status='Closed', closedBy/At, closeNote.
//
//   action: 'reopen-snag'
//     snagId, reason
//     → admin-only. Sets snag.status='Reopened', reopenedBy/At, reopenReason.
//
//   action: 'review-stage'
//     areaId, stageName, decision: 'approve' | 'send-back', note?
//     → admin-only. approve moves submitted/review → done (with self-review
//       guard). send-back moves it back to 'reopened' with the note.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');
const { withRichStages, findStageInJob } = require('./_lib/stages');
const { normaliseStageStatus, stageLabel, normaliseSnagStatus } = require('./_lib/status');
const { canSetStageStatus, readItpDoc, openSnagsFor } = require('./_lib/workflow');
const { appendAudit } = require('./_lib/audit');

function dataKey(jobId) { return `jobs/${jobId}/data.json`; }
function emptyData() { return { dwellings: {}, snags: [], notes: [] }; }

function recordToWire(rowName, row) {
  return { name: rowName, status: row.status, updatedBy: row.updatedBy, updatedAt: row.updatedAt,
           completedBy: row.completedBy, completedByName: row.completedByName, completedAt: row.completedAt };
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const user = await requireAuth(req, res, { jobId });
  if (!user) return;
  if (user.role === 'client') return res.status(403).json({ error: 'forbidden' });

  const body = req.body || {};
  const action = String(body.action || '');

  // Load job + data once.
  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const job = (jobsBlob.jobs || []).find(j => j.id === jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  const rich = withRichStages(job);
  const data = await readBlob(dataKey(jobId), emptyData());
  data.dwellings = data.dwellings || {};
  data.snags     = Array.isArray(data.snags) ? data.snags : [];
  data.notes     = Array.isArray(data.notes) ? data.notes : [];

  // ── SET STAGE STATUS ────────────────────────────────────────────
  if (action === 'set-stage-status') {
    const areaId   = String(body.areaId || '').trim();
    const stageRef = String(body.stageId || body.stageName || '').trim();
    const note     = String(body.note || '').trim();
    let   toStatus = normaliseStageStatus(body.toStatus);
    if (!areaId || !stageRef || !toStatus) {
      return res.status(400).json({ error: 'areaId, stageId|stageName, toStatus required' });
    }
    const stage = findStageInJob(rich, stageRef);
    if (!stage) return res.status(404).json({ error: 'stage not found' });

    // Validate via workflow helper. canSetStageStatus expects nested stage
    // with .requires/.evidence as built by stages.js.
    const valid = await canSetStageStatus({
      job: rich, stage, areaId,
      toStatus, user, jobData: data,
    });
    if (!valid.ok) {
      // If a worker tried to mark done on an independent-review stage,
      // surface the recommended next step in the body.
      return res.status(409).json({
        error: valid.error,
        missing: valid.missing || null,
        recommendedStatus: valid.recommendedStatus || null,
      });
    }

    // Apply mutation. If an alias / legacy name still holds the row (because
    // this stage was renamed in Switchboard), lift it onto the current name
    // so old completion data isn't lost.
    if (!data.dwellings[areaId]) data.dwellings[areaId] = {};
    const dwellingMap = data.dwellings[areaId];
    if (!dwellingMap[stage.name]) {
      const aliases = [stage.id, ...(Array.isArray(stage.legacyNames) ? stage.legacyNames : [])];
      for (const a of aliases) {
        if (a && dwellingMap[a]) {
          dwellingMap[stage.name] = { ...dwellingMap[a] };
          delete dwellingMap[a];
          break;
        }
      }
      if (!dwellingMap[stage.name]) dwellingMap[stage.name] = {};
    }
    const row = dwellingMap[stage.name];
    const prevStatus = row.status || 'Not started';
    const newLabel = stageLabel(toStatus);
    row.status = newLabel;
    row.updatedBy = user.username;
    row.updatedById = user.id;
    row.updatedAt = new Date().toISOString();

    // Track completedBy on the meaningful transitions.
    if (toStatus === 'submitted' || (toStatus === 'done' && !stage.requires.independentReview)) {
      row.completedBy = user.id;
      row.completedByName = user.username;
      row.completedAt = row.updatedAt;
    }
    if (toStatus === 'done' && stage.requires.independentReview && user.role === 'admin') {
      row.approvedBy = user.id;
      row.approvedByName = user.username;
      row.approvedAt = row.updatedAt;
    }
    if (note) {
      data.notes.push({
        jobId, dwelling: areaId, stage: stage.name, stageId: stage.id,
        by: user.username, byId: user.id, role: user.role,
        desc: note, status: newLabel,
        at: new Date().toISOString(),
      });
    }

    try { await writeBlob(dataKey(jobId), data); }
    catch (e) { return res.status(500).json({ error: e.message }); }

    appendAudit(jobId, {
      type: toStatus === 'submitted' ? 'stage_submitted'
          : toStatus === 'done'      ? 'stage_approved'
          : toStatus === 'reopened'  ? 'stage_reopened'
          : 'stage_status_changed',
      areaId, stageId: stage.id, stageName: stage.name,
      from: prevStatus, to: newLabel,
      source: body.source || (user.role === 'admin' ? 'switchboard' : 'phil'),
      reason: body.reason || null,
    }, user);

    return res.status(200).json({
      ok: true,
      stage: recordToWire(stage.name, row),
      stageId: stage.id,
    });
  }

  // ── REVIEW STAGE (admin approve / send-back) ───────────────────
  if (action === 'review-stage') {
    if (user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    const areaId   = String(body.areaId || '').trim();
    const stageRef = String(body.stageId || body.stageName || '').trim();
    const decision = String(body.decision || '');
    const note     = String(body.note || '').trim();
    if (!areaId || !stageRef || !['approve', 'send-back'].includes(decision)) {
      return res.status(400).json({ error: 'areaId, stageId|stageName, decision (approve|send-back) required' });
    }
    const stage = findStageInJob(rich, stageRef);
    if (!stage) return res.status(404).json({ error: 'stage not found' });
    // Tolerant lookup: row may still live under a legacy stage name.
    if (!data.dwellings[areaId]) data.dwellings[areaId] = {};
    const dwellingMap = data.dwellings[areaId];
    if (!dwellingMap[stage.name]) {
      const aliases = [stage.id, ...(Array.isArray(stage.legacyNames) ? stage.legacyNames : [])];
      for (const a of aliases) {
        if (a && dwellingMap[a]) { dwellingMap[stage.name] = { ...dwellingMap[a] }; delete dwellingMap[a]; break; }
      }
    }
    const row = dwellingMap[stage.name];
    if (!row) return res.status(404).json({ error: 'stage state not found' });
    if (decision === 'approve') {
      // Self-review block
      if (stage.requires.blocksSelfReview && row.completedBy === user.id) {
        return res.status(409).json({ error: 'self_review_blocked' });
      }
      const valid = await canSetStageStatus({
        job: rich, stage, areaId, toStatus: 'done', user, jobData: data,
      });
      if (!valid.ok) return res.status(409).json({ error: valid.error, missing: valid.missing || null });
      row.status = 'Done';
      row.approvedBy = user.id;
      row.approvedByName = user.username;
      row.approvedAt = new Date().toISOString();
      row.updatedAt = row.approvedAt;
      row.updatedBy = user.username;
    } else {
      // Send back
      row.status = 'Reopened';
      row.updatedAt = new Date().toISOString();
      row.updatedBy = user.username;
      row.reopenReason = note || null;
    }
    if (note) {
      data.notes.push({
        jobId, dwelling: areaId, stage: stage.name, stageId: stage.id,
        by: user.username, byId: user.id, role: user.role,
        desc: note, status: row.status,
        at: new Date().toISOString(),
      });
    }
    try { await writeBlob(dataKey(jobId), data); }
    catch (e) { return res.status(500).json({ error: e.message }); }

    appendAudit(jobId, {
      type: decision === 'approve' ? 'stage_approved' : 'stage_reopened',
      areaId, stageId: stage.id, stageName: stage.name,
      to: row.status, source: 'switchboard',
      reason: note || null,
    }, user);

    return res.status(200).json({ ok: true, stage: recordToWire(stage.name, row), stageId: stage.id });
  }

  // ── CLOSE SNAG ──────────────────────────────────────────────────
  if (action === 'close-snag') {
    if (user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    const snagId = body.snagId;
    const idx    = data.snags.findIndex(s => s.id === snagId);
    if (idx === -1) return res.status(404).json({ error: 'snag not found' });
    data.snags[idx].status = 'Closed';
    data.snags[idx].closedBy = user.id;
    data.snags[idx].closedByName = user.username;
    data.snags[idx].closedAt = new Date().toISOString();
    if (body.note) data.snags[idx].closeNote = String(body.note);
    try { await writeBlob(dataKey(jobId), data); }
    catch (e) { return res.status(500).json({ error: e.message }); }
    appendAudit(jobId, {
      type: 'snag_closed',
      snagId, source: 'switchboard',
      reason: body.note || null,
    }, user);
    return res.status(200).json({ ok: true, snag: data.snags[idx] });
  }

  // ── REOPEN SNAG ─────────────────────────────────────────────────
  if (action === 'reopen-snag') {
    if (user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    const snagId = body.snagId;
    const idx    = data.snags.findIndex(s => s.id === snagId);
    if (idx === -1) return res.status(404).json({ error: 'snag not found' });
    data.snags[idx].status = 'Reopened';
    data.snags[idx].reopenedBy = user.id;
    data.snags[idx].reopenedByName = user.username;
    data.snags[idx].reopenedAt = new Date().toISOString();
    data.snags[idx].reopenReason = body.reason || body.note || null;
    try { await writeBlob(dataKey(jobId), data); }
    catch (e) { return res.status(500).json({ error: e.message }); }
    appendAudit(jobId, {
      type: 'snag_reopened',
      snagId, source: 'switchboard',
      reason: data.snags[idx].reopenReason,
    }, user);
    return res.status(200).json({ ok: true, snag: data.snags[idx] });
  }

  return res.status(400).json({ error: 'unknown action' });
};
