'use strict';

// Weekly crew availability (#337, Epic 15) — pure projection. CJS so the
// serverless endpoint (api/crew-week.js) can require it; the admin UI consumes
// the endpoint JSON.
//
// A read-only week view of the active crew: per worker, per day → on LEAVE (with
// type) / ASSIGNED (to which job, CURRENT-state, not a dated forward schedule) /
// FREE. Deliberately NOT a planner and NOT utilisation maths (Epic 14). Zero
// writes. Honesty (P7): assignment is current-state (labelled so), only leave
// varies per day; pending leave is OMITTED here (approved only) — documented.

/** Monday (UTC) of the ISO week containing dateIso (YYYY-MM-DD). */
function mondayOf(dateIso) {
  const d = new Date(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** The 7 ISO dates Mon→Sun of the week containing `dateIso`. */
function weekDays(dateIso) {
  const monday = mondayOf(dateIso);
  if (!monday) return [];
  const out = [];
  const base = new Date(`${monday}T00:00:00Z`);
  for (let i = 0; i < 7; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** True when an approved leave range covers `day` (inclusive, ISO compare). */
function leaveCovers(leave, day) {
  return leave && leave.fromDate <= day && day <= leave.toDate;
}

/**
 * Build the crew week grid. Pure.
 * @param {{ weekDays: string[],
 *           workers: Array<{ id:string, name:string, role:string, assignedJobNames:string[] }>,
 *           leaveByUser: Record<string, Array<{ type:string, fromDate:string, toDate:string }>> }} input
 * @returns Array<{ id, name, role, assignedJobNames, days: Array<{ date, state, leaveType }> }>
 */
function buildCrewWeek(input) {
  const days = (input && input.weekDays) || [];
  const leaveByUser = (input && input.leaveByUser) || {};
  return ((input && input.workers) || []).map((w) => {
    const leaves = leaveByUser[w.id] || [];
    const assigned = (w.assignedJobNames || []).length > 0;
    const row = days.map((date) => {
      const onLeave = leaves.find((l) => leaveCovers(l, date));
      if (onLeave) return { date, state: 'leave', leaveType: onLeave.type || 'leave' };
      // Current-state assignment (not dated) — same every day until leave overrides.
      return { date, state: assigned ? 'assigned' : 'free', leaveType: null };
    });
    return {
      id: w.id,
      name: w.name,
      role: w.role,
      assignedJobNames: w.assignedJobNames || [],
      days: row,
    };
  });
}

module.exports = { mondayOf, weekDays, leaveCovers, buildCrewWeek };
