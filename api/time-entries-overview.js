// Admin/LH cross-user hours overview.
//
//   GET /api/time-entries-overview
//     ?date=YYYY-MM-DD                       → single-day view (default: today)
//     ?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD → range
//     ?jobId=X                               → filter to allocations on this job
//     ?userId=X                              → filter to entries by this user
//
// Response:
//   {
//     entries: [...]                  // newest-first, optionally enriched with userName/jobName
//     totals: {
//       totalHours,                   // sum of allocations' hours that match filters
//       byJob:    [{jobId, jobName, hours}, ...]
//       byUser:   [{userId, userName, hours}, ...]
//       byDate:   [{date, hours, count}, ...]
//       byStatus: { draft, submitted, approved, rejected }
//     }
//     missing: [{date, userId, userName}, ...]    // hours-tracked crew with no entry that day
//     jobs:    [{id, name, status}, ...]          // visible jobs (admin: all; LH: assigned)
//     users:   [{id, username, role}, ...]        // hours-tracked workers (field tier + LHs,
//                                                 // live accounts) visible to viewer
//   }
//
// Permissions:
//   - admin: sees everything.
//   - leadingHand: sees only entries with at least one allocation on a job they're assigned to.
//                  "Missing logs" computed for crew assigned to those same jobs.
//   - everyone else: 403.

