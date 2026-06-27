'use strict';

// "Your work record" — pure aggregation for #340 (PHIL surface).
//
// Given the caller's OWN time entries + a today/window, this builds a quiet,
// self-only trailing summary: hours logged per week over the last N weeks,
// and the distinct jobs they've worked in that window (jobId + name + hours).
// It is the maths behind the "Your work record" card on the Phil More tab.
//
// CJS so the serverless endpoint (api/my-stats.js) can require it; the Phil UI
// consumes the endpoint JSON. No I/O in here — the caller passes the entries
// it already listed, plus the window. Mirrors api/_lib/utilisation.js.
//
// Honesty (P7): every number comes from a real recorded entry. A worker with
// no history gets an HONEST empty window — `weeks` is still the real calendar
// (each carrying 0 logged hours so the worker sees the shape of the period),
// `jobs` is [], and `totalHours` is 0. Nothing is invented; a true zero is
// reported as a zero, never dressed up as achievement (the card copy frames
// the empty state, not this layer).
//
// Entry shape (matches api/_lib/time-entries.js): { date: 'YYYY-MM-DD',
// totalHours: number, status, allocations: [{ jobId, hours }] }. Hours are the
// decimal hours the worker actually logged; we do NOT re-derive anything.

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_WEEKS = 6;

/** Monday (UTC) of the ISO week containing dateIso (YYYY-MM-DD). '' if junk. */
function mondayOf(dateIso) {
  const d = new Date(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** Sunday (UTC) closing the week that starts on weekStartIso (Mon). */
function sundayOf(weekStartIso) {
  const t = new Date(`${weekStartIso}T00:00:00Z`).getTime() + 6 * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

/** The trailing `count` Monday week-starts ending with today's week, oldest → newest. */
function trailingWeeks(todayIso, count) {
  const thisMonday = mondayOf(todayIso);
  if (!thisMonday) return [];
  const n = Math.max(1, Math.floor(count) || 0);
  const out = [];
  const base = new Date(`${thisMonday}T00:00:00Z`);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() - i * 7);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

/**
 * Build the self-only "your work record" window. Pure.
 *
 *   buildMyRecord(entries, { todayIso, weeks?, jobNameById? })
 *
 * Returns:
 *   {
 *     weeks:      [{ weekStart, weekEnd, totalHours }]  // oldest → newest, real calendar
 *     jobs:       [{ jobId, jobName, hours }]           // distinct, worked-most first
 *     totalHours: number                                // sum over the window
 *     weekCount:  number
 *     windowStart, windowEnd                            // YYYY-MM-DD bounds (inclusive)
 *   }
 *
 * Only entries whose `date` falls inside the trailing window are counted.
 * Week hours use the entry's `totalHours`; per-job hours use the entry's
 * allocations (so a split day attributes to each job correctly). All hours
 * rounded to one decimal, matching the rest of /api/my-stats.
 */
function buildMyRecord(entries, opts) {
  const todayIso = (opts && opts.todayIso) || '';
  const weekCount =
    opts && Number.isFinite(opts.weeks) && opts.weeks > 0
      ? Math.floor(opts.weeks)
      : DEFAULT_WEEKS;
  const jobNameById = (opts && opts.jobNameById) || {};

  const weekStarts = trailingWeeks(todayIso, weekCount);
  if (weekStarts.length === 0) {
    return {
      weeks: [],
      jobs: [],
      totalHours: 0,
      weekCount: 0,
      windowStart: '',
      windowEnd: '',
    };
  }

  const windowStart = weekStarts[0];
  const windowEnd = sundayOf(weekStarts[weekStarts.length - 1]);

  // Pre-seed every week with 0 so the period shows its true shape even when a
  // week had no work — an honest "nothing logged" week, not a missing one.
  const weekTotals = {};
  for (const ws of weekStarts) weekTotals[ws] = 0;

  const byJob = {}; // jobId → hours

  for (const e of entries || []) {
    const date = e && e.date;
    if (!date || date < windowStart || date > windowEnd) continue;

    const ws = mondayOf(date);
    if (Object.prototype.hasOwnProperty.call(weekTotals, ws)) {
      weekTotals[ws] += Number(e.totalHours) || 0;
    }

    for (const a of (e && e.allocations) || []) {
      if (!a || !a.jobId) continue;
      byJob[a.jobId] = (byJob[a.jobId] || 0) + (Number(a.hours) || 0);
    }
  }

  const weeks = weekStarts.map((ws) => ({
    weekStart: ws,
    weekEnd: sundayOf(ws),
    totalHours: round1(weekTotals[ws]),
  }));

  const jobs = Object.entries(byJob)
    .map(([jobId, h]) => ({
      jobId,
      jobName: jobNameById[jobId] || jobId,
      hours: round1(h),
    }))
    .filter((j) => j.hours > 0)
    // Most-worked first; ties broken by name then id so the order is stable.
    .sort(
      (a, b) =>
        b.hours - a.hours ||
        a.jobName.localeCompare(b.jobName) ||
        a.jobId.localeCompare(b.jobId)
    );

  const totalHours = round1(weeks.reduce((s, w) => s + w.totalHours, 0));

  return {
    weeks,
    jobs,
    totalHours,
    weekCount: weeks.length,
    windowStart,
    windowEnd,
  };
}

module.exports = {
  DEFAULT_WEEKS,
  mondayOf,
  sundayOf,
  trailingWeeks,
  buildMyRecord,
};
