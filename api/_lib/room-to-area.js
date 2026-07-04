// Rooms → job Structure AREAS — the pure merge at the heart of the #206
// accept bridge. Given the human-reviewed rooms detected on a plan (the
// ai-drawings `rooms` store) + the plan register + the job's existing
// areaGroups, produce the merged areaGroups plus an honest summary of what
// was created and what was skipped.
//
// PURE + IMMUTABLE: no DB, no id minting, no mutation of the inputs. The
// caller (api/ai-drawings.js accept-rooms) runs the result through
// validateAreaGroups (which mints ar_/ag_ ids + enforces live-id uniqueness)
// and writes it. Tested via createRequire from
// src/domains/ai-drawings/room-to-area.test.ts.
//
// Contract with the hard rules:
//   - AI PROPOSES, HUMAN ACCEPTS: only rooms already in a human-reviewed
//     terminal state (accepted | edited) become areas. suggested / rejected
//     rooms are skipped with a reason, never silently created.
//   - No invented data (P7): an area's name is the room's effective (printed
//     or human-corrected) label, verbatim. Empty labels are skipped.
//   - Idempotent: each created area carries aiSourceId = `aidr:room:<roomId>`.
//     A room whose aiSourceId already exists on ANY of the job's areas (live
//     OR archived) is skipped, so re-accepting never duplicates.
//   - Never deepens area-owned task arrays (task-led ADR): this only adds
//     areas (a real storage concept) with provenance — no task authoring.

'use strict';

const AI_SOURCE_PREFIX = 'aidr:room:';

/** Stable idempotency key for an area accepted from a detected room. */
function aiSourceIdForRoom(roomId) {
  return AI_SOURCE_PREFIX + String(roomId);
}

// The floor/sheet group an accepted room lands in. Prefer the plan's own
// level label ("Level 1") so rooms from every sheet on a level collect into
// one group; fall back to the sheet label, then a stable last resort. The
// revision is deliberately NOT part of the name — re-accepting a newer rev of
// the same sheet must merge into the same group, not spawn a parallel one.
function groupNameForPlan(planMeta, planId) {
  if (planMeta) {
    const level = typeof planMeta.level === 'string' ? planMeta.level.trim() : '';
    if (level) return level.slice(0, 120);
    const label = typeof planMeta.label === 'string' ? planMeta.label.trim() : '';
    if (label) return label.slice(0, 120);
  }
  return 'Plan ' + String(planId);
}

function planLabelOf(planMeta, planId) {
  if (planMeta) {
    const label = typeof planMeta.label === 'string' ? planMeta.label.trim() : '';
    if (label) return label;
  }
  return String(planId);
}

/**
 * @param {object} input
 * @param {Array<{
 *   id: string, planId: string, pageIndex: number,
 *   effectiveName: string, effectiveBbox?: unknown,
 *   confidence?: number|null, status: string
 * }>} input.rooms  reviewed rooms (roomView shape) to consider
 * @param {Array<{ id: string, label?: string, level?: string, revision?: string }>} input.plans
 *        plan register rows (for group naming + provenance)
 * @param {Array<object>} input.existingGroups  job.areaGroups as stored
 * @returns {{
 *   groups: Array<object>,
 *   created: Array<{ roomId: string, areaName: string, groupName: string, aiSourceId: string }>,
 *   skipped: Array<{ roomId: string, reason: string }>,
 *   sheets: Array<{ planId: string, planLabel: string, revision: string|null, level: string|null, created: number, considered: number }>
 * }}
 */
