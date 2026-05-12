// Job structural audit log (rigidity audit R5).
//
// One blob per job:  jobs/<jobId>/audit.json
//   { entries: [{ ts, byUserId, byUsername, kind, summary, before?, after? }] }
//
// "Structural" = anything that changes the *setup* — job name/type/status,
// modules, area groups + areas, task lists, custom fields. Operational
// surfaces (snags, hours, materials, plans) write their own logs / don't
// need this trail.
//
// The recorder is deliberately schema-thin: every call passes a free-form
// `summary` + optional before/after JSON. Callers in api/jobs.js produce
// one entry per PUT after detecting the diff. The whole file is capped at
// 500 entries — once it spills the oldest 100 get trimmed (LIFO trim, not
// FIFO ring buffer, to keep the read path simple).

const { readBlob, writeBlob } = require('./blob');

const MAX_ENTRIES = 500;
const TRIM_TO     = 400; // when we cross MAX_ENTRIES, lop down to this

function _key(jobId) { return `jobs/${jobId}/audit.json`; }

async function readAudit(jobId) {
  const data = await readBlob(_key(jobId), { entries: [] });
  return Array.isArray(data && data.entries) ? data.entries : [];
}

/**
 * Append a single audit entry. Best-effort: a write failure here must
 * never block the caller's main mutation, so callers should wrap the
 * call in `.catch(() => {})`.
 *
 * @param {string} jobId
 * @param {{ byUserId: string, byUsername: string, kind: string, summary: string, before?: any, after?: any }} entry
 */
async function appendAudit(jobId, entry) {
  if (!jobId || !entry || !entry.kind || !entry.summary) return;
  const entries = await readAudit(jobId);
  entries.push({
    ts: new Date().toISOString(),
    byUserId:   String(entry.byUserId || ''),
    byUsername: String(entry.byUsername || ''),
    kind:       String(entry.kind).slice(0, 40),
    summary:    String(entry.summary).slice(0, 240),
    // before/after are stored as-is but stringified to ~2KB each so a
    // huge areaGroups payload can't bloat the log.
    ...(entry.before !== undefined ? { before: _shrink(entry.before) } : {}),
    ...(entry.after  !== undefined ? { after:  _shrink(entry.after)  } : {}),
  });
  // Trim if needed.
  let trimmed = entries;
  if (entries.length > MAX_ENTRIES) {
    trimmed = entries.slice(-TRIM_TO);
  }
  await writeBlob(_key(jobId), { entries: trimmed });
}

function _shrink(v) {
  try {
    const s = JSON.stringify(v);
    if (s.length <= 2048) return v;
    return { _truncated: true, preview: s.slice(0, 2048) };
  } catch {
    return null;
  }
}

// Tiny diff helper for the common shapes — returns a list of human
// strings the caller can fold into the summary, plus the kind. Used by
// api/jobs.js after detecting a PUT changed something.
function diffStrings(before, after) {
  const out = [];
  if (before == null && after == null) return out;
  if (typeof before === 'string' && typeof after === 'string' && before !== after) {
    out.push(`renamed from "${before}" to "${after}"`);
  }
  return out;
}

module.exports = { readAudit, appendAudit, diffStrings };
