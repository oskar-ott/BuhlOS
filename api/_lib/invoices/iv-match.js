'use strict';

// Exact IV job-reference matching — the central business rule of supplier-
// invoice capture.
//
// The BuhlOS IV number is the job's `code` in jobs.json: strictly `IV` + four
// digits (api/_lib/job-create.js validates the format, uppercases it and
// refuses duplicates case-insensitively). The wholesaler prints it under a
// label of THEIR choosing (Job Number / Job Reference / Customer Reference /
// Order Number / Purchase Reference / Your Reference / …). The supplier's own
// invoice number is a DIFFERENT thing and never enters this module.
//
// Normalisation is deliberately conservative: case, surrounding whitespace and
// a separator between the `IV` prefix and the four digits (a space, hyphen,
// dot, colon or hash the wholesaler's system inserted) — nothing else. Every
// job code is exactly IV + 4 digits, so collapsing those separators can never
// merge two legitimate references. Nothing is padded, guessed or fuzzed:
// "IV41" is malformed, not "IV0041".

const IV_CODE_RE = /^IV\d{4}$/;
// A printed IV token: word boundary, IV, optional single separator, 4 digits,
// then NOT another digit (so IV00411 is not IV0041).
const IV_TOKEN_SOURCE = '\\bIV[\\s\\-–.:#]?(\\d{4})(?!\\d)';

