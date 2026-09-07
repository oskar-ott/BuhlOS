'use strict';

// Worker display names for office surfaces — FULL names, never nicknames.
//
// Owner-directed 2026-08-16 (#1020): hours feed payroll, so worker identity
// must be unambiguous and must match the payroll PDF/CSV/email, which print the
// full name. Resolution order, highest first:
//
//   1. employees register "First Last" — its displayName is a NICKNAME ("Alfie",
//      "Louie", junk "Mr") and is deliberately IGNORED (greeting material, not
//      payroll identity)
//   2. live users.json full name (`name`)
//   3. the stored write-time snapshot on the entry (nickname-era submissions
//      carry old labels forever — this is why the live sources come first)
//   4. users.json username (invite/signup accounts are filed under their EMAIL)
//   5. the bare userId
//
// ONE resolver for every board and projection (#1027): the weekly/phone hours
// boards (api/time-entries-overview.js) and the per-job Labour card
// (api/job-hours.js) must never disagree about who worked.

/**
 * Build a labeller from the two reference blobs. Pure.
 * @param {{ users?: Array<{id:string,name?:string,username?:string}>,
 *           employees?: Array<{userId?:string,firstName?:string,lastName?:string}> }} refs
 * @returns {(userId: string, stored?: string|null) => string}
 */
function buildWorkerLabeller(refs) {
  const userById = {};
  for (const u of (refs && refs.users) || []) {
    if (u && u.id) userById[u.id] = u;
  }
  const nameByUserId = {};
  for (const e of (refs && refs.employees) || []) {
    if (!e || !e.userId || !e.firstName) continue;
    nameByUserId[e.userId] = e.lastName ? `${e.firstName} ${e.lastName}` : e.firstName;
  }
  return (userId, stored) =>
    nameByUserId[userId]
    || (userById[userId] && userById[userId].name)
    || stored
    || (userById[userId] && userById[userId].username)
    || userId;
}

module.exports = { buildWorkerLabeller };
