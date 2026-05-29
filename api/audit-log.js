// Audit log read endpoint — Phase D5 + PR 9.
//
//   GET /api/audit-log?targetType=evidence&targetId=<id>&jobId=<id>&months=<n>
//        → row history (the original D5 mode — every entry about ONE target)
//
//   GET /api/audit-log?jobId=<id>&scope=job&months=<n>&types=<csv>
//        → per-job activity feed (PR 9 — every entry about ANY target on the job;
//          admin/LH only; `types` is an optional comma-separated targetType filter
//          e.g. "evidence,snag,observation")
//
// Reads the monthly audit blobs at audit/<yyyy-mm>.json, filters to
// the requested target / job, and returns entries newest-first.
//
// D5 mounts the read path that D2 left as TODO (the storage helper
// in api/_lib/audit-log.js already exposes readMonth, but no HTTP
// surface consumed it until now). The D4 admin evidence drawer's
// History section ships an inline UC placeholder until this endpoint
// lands; D5 wires it.
//
// Query parameters:
//   targetType  required, one of: 'evidence'
//   targetId    required, the evidence id (or future target id)
//   jobId       required for permission checks — server validates the
//               caller has access to the job before returning entries
//               (mirrors api/evidence.js GET permission model)
//   months      optional, default 2 — how many recent monthly blobs to
//               scan. Capped at 12 so a runaway caller can't fan out
//               an unbounded blob list.
//
// Permissions (mirror api/evidence.js):
//   - unauthenticated → 401
//   - client role     → 403
//   - tradie GET      → only entries about own captures
//                       (server filters by actorId or by walking the
//                        evidence row's capturedById — D5 simplifies
//                        by reusing the same canRead check the
//                        evidence GET applies, then filters in
//                        memory)
//   - LH GET          → all entries on the job
//   - admin GET       → all entries on the job
//
// D5-tradie scope: a tradie GET on /api/audit-log returns the entries
// where the actorId is themselves OR the target evidence was captured
// by them. To keep this endpoint simple, D5 walks the evidence list
// to resolve ownership when role=tradie. Heavier loads can move this
// to a server-side index in a later phase.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isAdminRole, isLeadingHandRole } = require('./_lib/auth');
const { readMonth } = require('./_lib/audit-log');

// Kept in sync with api/_lib/audit-log.js VALID_TARGET_TYPES and
// src/domains/audit-log/schema.ts AUDIT_TARGET_TYPES — PR 9 added
// 'observation' (PR 6 writes observation.converted_to_snag entries with
// targetType='observation'), 'employee' + 'invite' (onboarding O1+
// already writes these into audit/<yyyy-mm>.json; the GET endpoint
// was just rejecting them on read).
const VALID_TARGET_TYPES = new Set([
  'evidence',
  'snag',
  'itp_template',
  'itp_instance',
  'employee',
  'invite',
  'observation',
]);
const MAX_MONTHS = 12;
const DEFAULT_MONTHS = 2;

function dataKey(jobId) {
  return `jobs/${jobId}/data.json`;
}

function recentMonths(now, count) {
  const out = [];
  const d = new Date(now);
  for (let i = 0; i < count; i += 1) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    out.push(`${y}-${m}`);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return out;
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const q = req.query || {};
  const targetType = String(q.targetType || '');
  const targetId = String(q.targetId || '');
  const jobId = String(q.jobId || '');
  const scope = String(q.scope || '');
  const typesCsv = String(q.types || '');
  const monthsParam = Number(q.months || DEFAULT_MONTHS);
  const months = Math.min(
    MAX_MONTHS,
    Math.max(1, Number.isFinite(monthsParam) ? Math.floor(monthsParam) : DEFAULT_MONTHS)
  );

  // PR 9: per-job activity feed mode. Admin/LH only — the field-worker view of
  // a job already shows their own captures + assigned snags + ITP rows; a
  // cross-event timeline is an office triage / closeout tool.
  if (scope === 'job') {
    if (!jobId) return res.status(400).json({ error: 'jobId required' });
    const user = await requireAuth(req, res, { jobId });
    if (!user) return;
    if (!isAdminRole(user.role) && !isLeadingHandRole(user.role)) {
      return res.status(403).json({ error: 'job activity feed is admin/LH only' });
    }
    const typeFilter = typesCsv
      ? typesCsv
          .split(',')
          .map((t) => t.trim())
          .filter((t) => VALID_TARGET_TYPES.has(t))
      : null;
    try {
      const yyyymms = recentMonths(Date.now(), months);
      const lists = await Promise.all(yyyymms.map((m) => readMonth(m)));
      const all = lists.flat();
      const filtered = all.filter(
        (e) =>
          e &&
          e.jobId === jobId &&
          (typeFilter ? typeFilter.includes(e.targetType) : true)
      );
      const sorted = filtered
        .slice()
        .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
      return res.status(200).json({ entries: sorted });
    } catch (e) {
      return res.status(500).json({ error: e.message || 'job feed read failed' });
    }
  }

  if (!targetType) return res.status(400).json({ error: 'targetType required' });
  if (!VALID_TARGET_TYPES.has(targetType)) {
    return res.status(400).json({ error: 'unsupported targetType' });
  }
  if (!targetId) return res.status(400).json({ error: 'targetId required' });
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const user = await requireAuth(req, res, { jobId });
  if (!user) return;
  if (user.role === 'client') return res.status(403).json({ error: 'forbidden' });

  try {
    const yyyymms = recentMonths(Date.now(), months);
    const lists = await Promise.all(yyyymms.map((m) => readMonth(m)));
    const all = lists.flat();
    let filtered = all.filter(
      (e) =>
        e &&
        e.targetType === targetType &&
        e.targetId === targetId &&
        (jobId ? e.jobId === jobId : true)
    );

    // Tradie sees only entries where they were the actor OR the target
    // evidence was captured by them. Look up the evidence row once to
    // resolve ownership without re-reading per entry.
    //
    // Snag targetType: every field user assigned to the job can see
    // the whole snag history (same visibility as the snag itself in
    // api/snags.js GET). No per-actor filter applies. Tradie evidence
    // filter is unchanged.
    if (user.role === 'tradie' && targetType === 'evidence') {
      let evCapturedById = null;
      try {
        const data = await readBlob(dataKey(jobId), { evidence: [] });
        const arr = Array.isArray(data && data.evidence) ? data.evidence : [];
        const ev = arr.find((it) => it && it.id === targetId);
        if (ev) evCapturedById = ev.capturedById || null;
      } catch {
        // Best-effort: a read failure makes us conservative — filter
        // to actor-only.
      }
      filtered = filtered.filter(
        (e) => e.actorId === user.id || evCapturedById === user.id
      );
    }

    const sorted = filtered
      .slice()
      .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));

    return res.status(200).json({ entries: sorted });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'audit read failed' });
  }
};