/** Labels wholesalers print the customer's job reference under (case-insensitive). */
const REFERENCE_LABEL_PATTERNS = [
  /\bjob\s*(?:no\.?|number|num|#|ref\.?|reference|code)\b/i,
  /\bjob\b/i,
  /\b(?:cust(?:omer)?|client)\s*(?:ref\.?|reference|order|po|p\.o\.|job)\s*(?:no\.?|number|#)?\b/i,
  /\b(?:purchase|order|po|p\.o\.)\s*(?:ref\.?|reference|no\.?|number|#)?\b/i,
  /\byour\s*(?:ref\.?|reference|order|po)\s*(?:no\.?|number|#)?\b/i,
  /\b(?:site|project)\s*(?:ref\.?|reference|no\.?|number|#)?\b/i,
  /\b(?:ref\.?|reference)\s*(?:no\.?|number|#)?\b/i,
];
// Labels that name the SUPPLIER's document, never the job — a line starting with
// one of these is never a job-reference line even if it contains "ref".
const NOT_REFERENCE_LABEL = /\b(?:tax\s*invoice|invoice|credit\s*note|adjustment\s*note|statement|quote|quotation|docket|delivery|receipt|account)\s*(?:no\.?|number|#|ref\.?|reference)?\b/i;

/**
 * Conservative normalisation. Returns `IV####` or null (malformed / not an IV
 * reference). Pure.
 * @param {unknown} raw
 */
function normaliseIvReference(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase();
  if (!s) return null;
  const m = /^IV[\s\-–.:#]?(\d{4})$/.exec(s);
  if (!m) return null;
  return `IV${m[1]}`;
}

/** True when a string is already a canonical job code. */
function isCanonicalIvCode(v) {
  return typeof v === 'string' && IV_CODE_RE.test(v);
}

function splitLabelValue(line) {
  const l = String(line || '');
  // "Job Number: IV0041" / "Order No # IV-0041"
  let m = /^\s*([A-Za-z][^:#]{0,40}?)\s*[:#]\s*(.*)$/.exec(l);
  if (m) return { label: m[1].trim(), value: m[2].trim() };
  // "Your Reference   IV 0041" (columnar: two or more spaces)
  m = /^\s*([A-Za-z][A-Za-z .\/'-]{1,40}?)\s{2,}(.*)$/.exec(l);
  if (m) return { label: m[1].trim(), value: m[2].trim() };
  // "Job Ref - IV0041"
  m = /^\s*([A-Za-z][A-Za-z .\/'-]{1,40}?)\s+[-–]\s+(.*)$/.exec(l);
  if (m) return { label: m[1].trim(), value: m[2].trim() };
  // "Your Reference IV0041" (single space, value starts with the token)
  m = /^\s*([A-Za-z][A-Za-z .\/'-]{1,40}?)\s+(IV[\s\-–.:#]?\d{4}(?!\d).*)$/i.exec(l);
  if (m) return { label: m[1].trim(), value: m[2].trim() };
  // a label alone on its line
  m = /^\s*([A-Za-z][A-Za-z .\/'#-]{1,40})\s*$/.exec(l);
  if (m) return { label: m[1].trim(), value: '' };
  return null;
}

function isReferenceLabel(label) {
  if (!label) return false;
  if (NOT_REFERENCE_LABEL.test(label)) return false;
  return REFERENCE_LABEL_PATTERNS.some((re) => re.test(label));
}

function tokensIn(value) {
  const out = [];
  const re = new RegExp(IV_TOKEN_SOURCE, 'gi');
  let m;
  while ((m = re.exec(value)) !== null) out.push({ raw: m[0], normalised: `IV${m[1]}` });
  return out;
}

/**
 * Extract candidate IV references from document text.
 *
 * Two sources, kept apart in the result so the match reason is honest:
 *   labelled — the token sits on a line (or the line after) whose label is a
 *              known job/customer/order/your-reference label
 *   text     — a well-formed `IV####` token anywhere else in the text
 *
 * Returns [{ raw, normalised, label, source, line }], deduplicated per
 * (normalised, source) keeping the first occurrence. Pure.
 * @param {string} text
 */
function extractIvCandidates(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  const seen = new Set();
  const push = (c) => {
    const k = `${c.source}:${c.normalised}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(c);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lv = splitLabelValue(line);
    if (lv && isReferenceLabel(lv.label)) {
      let toks = tokensIn(lv.value);
      let lineNo = i + 1;
      // label alone on its line → the value is usually the next non-empty line
      if (!toks.length && !lv.value && i + 1 < lines.length) {
        const next = lines[i + 1] || '';
        const nextLv = splitLabelValue(next);
        if (!(nextLv && isReferenceLabel(nextLv.label))) {
          toks = tokensIn(next);
          lineNo = i + 2;
        }
      }
      for (const t of toks) push({ ...t, label: lv.label, source: 'labelled', line: lineNo });
    }
  }
  for (let i = 0; i < lines.length; i++) {
    for (const t of tokensIn(lines[i])) push({ ...t, label: null, source: 'text', line: i + 1 });
  }
  return out;
}

/**
 * Pick THE reference to look up from the candidates, or refuse.
 *
 *   exactly one distinct labelled reference → use it
 *   several distinct labelled references     → multi_reference (review)
 *   none labelled, exactly one distinct text → use it (weaker evidence, said so)
 *   none labelled, several distinct text     → multi_reference
 *   nothing                                  → none
 * Pure.
 */
function selectIvReference(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const pick = (source) => {
    const subset = list.filter((c) => c && c.source === source && c.normalised);
    const distinct = [...new Set(subset.map((c) => c.normalised))];
    return { subset, distinct };
  };
  const labelled = pick('labelled');
  if (labelled.distinct.length === 1) {
    const c = labelled.subset[0];
    return { outcome: 'selected', normalised: c.normalised, raw: c.raw, label: c.label, source: 'labelled', line: c.line, distinct: labelled.distinct };
  }
  if (labelled.distinct.length > 1) {
    return { outcome: 'multi_reference', normalised: null, raw: null, label: null, source: 'labelled', line: null, distinct: labelled.distinct };
  }
  const text = pick('text');
  if (text.distinct.length === 1) {
    const c = text.subset[0];
    return { outcome: 'selected', normalised: c.normalised, raw: c.raw, label: null, source: 'text', line: c.line, distinct: text.distinct };
  }
  if (text.distinct.length > 1) {
    return { outcome: 'multi_reference', normalised: null, raw: null, label: null, source: 'text', line: null, distinct: text.distinct };
  }
  return { outcome: 'none', normalised: null, raw: null, label: null, source: null, line: null, distinct: [] };
}

function isDeletedJob(job) {
  return !!(job && (job.deleted === true || job.deletedAt));
}

/**
 * Index eligible jobs by normalised code. Jobs with no code, a malformed
 * code or a delete tombstone are skipped. `collisions` lists any normalised
 * code carried by more than one live job — automatic matching is blocked for
 * those (the invariant job-create enforces is re-checked here, not assumed).
 * Pure.
 * @param {Array<object>} jobs jobs.json rows
 */
function buildJobCodeIndex(jobs) {
  const byCode = new Map();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job || isDeletedJob(job)) continue;
    const code = normaliseIvReference(job.code);
    if (!code) continue;
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(job);
  }
  const collisions = [...byCode.entries()].filter(([, v]) => v.length > 1).map(([k]) => k);
  return { byCode, collisions, size: byCode.size };
}

const LATE_INVOICE_STATUSES = new Set(['complete', 'archived', 'on_hold']);

/**
 * Exact lookup of a normalised reference in the job index. NEVER fuzzy.
 *
 * @returns {{ status: 'exact', job: object, matchCount: 1, warnings: string[] }
 *         | { status: 'ambiguous', jobs: object[], matchCount: number, warnings: string[] }
 *         | { status: 'not_found', matchCount: 0, warnings: string[] }
 *         | { status: 'malformed', matchCount: 0, warnings: string[] }}
 */
function matchJobByIv(normalised, index) {
  if (!isCanonicalIvCode(normalised)) return { status: 'malformed', matchCount: 0, warnings: ['reference is not IV + four digits'] };
  const hits = (index && index.byCode && index.byCode.get(normalised)) || [];
  if (hits.length === 0) return { status: 'not_found', matchCount: 0, warnings: [] };
  if (hits.length > 1) {
    return { status: 'ambiguous', jobs: hits, matchCount: hits.length, warnings: [`${hits.length} jobs carry ${normalised} — automatic matching blocked`] };
  }
  const job = hits[0];
  const warnings = [];
  const status = job.status || 'active';
  if (LATE_INVOICE_STATUSES.has(status)) warnings.push(`job is ${status.replace('_', ' ')} — late invoice?`);
  if (status === 'draft') warnings.push('job is a draft (not published to the field)');
  return { status: 'exact', job, matchCount: 1, warnings };
}

module.exports = {
  IV_CODE_RE,
  normaliseIvReference,
  isCanonicalIvCode,
  extractIvCandidates,
  selectIvReference,
  buildJobCodeIndex,
  matchJobByIv,
  isReferenceLabel,
};
