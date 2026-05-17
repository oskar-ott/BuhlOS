// Append-safe list R/W helpers. Tags / temps / hours all store per-job
// records as a list inside a JSON blob. Older code accidentally overwrote
// the whole blob on POST (losing prior records). These helpers read the
// existing list (tolerating multiple legacy shapes), let the caller mutate,
// then write back as { <field>: [...] }.
//
// Supported legacy read shapes:
//   - Array                  → use as-is
//   - { <field>: [...] }     → preferred shape
//   - { entries: [...] }     → legacy
//   - { items:   [...] }     → legacy
//   - Single record object   → wrap in [obj] (lossy recovery for the bug
//                              where a single record was written as the blob)

const { readBlob, writeBlob } = require('./blob');

async function readList(key, field) {
  const blob = await readBlob(key, null);
  if (blob == null) return [];
  if (Array.isArray(blob)) return blob;
  if (Array.isArray(blob[field])) return blob[field];
  if (Array.isArray(blob.entries)) return blob.entries;
  if (Array.isArray(blob.items)) return blob.items;
  if (typeof blob === 'object' && Object.keys(blob).length) {
    // Looks like a stray single record — keep it so the user doesn't
    // permanently lose it (rather than discarding because the wrapper is
    // wrong).
    return [blob];
  }
  return [];
}

async function writeList(key, field, list) {
  const safe = Array.isArray(list) ? list : [];
  await writeBlob(key, { [field]: safe });
}

function newRecordId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// Append a single record. Adds id, createdAt, createdBy if missing.
async function appendRecord(key, field, record, user, idPrefix) {
  const list = await readList(key, field);
  const now = new Date().toISOString();
  const r = { ...record };
  if (!r.id) r.id = newRecordId(idPrefix || field);
  if (!r.createdAt) r.createdAt = now;
  if (!r.createdBy && user) r.createdBy = user.id;
  if (!r.createdByName && user) r.createdByName = user.username;
  list.push(r);
  await writeList(key, field, list);
  return { record: r, list };
}

// Update a record in place by id. Preserves unknown fields.
async function updateRecord(key, field, id, patch, user) {
  const list = await readList(key, field);
  const idx = list.findIndex(r => r && r.id === id);
  if (idx === -1) return { record: null, list };
  const merged = {
    ...list[idx],
    ...patch,
    id,
    updatedAt: new Date().toISOString(),
    updatedBy: user && user.id,
    updatedByName: user && user.username,
  };
  list[idx] = merged;
  await writeList(key, field, list);
  return { record: merged, list };
}

// Soft-delete by id (preferred). Returns the updated list. If preferHard,
// remove the record entirely.
async function deleteRecord(key, field, id, user, { hard = false } = {}) {
  const list = await readList(key, field);
  const idx = list.findIndex(r => r && r.id === id);
  if (idx === -1) return { ok: false, list };
  if (hard) {
    list.splice(idx, 1);
  } else {
    list[idx] = {
      ...list[idx],
      status: 'deleted',
      deletedAt: new Date().toISOString(),
      deletedBy: user && user.id,
      deletedByName: user && user.username,
    };
  }
  await writeList(key, field, list);
  return { ok: true, list };
}

module.exports = {
  readList,
  writeList,
  newRecordId,
  appendRecord,
  updateRecord,
  deleteRecord,
};
