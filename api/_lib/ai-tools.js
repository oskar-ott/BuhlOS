// AI assistant READ-TOOL layer (#170, Epic 6 foundation).
//
// The ONE audit point for AI data access: every record an assistant feature
// feeds into a prompt comes through runTool(user, name, args), which enforces
// a per-tool permission gate (reusing api/_lib/auth.js tiers VERBATIM) before
// any store read happens. A field user's assistant can never read records that
// user couldn't see through the normal API.
//
// Rules:
//   - READ-ONLY. No tool may mutate a store; v1 ships no write tools.
//   - Reuse, don't re-implement: tools wrap the existing readers
//     (readBlob per-job data.json / jobs.json / observations.json,
//     time-entries listAllEntriesForApprovers, day-pulse computeDayPulse).
//   - Honest empties: a job with no data returns zero counts and empty
//     arrays — never invented records. Missing job ⇒ { job: null }.
//   - Traceable: every result carries `sources` — {store, id} references to
//     the records behind it — so downstream features can cite them.
//   - Adapter seam: the store access is the existing api/_lib readers; when
//     Supabase (Epic 18) swaps behind those readers, the tools don't change.
//
// Tool shape: { name, description, gate(user, args) → {allowed, reason},
//               read(args) → data }. runTool is the only intended entry.

const { readBlob } = require('./blob');
const { canManageJob, isAdminRole } = require('./auth');
const { listAllEntriesForApprovers } = require('./time-entries');
const { computeDayPulse, sydneyToday } = require('./day-pulse');
const { getDb } = require('./supabase-db');
const drawingsStore = require('./ai-drawings-store');
const entityLinks = require('./entity-links');

// ── shared gates ─────────────────────────────────────────────────────────

// Job-scoped tools: admin tier any job; LH assigned jobs; field/client never
// (canManageJob — the same gate the office job surfaces use).
function gateManageJob(user, args) {
  const jobId = args && args.jobId ? String(args.jobId) : '';
  if (!jobId) return { allowed: false, reason: 'jobId required' };
  if (!canManageJob(user, jobId)) {
    return { allowed: false, reason: 'no access to job' };
  }
  return { allowed: true };
}

// Company-wide tools: admin tier only.
function gateAdminTier(user) {
  if (!user || !isAdminRole(user.role)) {
    return { allowed: false, reason: 'admin tier only' };
  }
  return { allowed: true };
}

// ── shared readers ───────────────────────────────────────────────────────

async function readJobRecord(jobId) {
  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  return (jobsBlob.jobs || []).find((j) => j.id === jobId) || null;
}

function readJobData(jobId) {
  return readBlob(`jobs/${jobId}/data.json`, { dwellings: {}, snags: [], notes: [] });
}

// Mirrors src/domains/observations/service.ts CLOSED_STATUSES — an observation
// is "open" (live, office may act on it) unless resolved/converted/record_only.
const OBSERVATION_CLOSED_STATUSES = new Set(['resolved', 'converted', 'record_only']);

// ── the registry ─────────────────────────────────────────────────────────

