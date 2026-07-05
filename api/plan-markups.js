// Plan markups (Plans Phase 2 overlays) — read/write API.
//
// Overlays are stored SEPARATELY from the original drawing, never written into
// the PDF/image:
//   jobs/<jobId>/drawing-markups.json  → { markups: [...] }
//
// The original plan blob (plans-index.json + page PNGs) is NEVER touched here.
//
// Permissions (mirrors api/_lib/auth.js + src/lib/auth/permissions.ts):
//   - manage (create/update/archive/toggle visibleToPhil): canManageJob
//     (admin tier on any job, leading hand on an assigned job).
//   - office view (all non-archived): same as manage.
//   - field view (visibleToPhil + non-archived, current plans only): a worker
//     assigned to the job.
//   - clients + unknown roles: denied.
//
// Coordinates are normalised 0..1 (matches src/domains/plans/coords.ts).

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canManageJob, canViewPhilPlanMarkups, isClientRole } = require('./_lib/auth');

// LOCKSTEP with src/domains/plan-markups/schema.ts MARKUP_TYPES — adding a type
// here without the schema (or vice-versa) makes the client safeParse and this
// server validator disagree. `arrow` + `text` are the #651 annotation-slice
// additions: arrow validates like line (exactly 2 points); text like pin/note
// (an {x,y} anchor).
const MARKUP_TYPES = ['pin', 'note', 'line', 'area', 'arrow', 'text'];
const MARKUP_TONES = ['navy', 'yellow', 'red', 'green', 'grey'];
const TEXT_MAX = 2000;
const LABEL_MAX = 120;
const AREA_POINTS_MAX = 24;

