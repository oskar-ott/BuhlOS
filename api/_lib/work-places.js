'use strict';

// Office and Workshop — the two places hours can be logged to that are NOT
// jobs (owner pull 2026-11-06: "when people are working in the office or in
// the workshop there's no job, and it wouldn't make sense to set one up").
//
// They ride an allocation's `jobId` as reserved ids so a day can be split like
// any job day ("4h Workshop + 4h Smith St"). The `place:` prefix can never be
// a real job id (job ids are slugs / generated ids, never containing ':').
//
// They are NOT in jobs.json and never become jobs: job-scoped reads (job hub
// hours, profitability, materials) key by real job id and simply never match
// them. Every surface that NAMES an allocation's job asks workPlaceName()
// first. Postgres has no row for them, so the mirror files them as "no job"
// (job_id null) — Blob stays the source of truth, same as day types.
//
// The client twin is src/domains/timesheets/work-places.ts — keep the ids and
// names identical (pinned by work-places.test.ts on both sides).

const WORK_PLACES = Object.freeze([
  Object.freeze({ id: 'place:office', name: 'Office' }),
  Object.freeze({ id: 'place:workshop', name: 'Workshop' }),
]);

const NAME_BY_ID = Object.freeze(
  WORK_PLACES.reduce((acc, p) => { acc[p.id] = p.name; return acc; }, {})
);

/** True for the Office / Workshop ids. */
function isWorkPlaceId(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(NAME_BY_ID, id);
}

/** "Office" / "Workshop" for a place id, else null. */
function workPlaceName(id) {
  return isWorkPlaceId(id) ? NAME_BY_ID[id] : null;
}

module.exports = { WORK_PLACES, isWorkPlaceId, workPlaceName };