const TOOLS = {
  job_overview: {
    name: 'job_overview',
    description:
      'One job at a glance: the job record (id/name/type/status) plus honest counts from its ' +
      'per-job data — areas, rough-in/fit-off task totals and completes, open snags, captured evidence.',
    gate: gateManageJob,
    async read({ jobId }) {
      const job = await readJobRecord(jobId);
      const sources = [{ store: 'jobs.json', id: jobId }];
      if (!job) {
        // Honest null — the job does not exist; nothing is invented.
        return { job: null, areas: null, tasks: null, openSnagCount: null, evidenceCount: null, sources };
      }
      const data = await readJobData(jobId);
      sources.push({ store: `jobs/${jobId}/data.json`, id: null });

      // Task math mirrors api/job-glance.js: per-area effective task lists
      // (area override else job-level defaults), completion from dwellings map.
      const areas = (job.areaGroups || []).flatMap((g) => g.areas || []);
      const dwellings = data.dwellings || {};
      const jobRt = job.roughInTasks || [];
      const jobFt = job.fitOffTasks || [];
      const effRough = (a) => (Array.isArray(a.roughInTasks) && a.roughInTasks.length ? a.roughInTasks : jobRt);
      const effFit = (a) => (Array.isArray(a.fitOffTasks) && a.fitOffTasks.length ? a.fitOffTasks : jobFt);
      const tasks = {
        roughIn: { total: 0, complete: 0 },
        fitOff: { total: 0, complete: 0 },
      };
      for (const a of areas) {
        const rMap = ((dwellings[a.id] || {}).roughIn || {}).tasks || {};
        const fMap = ((dwellings[a.id] || {}).fitOff || {}).tasks || {};
        for (const t of effRough(a)) {
          tasks.roughIn.total++;
          if (rMap[t.id] === 'complete') tasks.roughIn.complete++;
        }
        for (const t of effFit(a)) {
          tasks.fitOff.total++;
          if (fMap[t.id] === 'complete') tasks.fitOff.complete++;
        }
      }
      const openSnagCount = (data.snags || []).filter((s) => (s.status || 'Open') === 'Open').length;
      const evidenceCount = Array.isArray(data.evidence) ? data.evidence.length : 0;

      return {
        job: {
          id: job.id,
          name: job.name || null,
          type: job.type || null,
          status: job.status || 'active',
          address: job.address || null,
          createdAt: job.createdAt || null,
        },
        areas: { count: areas.length },
        tasks,
        openSnagCount,
        evidenceCount,
        sources,
      };
    },
  },

  job_hours: {
    name: 'job_hours',
    description:
      'Labour on one job: approved and submitted (awaiting-approval) hour totals and entry counts, ' +
      'summed from time-entry allocations targeting the job. Draft/rejected entries excluded.',
    gate: gateManageJob,
    async read({ jobId }) {
      // Same recompute-from-source read api/job-hours.js uses (#134): a full
      // approver-scope scan filtered to allocations targeting this job.
      const all = await listAllEntriesForApprovers({ statuses: ['submitted', 'approved'] });
      const matched = all.filter(
        (e) => Array.isArray(e.allocations) && e.allocations.some((a) => a && a.jobId === jobId)
      );
      const bucket = { approved: { entryCount: 0, hours: 0 }, submitted: { entryCount: 0, hours: 0 } };
      const sources = [];
      for (const e of matched) {
        const jobHours = (e.allocations || [])
          .filter((a) => a && a.jobId === jobId)
          .reduce((s, a) => s + (Number(a.hours) || 0), 0);
        if (jobHours <= 0) continue;
        const b = bucket[e.status];
        if (!b) continue;
        b.entryCount++;
        b.hours += jobHours;
        if (sources.length < 100 && e.userId && e.date) {
          sources.push({ store: `users/${e.userId}/time-entries/${e.date}.json`, id: e.id || null });
        }
      }
      bucket.approved.hours = Math.round(bucket.approved.hours * 100) / 100;
      bucket.submitted.hours = Math.round(bucket.submitted.hours * 100) / 100;
      return { jobId, approved: bucket.approved, submitted: bucket.submitted, sources };
    },
  },

  job_open_items: {
    name: 'job_open_items',
    description:
      'What is still open on one job: open snags (id, description, priority, raised-by, date) and ' +
      'live observations from the field (id, type, title, status, priority). Closed items excluded.',
    gate: gateManageJob,
    async read({ jobId }) {
      const [data, obsStore] = await Promise.all([
        readJobData(jobId),
        readBlob('observations.json', { observations: [] }),
      ]);
      const openSnags = (data.snags || [])
        .filter((s) => (s.status || 'Open') === 'Open')
        .map((s) => ({
          id: s.id,
          description: s.desc || null,
          priority: s.priority || null,
          area: s.dwelling || null,
          raisedBy: s.by || null,
          createdAt: s.createdAt || null,
        }));
      const openObservations = (obsStore.observations || [])
        .filter((o) => o && o.jobId === jobId && !OBSERVATION_CLOSED_STATUSES.has(o.status))
        .map((o) => ({
          id: o.id,
          type: o.type || null,
          title: o.title || null,
          status: o.status || null,
          priority: o.priority || null,
          requiresAction: Boolean(o.requiresAction),
          createdAt: o.createdAt || null,
        }));
      return {
        jobId,
        openSnags,
        openObservations,
        sources: [
          { store: `jobs/${jobId}/data.json`, id: null },
          { store: 'observations.json', id: null },
        ],
      };
    },
  },

  company_day_pulse: {
    name: 'company_day_pulse',
    description:
      "The company's day at a glance for one date: hours submitted/approved/draft with crew-on-site " +
      'count, snags opened/resolved, and active jobs with activity. Same engine as /api/today-pulse.',
    gate: gateAdminTier,
    async read(args, user) {
      const date = args && args.date ? String(args.date) : sydneyToday();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error('date must be YYYY-MM-DD');
      }
      const pulse = await computeDayPulse(user, date);
      return {
        ...pulse,
        sources: [
          { store: 'jobs.json', id: null },
          { store: `users/*/time-entries/${date}.json`, id: null },
        ],
      };
    },
  },
};