function newId() {
  return 'mk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
async function readMarkups(jobId) {
  return await readBlob('jobs/' + jobId + '/drawing-markups.json', { markups: [] });
}
async function writeMarkups(jobId, data) {
  await writeBlob('jobs/' + jobId + '/drawing-markups.json', data);
}
async function readPlanIndex(jobId) {
  return await readBlob('jobs/' + jobId + '/plans-index.json', { plans: [] });
}

function isCoord(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}
function validatePoints(type, points) {
  if (!Array.isArray(points)) return false;
  // arrow shares line's "exactly 2 points" rule (a directed segment).
  if ((type === 'line' || type === 'arrow') && points.length !== 2) return false;
  if (type === 'area' && (points.length < 3 || points.length > AREA_POINTS_MAX)) return false;
  if (type !== 'line' && type !== 'arrow' && type !== 'area') return false;
  return points.every((p) => p && isCoord(p.x) && isCoord(p.y));
}
/** Normalise a points array to plain {x,y} (drop any extra keys). */
function cleanPoints(points) {
  return points.map((p) => ({ x: p.x, y: p.y }));
}

/** Job access for a non-manager: explicitly assigned to the job. */
function isCrewOnJob(user, jobId) {
  return Array.isArray(user.assignedJobIds) && user.assignedJobIds.includes(jobId);
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;
  if (isClientRole(user.role)) return res.status(403).json({ error: 'forbidden' });

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const canManage = canManageJob(user, jobId);

  // ── GET — list markups for a plan + page ──────────────────────────────
  if (req.method === 'GET') {
    // Access gate FIRST — a reader with no access to the job gets a 403 before
    // any request-shape 400, so the endpoint never discloses its validation to
    // a role that can't see the job's markups.
    const hasFieldReadAccess = canViewPhilPlanMarkups(user.role) && isCrewOnJob(user, jobId);
    const hasAccess = canManage || hasFieldReadAccess;
    if (!hasAccess) return res.status(403).json({ error: 'no access to this job' });

    const planId = (req.query && req.query.planId) || '';
    if (!planId) return res.status(400).json({ error: 'planId required' });
    // page is optional: provided → that page only (the mission's per-page
    // query); omitted → every page of the plan (so the viewer can fetch once
    // and switch pages client-side). When provided it must be a valid index.
    const pageRaw = req.query && req.query.page;
    let pageIndex = null;
    if (pageRaw !== undefined && pageRaw !== '') {
      pageIndex = Number(pageRaw);
      if (!Number.isInteger(pageIndex) || pageIndex < 0) {
        return res.status(400).json({ error: 'page must be a non-negative integer' });
      }
    }

    const index = await readPlanIndex(jobId);
    const plan = (index.plans || []).find((p) => p.id === planId);
    if (!plan) return res.status(404).json({ error: 'plan not found' });

    const data = await readMarkups(jobId);
    let markups = (data.markups || []).filter(
      (m) => !m.archived && m.planId === planId &&
        (pageIndex === null || m.pageIndex === pageIndex),
    );

    if (!canManage) {
      // Field view: visibleToPhil only, and never overlays on a non-current
      // plan (superseded/archived drawings must not reach the field).
      if (plan.status && plan.status !== 'current') {
        return res.status(200).json({ markups: [] });
      }
      // Job Builder redesign Wave 4b follow-through: a plan hidden from the
      // field (Document.visibleToField === false — filtered out of the
      // api/plans.js field GET) must not leak its markups to a viewer who
      // guesses the planId either. Absent = visible, matching the list.
      if (plan.visibleToField === false) {
        return res.status(200).json({ markups: [] });
      }
      markups = markups.filter((m) => m.visibleToPhil === true);
    }
    return res.status(200).json({ markups });
  }

  // ── All writes require management of the job ──────────────────────────
  if (!canManage) return res.status(403).json({ error: 'cannot manage this job' });

  // ── POST — create a markup ────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body || {};
    const { planId, type } = body;
    const pageIndex = Number(body.pageIndex);

    if (!planId || typeof planId !== 'string') return res.status(400).json({ error: 'planId required' });
    if (!Number.isInteger(pageIndex) || pageIndex < 0) {
      return res.status(400).json({ error: 'pageIndex must be a non-negative integer' });
    }
    if (!MARKUP_TYPES.includes(type)) return res.status(400).json({ error: 'invalid type' });

    if (type === 'pin' || type === 'note' || type === 'text') {
      if (!isCoord(body.x) || !isCoord(body.y)) {
        return res.status(400).json({ error: type + ' requires normalised x,y in 0..1' });
      }
    } else if (!validatePoints(type, body.points)) {
      return res.status(400).json({ error: 'invalid points for ' + type + ' (normalised 0..1; line=2, area=3..' + AREA_POINTS_MAX + ')' });
    }
    if (body.text != null && (typeof body.text !== 'string' || body.text.length > TEXT_MAX)) {
      return res.status(400).json({ error: 'text too long (max ' + TEXT_MAX + ')' });
    }
    if (body.label != null && (typeof body.label !== 'string' || body.label.length > LABEL_MAX)) {
      return res.status(400).json({ error: 'label too long (max ' + LABEL_MAX + ')' });
    }
    if (body.tone != null && !MARKUP_TONES.includes(body.tone)) {
      return res.status(400).json({ error: 'invalid tone' });
    }
    if (body.visibleToPhil != null && typeof body.visibleToPhil !== 'boolean') {
      return res.status(400).json({ error: 'visibleToPhil must be boolean' });
    }

    const index = await readPlanIndex(jobId);
    const plan = (index.plans || []).find((p) => p.id === planId);
    if (!plan) return res.status(404).json({ error: 'plan not found' });
    if (plan.status === 'archived') {
      return res.status(400).json({ error: 'cannot add overlays to an archived plan' });
    }
    // If the plan has registered raster pages, the page must be one of them.
    if (Array.isArray(plan.pages) && plan.pages.length > 0 &&
        !plan.pages.some((pg) => pg.pageIndex === pageIndex)) {
      return res.status(400).json({ error: 'pageIndex not registered for this plan' });
    }

    const now = new Date().toISOString();
    // Build the record explicitly — no body spreading.
    const markup = {
      id: newId(),
      jobId,
      planId,
      pageIndex,
      type,
      visibleToPhil: body.visibleToPhil === true,
      archived: false,
      drawingNumber: typeof plan.drawingNumber === 'string' ? plan.drawingNumber : undefined,
      revision: typeof plan.revision === 'string' ? plan.revision : undefined,
      createdBy: user.username,
      createdAt: now,
      updatedBy: user.username,
      updatedAt: now,
    };
    if (type === 'pin' || type === 'note' || type === 'text') {
      markup.x = body.x;
      markup.y = body.y;
    } else {
      markup.points = cleanPoints(body.points);
    }
    if (typeof body.text === 'string' && body.text.length > 0) markup.text = body.text;
    if (typeof body.label === 'string' && body.label.length > 0) markup.label = body.label;
    if (body.tone) markup.tone = body.tone;

    const data = await readMarkups(jobId);
    data.markups = data.markups || [];
    data.markups.push(markup);
    await writeMarkups(jobId, data);
    return res.status(200).json({ markup });
  }

  // ── PATCH — update an existing markup ─────────────────────────────────
  if (req.method === 'PATCH') {
    const id = (req.query && req.query.id) || '';
    if (!id) return res.status(400).json({ error: 'id required' });
    const body = req.body || {};

    const data = await readMarkups(jobId);
    const markup = (data.markups || []).find((m) => m.id === id && m.jobId === jobId);
    if (!markup) return res.status(404).json({ error: 'markup not found' });

    // Apply only known, validated fields (no body spreading).
    if (body.x != null || body.y != null) {
      // x,y anchor moves apply to the {x,y} shapes: pin, note, and text (#651).
      if (markup.type !== 'pin' && markup.type !== 'note' && markup.type !== 'text') {
        return res.status(400).json({ error: 'x,y only apply to pin/note/text' });
      }
      if (!isCoord(body.x) || !isCoord(body.y)) {
        return res.status(400).json({ error: 'x,y must be normalised 0..1' });
      }
      markup.x = body.x;
      markup.y = body.y;
    }
    if (body.points != null) {
      if (!validatePoints(markup.type, body.points)) {
        return res.status(400).json({ error: 'invalid points for ' + markup.type });
      }
      markup.points = cleanPoints(body.points);
    }
    if (body.text !== undefined) {
      if (body.text !== null && (typeof body.text !== 'string' || body.text.length > TEXT_MAX)) {
        return res.status(400).json({ error: 'text too long (max ' + TEXT_MAX + ')' });
      }
      if (body.text) markup.text = body.text; else delete markup.text;
    }
    if (body.label !== undefined) {
      if (body.label !== null && (typeof body.label !== 'string' || body.label.length > LABEL_MAX)) {
        return res.status(400).json({ error: 'label too long (max ' + LABEL_MAX + ')' });
      }
      if (body.label) markup.label = body.label; else delete markup.label;
    }
    if (body.tone !== undefined) {
      if (!MARKUP_TONES.includes(body.tone)) return res.status(400).json({ error: 'invalid tone' });
      markup.tone = body.tone;
    }
    if (body.visibleToPhil !== undefined) {
      if (typeof body.visibleToPhil !== 'boolean') {
        return res.status(400).json({ error: 'visibleToPhil must be boolean' });
      }
      markup.visibleToPhil = body.visibleToPhil;
    }
    if (body.archived !== undefined) {
      if (typeof body.archived !== 'boolean') {
        return res.status(400).json({ error: 'archived must be boolean' });
      }
      markup.archived = body.archived;
    }
    // #233 — as-built designation. Mirror the visibleToPhil/archived branch.
    // Mirror the create-time archived-plan guard: an as-built designation must
    // not land on a markup whose plan revision is archived (a superseded plan
    // can still carry an honest as-built; an archived one cannot).
    if (body.asBuilt !== undefined) {
      if (typeof body.asBuilt !== 'boolean') {
        return res.status(400).json({ error: 'asBuilt must be boolean' });
      }
      const index = await readPlanIndex(jobId);
      const plan = (index.plans || []).find((p) => p.id === markup.planId);
      if (plan && plan.status === 'archived') {
        return res.status(400).json({ error: 'cannot designate an as-built on an archived plan' });
      }
      markup.asBuilt = body.asBuilt;
    }
    markup.updatedBy = user.username;
    markup.updatedAt = new Date().toISOString();

    await writeMarkups(jobId, data);
    return res.status(200).json({ markup });
  }

  // ── DELETE — soft-archive a markup (record preserved) ─────────────────
  if (req.method === 'DELETE') {
    const id = (req.query && req.query.id) || '';
    if (!id) return res.status(400).json({ error: 'id required' });
    const data = await readMarkups(jobId);
    const markup = (data.markups || []).find((m) => m.id === id && m.jobId === jobId);
    if (!markup) return res.status(404).json({ error: 'markup not found' });
    markup.archived = true;
    markup.updatedBy = user.username;
    markup.updatedAt = new Date().toISOString();
    await writeMarkups(jobId, data);
    return res.status(200).json({ markup });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
