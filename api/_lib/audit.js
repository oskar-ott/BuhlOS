// Lightweight append-only audit trail. One file per job:
//   jobs/<jobId>/audit.json => { entries: [{ id, type, ..., createdAt }] }
//
// Capped to the most recent 5000 entries per job to keep the blob small. We
// don't fail the calling operation if audit append fails — it's observability.

const { readBlob, writeBlob } = require('./blob');

const MAX_ENTRIES = 5000;

function newAuditId() {
  return 'audit_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function readAudit(jobId) {
  const data = await readBlob(`jobs/${jobId}/audit.json`, { entries: [] });
  return Array.isArray(data.entries) ? data.entries : [];
}

async function appendAudit(jobId, entry, user) {
  if (!jobId || !entry || !entry.type) return null;
  const enriched = {
    id: newAuditId(),
    createdAt: new Date().toISOString(),
    jobId,
    by: (user && user.id) || null,
    byName: (user && user.username) || null,
    role: (user && user.role) || null,
    source: entry.source || 'api',
    ...entry,
  };
  try {
    const entries = await readAudit(jobId);
    entries.push(enriched);
    // Cap to most recent MAX_ENTRIES so the blob doesn't grow without bound.
    const trimmed = entries.length > MAX_ENTRIES ? entries.slice(-MAX_ENTRIES) : entries;
    await writeBlob(`jobs/${jobId}/audit.json`, { entries: trimmed });
    return enriched;
  } catch (e) {
    console.error('audit append failed', e.message);
    return null;
  }
}

module.exports = { newAuditId, readAudit, appendAudit };