const { list } = require('@vercel/blob');
const { readBlob, setNoCache } = require('./_lib/blob');
const { readLeave, approvedLeaveByUserDate } = require('./_lib/leave');
const { publicHolidaysInRange } = require('./_lib/public-holidays');
const { requireAuth, isStaffRole, isAdminRole, isHoursTrackedWorker } = require('./_lib/auth');
const { HOURS_GO_LIVE } = require('./_lib/hours-epoch');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const viewer = await requireAuth(req, res);
  if (!viewer) return;
  if (!isStaffRole(viewer.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const q = req.query || {};
  const today = new Date().toISOString().slice(0, 10);
  const fromDate = q.fromDate || q.date || today;
  const toDate   = q.toDate   || q.date || today;
  const jobIdFilter  = q.jobId  || null;
  const userIdFilter = q.userId || null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    return res.status(400).json({ error: 'fromDate/toDate must be YYYY-MM-DD' });
  }
  if (fromDate > toDate) {
    return res.status(400).json({ error: 'fromDate must be <= toDate' });
  }

  // ── Reference data (single fetch each) ─────────────────────────────
  const [usersBlob, jobsBlob, empBlob] = await Promise.all([
    readBlob('users.json', { users: [] }),
    readBlob('jobs.json',  { jobs: [] }),
    readBlob('employees.json', { employees: [] }),
  ]);
  const users = usersBlob.users || [];
  const jobs  = jobsBlob.jobs   || [];
  const userById = {}; users.forEach(u => { userById[u.id] = u; });

  // Friendly worker labels. Invite/signup accounts are filed under their EMAIL
  // (users.username = email), which is what the raw username fallback surfaces
  // on the hours boards. The employees register knows the human — prefer its
  // first name (adding the surname only when two workers share a first name).
  // Legacy crew with name usernames have no register row and fall through
  // unchanged.
  const nameByUserId = {};
  {
    const rows = (empBlob.employees || []).filter(e => e && e.userId && e.firstName);
    const firstCount = {};
    for (const e of rows) firstCount[e.firstName] = (firstCount[e.firstName] || 0) + 1;
    for (const e of rows) {
      nameByUserId[e.userId] = e.displayName
        || (firstCount[e.firstName] > 1 && e.lastName ? `${e.firstName} ${e.lastName}` : e.firstName);
    }
  }
  const labelFor = (uid, stored) =>
    nameByUserId[uid] || stored || (userById[uid] && userById[uid].username) || uid;
  const jobById  = {}; jobs.forEach(j => { jobById[j.id]   = j; });

  const viewerJobs = new Set(viewer.assignedJobIds || []);
  // Tier-aware (not literal 'admin'): office/boss/PM are admin-tier viewers
  // and see the full company; leading hands stay job-scoped (#123).
  const viewerIsAdminTier = isAdminRole(viewer.role);
  const visibleJobs = viewerIsAdminTier
    ? jobs
    : jobs.filter(j => viewerJobs.has(j.id));
  const visibleJobIds = new Set(visibleJobs.map(j => j.id));

  // Crew visible to viewer = hours-tracked workers (the whole field tier +
  // leading hands in any spelling, live accounts only — see
  // isHoursTrackedWorker) assigned to any visible job. Used both for filter
  // dropdowns and "missing logs" computation. Pre-#114 this literal-matched
  // 'tradie'/'leadingHand', so onboarded electricians/apprentices/labourers
  // and lowercase-leadinghand accounts never appeared as missing hours.
  const visibleCrew = users.filter(u => {
    if (!isHoursTrackedWorker(u)) return false;
    if (viewerIsAdminTier) return true;
    return (u.assignedJobIds || []).some(jid => visibleJobIds.has(jid));
  });

  // ── Walk entries ───────────────────────────────────────────────────
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  let blobs = [];
  try {
    const r = await list({ prefix: 'users/', token, limit: 5000 });
    blobs = r.blobs || [];
  } catch (e) {
    return res.status(502).json({ error: 'blob list failed: ' + e.message });
  }

  // Path-shape filter (cheap): only time-entry day-files
  const entryBlobs = blobs.filter(b =>
    b.pathname.includes('/time-entries/') &&
    !b.pathname.includes('/time-entries-audit/') &&
    b.pathname.endsWith('.json')
  );

  // Date-prefix filter (cheap, before fetch): pathname looks like
  //   users/<uid>/time-entries/<date>.json
  // Pull out the date portion and skip files outside [fromDate, toDate].
  const inRange = entryBlobs.filter(b => {
    const m = b.pathname.match(/\/time-entries\/(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m) return false;
    const d = m[1];
    return d >= fromDate && d <= toDate;
  });

  // userId-filter: also done before fetch, by extracting from path
  const filteredBlobs = userIdFilter
    ? inRange.filter(b => b.pathname.startsWith('users/' + userIdFilter + '/'))
    : inRange;

  // Fetch in parallel
  const fetched = await Promise.all(filteredBlobs.map(async b => {
    try {
      const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }));
  let entries = fetched.filter(Boolean);

  // Visibility gate (LH): keep entries with at least one allocation on a visible job.
  // Admin sees everything.
  if (!isAdminRole(viewer.role)) {
    entries = entries.filter(e =>
      (e.allocations || []).some(a => a.jobId && visibleJobIds.has(a.jobId))
    );
  }

  // Optional jobId filter (any allocation matches)
  if (jobIdFilter) {
    entries = entries.filter(e =>
      (e.allocations || []).some(a => a.jobId === jobIdFilter)
    );
  }

  // Sort newest-first by (date desc, submittedAt desc)
  entries.sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return (b.submittedAt || '').localeCompare(a.submittedAt || '');
  });

  // Enrich entries with userName + per-allocation jobName (for the table view)
  const enriched = entries.map(e => {
    const u = userById[e.userId];
    return Object.assign({}, e, {
      userName: labelFor(e.userId, e.userName),
      userRole: e.userRole || (u && u.role)     || null,
      allocations: (e.allocations || []).map(a => ({
        ...a,
        jobName: a.jobId ? (jobById[a.jobId] && jobById[a.jobId].name) || a.jobId : null,
      })),
    });
  });

  // ── Totals ─────────────────────────────────────────────────────────
  // We sum allocation hours so per-job totals are correct when an entry is split.
  let totalHours = 0;
  const byJob   = {}; // jobId -> hours
  const byUser  = {}; // userId -> hours
  const byDate  = {}; // date  -> { hours, count: distinct entries }
  const byStatus = { draft: 0, submitted: 0, approved: 0, rejected: 0 };

  for (const e of enriched) {
    byStatus[e.status || 'draft'] = (byStatus[e.status || 'draft'] || 0) + 1;
    if (!byDate[e.date]) byDate[e.date] = { hours: 0, count: 0 };
    byDate[e.date].count += 1;

    for (const a of (e.allocations || [])) {
      // If a jobId filter is active we only count matching allocations
      if (jobIdFilter && a.jobId !== jobIdFilter) continue;
      const h = Number(a.hours) || 0;
      totalHours += h;
      const jobKey = a.jobId || '__internal__';
      byJob[jobKey]  = (byJob[jobKey]  || 0) + h;
      byUser[e.userId] = (byUser[e.userId] || 0) + h;
      byDate[e.date].hours += h;
    }
  }

  const totals = {
    totalHours: round2(totalHours),
    byJob: Object.keys(byJob).map(jid => ({
      jobId: jid === '__internal__' ? null : jid,
      jobName: jid === '__internal__' ? 'Internal (no job)' : ((jobById[jid] && jobById[jid].name) || jid),
      hours: round2(byJob[jid]),
    })).sort((a, b) => b.hours - a.hours),
    byUser: Object.keys(byUser).map(uid => ({
      userId: uid,
      userName: labelFor(uid, null),
      role: (userById[uid] && userById[uid].role) || null,
      hours: round2(byUser[uid]),
    })).sort((a, b) => b.hours - a.hours),
    byDate: Object.keys(byDate).sort().map(d => ({
      date: d,
      hours: round2(byDate[d].hours),
      count: byDate[d].count,
    })),
    byStatus,
  };

  // ── Missing logs ───────────────────────────────────────────────────
  // For each weekday (Mon..Fri) in the range, list assigned crew with no
  // entry of any status. We restrict missing to weekdays only — weekends
  // create false alarms unless the team works them. Past/today only — no
  // future "missing".
  const today0 = new Date(today + 'T00:00:00');
  const missing = [];
  // Pre-index entries by user+date for O(1) lookup
  const entryByUserDate = {};
  for (const e of enriched) {
    entryByUserDate[e.userId + '|' + e.date] = true;
  }
  // If a userId filter is active, restrict missing-logs to that user.
  // If a jobId filter is active, restrict crew set to those assigned to it.
  let crewForMissing = visibleCrew;
  if (userIdFilter) crewForMissing = crewForMissing.filter(u => u.id === userIdFilter);
  if (jobIdFilter)  crewForMissing = crewForMissing.filter(u => (u.assignedJobIds || []).includes(jobIdFilter));

  // #333: approved leave exempts a day from "missing" — it renders as
  // leave (with type) instead. Computed HERE, server-side, so every
  // consumer (weekly board, Phil week, reminder crons) agrees.
  let leaveByUserDate = {};
  try {
    const leaveData = await readLeave();
    leaveByUserDate = approvedLeaveByUserDate(leaveData.requests, fromDate, toDate);
  } catch { leaveByUserDate = {}; }
  const leave = [];

  // #137: AU national + NSW public holidays. Computed over the FULL range
  // (not just past/today, unlike missing) so the weekly board can render a
  // holiday cell for an upcoming holiday too. A holiday applies to the whole
  // crew, so it is emitted as a per-date list — unlike per-user leave. Same
  // server-side-truth principle as #333 leave: every consumer (weekly board,
  // Phil week, reminder crons) agrees because the classification lives here.
  const holidays = publicHolidaysInRange(fromDate, toDate);
  const holidaySet = new Set(holidays.map(h => h.date));

  // Go-live floor: the company started logging real hours on HOURS_GO_LIVE
  // (2026-08-03). A range reaching further back (the Jul-29→Aug-4 pay period,
  // an old week the office paged to) must not demand hours from before the
  // app existed in the field — no missing, no leave rows before the epoch.
  const goLive0 = new Date(HOURS_GO_LIVE + 'T00:00:00');
  const cursor = new Date(fromDate + 'T00:00:00');
  if (cursor < goLive0) cursor.setTime(goLive0.getTime());
  const end    = new Date(toDate   + 'T00:00:00');
  while (cursor <= end && cursor <= today0) {
    const dow = cursor.getDay();
    const isWeekend = (dow === 0 || dow === 6);
    // Format from the cursor's own calendar components, NOT toISOString():
    // the cursor is local-midnight, so the UTC render shifted the emitted
    // date by a day on any non-UTC host — entry-suppression then never
    // matched. Invisible on UTC production, but wrong (and untestable)
    // everywhere else; this keeps the date consistent with the local
    // getDay() weekend check above.
    const iso =
      cursor.getFullYear() + '-' +
      String(cursor.getMonth() + 1).padStart(2, '0') + '-' +
      String(cursor.getDate()).padStart(2, '0');
    // A public holiday is not a required day — exempt it from "missing" just
    // like a weekend, or the board cries wolf for the whole crew every
    // holiday week and the office learns to ignore red.
    if (!isWeekend && !holidaySet.has(iso)) {
      for (const u of crewForMissing) {
        if (entryByUserDate[u.id + '|' + iso]) continue;
        const leaveType = leaveByUserDate[u.id + '|' + iso];
        if (leaveType) {
          leave.push({ date: iso, userId: u.id, userName: labelFor(u.id, null), type: leaveType });
        } else {
          missing.push({ date: iso, userId: u.id, userName: labelFor(u.id, null), role: u.role });
        }
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return res.status(200).json({
    range: { fromDate, toDate },
    entries: enriched,
    totals,
    missing,
    leave,
    holidays,
    jobs:  visibleJobs.map(j => ({ id: j.id, name: j.name, status: j.status || 'active' })),
    users: visibleCrew.map(u => ({ id: u.id, username: u.username, role: u.role })),
  });
};

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