function buildRoomAreaMerge(input) {
  const rooms = Array.isArray(input && input.rooms) ? input.rooms : [];
  const plans = Array.isArray(input && input.plans) ? input.plans : [];
  const existingGroups = Array.isArray(input && input.existingGroups) ? input.existingGroups : [];

  const planById = new Map();
  for (const p of plans) {
    if (p && p.id != null) planById.set(String(p.id), p);
  }

  // Idempotency guard: every aiSourceId already present on ANY area (live or
  // archived) — a re-accept must never duplicate, even against an area the
  // admin later archived. Re-adding a dismissed one is an explicit unarchive.
  const seenSourceIds = new Set();
  for (const g of existingGroups) {
    for (const a of (g && Array.isArray(g.areas) ? g.areas : [])) {
      if (a && typeof a.aiSourceId === 'string' && a.aiSourceId) seenSourceIds.add(a.aiSourceId);
    }
  }

  // Immutable working copy — clone each group + its areas array so appends
  // never touch the caller's stored object graph.
  const groups = existingGroups.map((g) => ({
    ...g,
    areas: Array.isArray(g && g.areas) ? g.areas.slice() : [],
  }));

  // A LIVE group can absorb new areas; find the first non-archived group whose
  // name matches, else create one. (Matching mirrors the api/jobs.js PUT remap,
  // which also keys group identity by name.)
  const liveGroupByName = new Map();
  for (const g of groups) {
    if (g && !g.archived && typeof g.name === 'string' && !liveGroupByName.has(g.name)) {
      liveGroupByName.set(g.name, g);
    }
  }
  function targetGroup(name) {
    let g = liveGroupByName.get(name);
    if (g) return g;
    g = { name, areas: [] };
    groups.push(g);
    liveGroupByName.set(name, g);
    return g;
  }

  const created = [];
  const skipped = [];
  /** @type {Map<string, {planId:string, planLabel:string, revision:string|null, level:string|null, created:number, considered:number}>} */
  const sheetSummary = new Map();
  function sheetRow(planId) {
    let row = sheetSummary.get(planId);
    if (!row) {
      const meta = planById.get(planId) || null;
      row = {
        planId,
        planLabel: planLabelOf(meta, planId),
        revision: meta && meta.revision ? String(meta.revision) : null,
        level: meta && meta.level ? String(meta.level) : null,
        created: 0,
        considered: 0,
      };
      sheetSummary.set(planId, row);
    }
    return row;
  }

  for (const room of rooms) {
    if (!room || room.id == null) continue;
    const roomId = String(room.id);
    const planId = String(room.planId);
    const row = sheetRow(planId);
    row.considered += 1;

    // Human-accept gate: only reviewed rooms become areas.
    if (room.status !== 'accepted' && room.status !== 'edited') {
      skipped.push({ roomId, reason: 'not-reviewed' });
      continue;
    }
    const name = typeof room.effectiveName === 'string' ? room.effectiveName.trim() : '';
    if (!name) {
      skipped.push({ roomId, reason: 'empty-name' });
      continue;
    }
    const aiSourceId = aiSourceIdForRoom(roomId);
    if (seenSourceIds.has(aiSourceId)) {
      skipped.push({ roomId, reason: 'already-created' });
      continue;
    }
    seenSourceIds.add(aiSourceId);

    const planMeta = planById.get(planId) || null;
    const groupName = groupNameForPlan(planMeta, planId);
    const group = targetGroup(groupName);
    // No id — validateAreaGroups mints ar_. Provenance is the honest link back
    // to the plan room: plan + page + rev + approximate region.
    group.areas.push({
      name: name.slice(0, 200),
      aiSourceId,
      provenance: {
        source: 'ai-drawings-room',
        roomId,
        planId,
        pageIndex: typeof room.pageIndex === 'number' ? room.pageIndex : null,
        rev: planMeta && planMeta.revision ? String(planMeta.revision) : null,
        bbox: room.effectiveBbox != null ? room.effectiveBbox : null,
        confidence: typeof room.confidence === 'number' ? room.confidence : null,
      },
    });
    created.push({ roomId, areaName: name, groupName, aiSourceId });
    row.created += 1;
  }

  return { groups, created, skipped, sheets: Array.from(sheetSummary.values()) };
}

module.exports = { buildRoomAreaMerge, aiSourceIdForRoom, groupNameForPlan, AI_SOURCE_PREFIX };