/** Names + descriptions only — for the admin/debug tools listing. */
function listTools() {
  return Object.values(TOOLS).map((t) => ({ name: t.name, description: t.description }));
}

/**
 * The single audited entry point: gate, then read.
 *
 * @param {object|null} user the authenticated requesting user (from requireAuth)
 * @param {string} name tool name
 * @param {object} [args]
 * @returns {Promise<{ok: true, data: object} | {ok: false, error: {code: string, message: string}}>}
 */
// ── #179: the Epic 5 drawing-extraction index as a read tool ─────────────

// Per-list cap keeps a single tool call promptable; totals stay honest.
const DRAWING_LIST_CAP = 200;

function capList(rows) {
  return { total: rows.length, truncated: rows.length > DRAWING_LIST_CAP, items: rows.slice(0, DRAWING_LIST_CAP) };
}

TOOLS.drawing_extractions = {
  name: 'drawing_extractions',
  description:
    "Epic 5 drawing-understanding index for one job — classified sheets (registry with effective sheet numbers/titles), reviewed legend vocabulary, accepted schedule rows, rooms, cross-sheet references (live-resolved), human-verified device counts, accepted cable estimates and the signed-off takeoff. Every item cites its plans-register id + page. Answers come ONLY from these extractions — no vision runs at question time; where a value isn't extracted, it simply isn't here.",
  gate: gateManageJob,
  async read({ jobId }) {
    let sql;
    try {
      sql = getDb({ mode: 'read' });
    } catch (e) {
      // preview/local deployments have no extraction store — say so, never guess
      return {
        available: false,
        reason: 'the drawing-extraction store is not reachable in this environment',
        sources: [],
      };
    }
    const tenantId = await drawingsStore.resolveTenantId(sql);
    const [
      sheetRows, overrides, legend, tables, roomsRows, refs, counts, cableRuns, takeoff,
    ] = await Promise.all([
      drawingsStore.listPlanSheets(sql, tenantId, jobId),
      drawingsStore.listOverrides(sql, tenantId, jobId),
      drawingsStore.acceptedLegendEntries(sql, tenantId, jobId),
      drawingsStore.listScheduleTables(sql, tenantId, jobId),
      drawingsStore.listRooms(sql, tenantId, jobId),
      drawingsStore.listSheetRefs(sql, tenantId, jobId),
      drawingsStore.liveAcceptedCounts(sql, tenantId, jobId),
      drawingsStore.acceptedCableRuns(sql, tenantId, jobId),
      drawingsStore.signedOffTakeoff(sql, tenantId, jobId),
    ]);
    const scheduleRows = await drawingsStore.listScheduleRowsForTables(
      sql, tenantId, tables.map((t) => t.id),
    );

    // effective field = human override > AI value (the #197 contract)
    const ovr = (planId, pageIndex, field) => {
      const o = overrides.find(
        (x) => x.plan_id === planId && x.page_index === pageIndex && x.field === field,
      );
      return o ? o.value : undefined;
    };
    const eff = (row, field, aiValue) => {
      const o = ovr(row.plan_id, row.page_index, field);
      return o === undefined ? aiValue : o;
    };
    const sheets = sheetRows.map((r) => ({
      planId: r.plan_id,
      pageIndex: r.page_index,
      sheetType: eff(r, 'sheetType', r.sheet_type),
      sheetNumber: eff(r, 'sheetNumber', r.sheet_number),
      sheetTitle: eff(r, 'sheetTitle', r.sheet_title),
      revision: eff(r, 'revision', r.revision),
      scale: eff(r, 'scale', r.scale),
    }));

    const resolvedRefs = entityLinks.resolveRefs(
      refs,
      sheets.map((sh) => ({ planId: sh.planId, pageIndex: sh.pageIndex, sheetNumber: sh.sheetNumber })),
    );

    const tableById = new Map(tables.map((t) => [t.id, t]));
    const reviewedScheduleRows = scheduleRows
      .filter((r) => r.status === 'accepted' || r.status === 'edited')
      .map((r) => {
        const t = tableById.get(r.table_id);
        return {
          planId: t.plan_id,
          pageIndex: t.page_index,
          tableKind: t.table_kind,
          boardIdentifier: t.board_identifier,
          cells: r.human_cells
            ? { ...Object.fromEntries(Object.entries(r.cells || {}).map(([k, v]) => [k, v && v.value])), ...r.human_cells }
            : Object.fromEntries(Object.entries(r.cells || {}).map(([k, v]) => [k, v && v.value])),
        };
      });

    return {
      available: true,
      sheets: capList(sheets),
      legend: capList(
        legend.map((l) => ({
          label: l.human_label || l.label,
          description: l.description,
          category: l.category,
          sourcePlanId: l.source_plan_id,
          sourcePageIndex: l.source_page_index,
        })),
      ),
      scheduleRows: capList(reviewedScheduleRows),
      rooms: capList(
        roomsRows
          .filter((r) => r.status === 'suggested' || r.status === 'accepted' || r.status === 'edited')
          .map((r) => ({
            name: r.human_name || r.name,
            planId: r.plan_id,
            pageIndex: r.page_index,
            reviewed: r.status !== 'suggested',
          })),
      ),
      refs: capList(
        resolvedRefs.map((r) => ({
          planId: r.plan_id,
          pageIndex: r.page_index,
          text: r.text,
          targetSheetNumber: r.target_sheet_number,
          resolved: r.resolved,
        })),
      ),
      verifiedCounts: capList(
        counts.map((c) => ({
          label: c.label,
          count: c.count,
          planId: c.plan_id,
          pageIndex: c.page_index,
          acceptedBy: c.accepted_by_label,
        })),
      ),
      cableEstimates: capList(
        cableRuns.flatMap((run) =>
          ((run.results || {}).boards || []).map((b) => ({
            boardIdentifier: b.boardIdentifier,
            totalMm: b.totalMm,
            estimate: true, // heuristic — verify on drawing
            planId: run.plan_id,
            pageIndex: run.page_index,
          })),
        ),
      ),
      signedOffTakeoff: takeoff
        ? {
            version: takeoff.takeoff.version,
            signedOffBy: takeoff.takeoff.signed_off_by_label,
            signedOffAt: takeoff.takeoff.signed_off_at,
            lineCount: takeoff.lines.length,
          }
        : null,
      sources: [
        { store: 'supabase:plan_sheets', id: jobId },
        { store: 'supabase:legend_entries', id: jobId },
        { store: 'supabase:schedule_rows', id: jobId },
        { store: 'supabase:rooms', id: jobId },
        { store: 'supabase:sheet_refs', id: jobId },
        { store: 'supabase:accepted_counts', id: jobId },
        { store: 'supabase:cable_estimate_runs', id: jobId },
        { store: 'supabase:takeoffs', id: jobId },
      ],
    };
  },
};

async function runTool(user, name, args = {}) {
  const tool = TOOLS[String(name)];
  if (!tool) {
    return { ok: false, error: { code: 'UNKNOWN_TOOL', message: `unknown tool "${name}"` } };
  }
  if (!user) {
    return { ok: false, error: { code: 'FORBIDDEN', message: 'not authenticated' } };
  }
  const verdict = tool.gate(user, args);
  if (!verdict.allowed) {
    return { ok: false, error: { code: 'FORBIDDEN', message: verdict.reason || 'forbidden' } };
  }
  try {
    const data = await tool.read(args, user);
    return { ok: true, data };
  } catch (e) {
    return {
      ok: false,
      error: { code: 'READ_FAILED', message: (e && e.message) || 'tool read failed' },
    };
  }
}

module.exports = { TOOLS, runTool, listTools };
