// Shared validation helpers for request bodies.
// Keep tiny — only the checks the API routes actually need.

function isStr(v) { return typeof v === 'string'; }

function requireFields(body, fields) {
  if (!body || typeof body !== 'object') return 'body required';
  for (const f of fields) {
    const v = body[f];
    if (v === undefined || v === null) return `${f} required`;
    if (isStr(v) && !v.trim()) return `${f} required`;
  }
  return null;
}

function trimStr(v, max = 500) {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

function trimStrOrNull(v, max = 500) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function isIsoOrNull(v) {
  if (v === undefined || v === null || v === '') return true;
  if (!isStr(v)) return false;
  const d = new Date(v);
  return !isNaN(d.getTime());
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function nowIso() { return new Date().toISOString(); }

const ASSET_TYPES = ['vehicle', 'key', 'tool', 'accessory', 'ppe', 'other'];
const CONTACT_CATEGORIES = ['project', 'supplier'];

module.exports = {
  isStr,
  requireFields,
  trimStr,
  trimStrOrNull,
  isIsoOrNull,
  newId,
  nowIso,
  ASSET_TYPES,
  CONTACT_CATEGORIES,
};
