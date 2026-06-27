'use strict';

// Crew utilisation (#342, Epic 14) — pure maths. CJS so the serverless endpoint
// (api/utilisation.js) can require it; the admin UI consumes the endpoint JSON.
//
// The legacy api/crew-utilization.js is a single-week snapshot against a flat
// 40-hour default that is wrong for this crew (the standard day is 7h36m → a
// 38-hour week). This computes utilisation against each worker's REAL expected
// hours (7.6h × working days) over a trailing window + a crew capacity roll-up.
//
// Honesty (P7): a % exists only where expected > 0; weeks before a worker existed
// are EXCLUDED (not 0%); leave-aware expected hours are a follow-up (#127) — for
// now expected = 7.6 × Mon–Fri.

const STANDARD_DAY_HOURS = 7.6; // 7h36m
const STANDARD_WORKING_DAYS = 5; // Mon–Fri (leave/public-holiday aware = #127)

function expectedWeekHours(workingDays = STANDARD_WORKING_DAYS, standardDay = STANDARD_DAY_HOURS) {
  return Math.round(workingDays * standardDay * 10) / 10;
}

function utilisationPct(loggedHours, expectedHours) {
  if (!(expectedHours > 0)) return null;
  return Math.round((loggedHours / expectedHours) * 100);
}

/** Monday (UTC) of the ISO week containing dateIso (YYYY-MM-DD). */
function mondayOf(dateIso) {
  const d = new Date(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** The trailing `count` Monday week-starts ending with today's week, oldest → newest. */
function trailingWeeks(todayIso, count) {
  const thisMonday = mondayOf(todayIso);
  if (!thisMonday) return [];
  const out = [];
  const base = new Date(`${thisMonday}T00:00:00Z`);
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() - i * 7);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Per-worker multi-week utilisation. `weeks` = [{ weekStart, approvedHours,
 * submittedHours, expected:boolean }]. expected=false → the worker didn't yet
 * exist / wasn't tracked that week → excluded (not 0%). Pure.
 */
function buildWorkerUtilisation(userId, name, weeks) {
  const rows = (weeks || []).map((w) => {
    const logged = (w.approvedHours || 0) + (w.submittedHours || 0);
    const expectedHours = w.expected ? expectedWeekHours() : null;
    return {
      weekStart: w.weekStart,
      approvedHours: Math.round((w.approvedHours || 0) * 100) / 100,
      submittedHours: Math.round((w.submittedHours || 0) * 100) / 100,
      expectedHours,
      pct: expectedHours == null ? null : utilisationPct(logged, expectedHours),
      excluded: !w.expected,
    };
  });
  const included = rows.filter((r) => !r.excluded && r.pct != null);
  const avgPct = included.length
    ? Math.round(included.reduce((s, r) => s + r.pct, 0) / included.length)
    : null;
  return { userId, name, weeks: rows, avgPct };
}

/** Crew capacity roll-up for the latest week — "can we take this job". Pure. */
function crewCapacity(latestWeekStart, workers) {
  let expectedHours = 0;
  let approvedHours = 0;
  let submittedHours = 0;
  let counted = 0;
  for (const w of workers || []) {
    const wk = (w.weeks || []).find((r) => r.weekStart === latestWeekStart);
    if (!wk || wk.excluded || wk.expectedHours == null) continue;
    counted += 1;
    expectedHours += wk.expectedHours;
    approvedHours += wk.approvedHours;
    submittedHours += wk.submittedHours;
  }
  const round = (n) => Math.round(n * 100) / 100;
  return {
    weekStart: latestWeekStart,
    expectedHours: round(expectedHours),
    approvedHours: round(approvedHours),
    submittedHours: round(submittedHours),
    spareHours: round(expectedHours - approvedHours - submittedHours),
    workers: counted,
  };
}

module.exports = {
  STANDARD_DAY_HOURS,
  STANDARD_WORKING_DAYS,
  expectedWeekHours,
  utilisationPct,
  mondayOf,
  trailingWeeks,
  buildWorkerUtilisation,
  crewCapacity,
};
