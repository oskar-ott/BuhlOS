'use strict';

// Evidence placement (owner direction 2026-09-24). Wholesalers print the IV
// number; a boutique supplier has nowhere to put one. When a document carries
// NO IV reference, this places it against a job from other evidence the
// document does print — the delivery address, the job's name, the job's ref —
// and says exactly which evidence it used. It never overrides an IV number,
// never guesses between two candidates (that is an ambiguity, offered to the
// reviewer), and a placement books itself only when the owner knob allows
// evidence placements AND the evidence is strong (an address). Pure.

const STREET_WORDS = {
  st: 'street', str: 'street', rd: 'road', ave: 'avenue', av: 'avenue', hwy: 'highway', pl: 'place', dr: 'drive', drv: 'drive',
  cres: 'crescent', cr: 'crescent', ct: 'court', crt: 'court', ln: 'lane', pde: 'parade', tce: 'terrace', blvd: 'boulevard', bvd: 'boulevard',
  cl: 'close', cct: 'circuit', esp: 'esplanade', gr: 'grove', hts: 'heights', pkwy: 'parkway', sq: 'square', wy: 'way',
};
const STREET_TYPES = new Set(Object.values(STREET_WORDS).concat(['street', 'road', 'avenue', 'highway', 'place', 'drive', 'crescent', 'court', 'lane', 'parade', 'terrace', 'boulevard', 'close', 'circuit', 'esplanade', 'grove', 'heights', 'parkway', 'square', 'way', 'walk', 'rise', 'loop', 'mews']));
const NOISE_WORDS = new Set(['unit', 'u', 'shop', 'lot', 'level', 'lvl', 'suite', 'ste', 'flr', 'floor', 'the', 'of', 'nsw', 'vic', 'qld', 'sa', 'wa', 'tas', 'act', 'nt', 'australia', 'au']);

/** Lower-case words, abbreviations expanded, punctuation gone. Pure. */
function addressWords(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/(\d)\s*[-–]\s*(\d)/g, '$1~$2') // keep a street-number range (494-504) as one token
    .replace(/[\/,.\-–—()]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => STREET_WORDS[w] || w);
}

/**
 * The comparable core of an address: the street number (the number directly
 * before the street name, so "6/10 Rodborough Road" → 10) + the street name
 * words up to and including the street type. Null when there is no street.
 * Pure.
 */
function addressKey(s) {
  const words = addressWords(s).filter((w) => !NOISE_WORDS.has(w) || /\d/.test(w));
  const typeIdx = words.findIndex((w) => STREET_TYPES.has(w));
  if (typeIdx < 0) return null;
  // walk back from the type collecting name words until a number
  let i = typeIdx - 1;
  const name = [];
  while (i >= 0 && !/^\d/.test(words[i]) && name.length < 4) { name.unshift(words[i]); i--; }
  if (!name.length) return null;
  const numTok = i >= 0 && /^\d/.test(words[i]) ? words[i].replace(/[a-z]$/, '') : null; // "12a" → 12
  // "494~504" is a range: every number in it (bounded) counts; "6/10" was split to "6", "10" → the 10
  let numbers = [];
  if (numTok && numTok.includes('~')) {
    const [a, b] = numTok.split('~').map(Number);
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a && b - a <= 60) for (let n = a; n <= b; n++) numbers.push(String(n));
    else numbers = [String(a), String(b)];
  } else if (numTok) numbers = [numTok];
  const street = `${name.join(' ')} ${words[typeIdx]}`;
  return { number: numbers[0] || null, numbers, street, key: `${numbers[0] || ''} ${street}`.trim() };
}

/** Same street and at least one street number in common. Pure. */
function sameAddress(a, b) {
  if (!a || !b || a.street !== b.street) return false;
  if (!a.numbers.length || !b.numbers.length) return false;
  return a.numbers.some((n) => b.numbers.includes(n));
}

const DELIVERY_LABEL = /\b(?:deliver(?:y|ed)?\s*(?:to|address|site)|ship(?:ped)?\s*to|site\s*address|job\s*(?:site|address)|delivery\s*details|deliver\s*:|install(?:ation)?\s*address|project\s*address|location|site\s*:)\s*[:\-]?\s*/i;
const STOP_LINE = /\b(?:bill\s*to|invoice\s*to|sold\s*to|customer|account|abn|phone|email|qty|quantity|description|invoice\s*(?:no|number|date)|date|terms|total|sub\s*total|gst)\b/i;
const MONEY_IN_LINE = /\d{1,3}(?:,\d{3})*\.\d{2}\b/;
/** A continuation line of an address: a suburb / state / postcode line, or a short line with a street in it. */
function looksLikeAddressTail(l) {
  if (MONEY_IN_LINE.test(l)) return false;
  if (/\b(?:nsw|vic|qld|sa|wa|tas|act|nt)\b|\b\d{4}\s*$/i.test(l)) return true;
  const words = addressWords(l);
  // a street line, or a short suburb-only line ("Double Bay") — never a sentence
  return (words.length <= 6 && words.some((w) => STREET_TYPES.has(w))) || (words.length <= 3 && !words.some((w) => /\d/.test(w)));
}

/** The delivery / site address block printed on the document, or null. Pure. */
function extractDeliveryAddress(lines) {
  const src = Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/);
  for (let i = 0; i < src.length; i++) {
    const m = DELIVERY_LABEL.exec(src[i]);
    if (!m) continue;
    // columns: the label may sit in a cell; take the text after the label on this line, then up to 2 continuation lines
    const parts = [];
    const rest = src[i].slice(m.index + m[0].length).split(/\s{3,}/)[0].trim();
    if (rest && !STOP_LINE.test(rest)) parts.push(rest);
    for (let j = i + 1; j <= i + 2 && j < src.length; j++) {
      const l = src[j].split(/\s{3,}/)[0].trim();
      if (!l || STOP_LINE.test(l) || DELIVERY_LABEL.test(l) || !looksLikeAddressTail(l)) break;
      parts.push(l);
      if (/\b(?:nsw|vic|qld|sa|wa|tas|act|nt)\b/i.test(l) || /\d{4}\s*$/.test(l)) break;
    }
    const text = parts.join(', ').replace(/\s+/g, ' ').trim();
    if (addressKey(text)) return text.slice(0, 200);
  }
  return null;
}

const GENERIC_NAME = /^(?:office|shop|site|job|home|house|unit|test|misc|other|various|general|new job|the office)$/i;

/**
 * @param {{ text: string, deliveryAddress?: string|null, references?: string[] }} doc
 * @param {Array<{ id: string, name?: string, code?: string|null, status?: string, deleted?: boolean, siteAddress?: string|null, ref?: string|null }>} jobs
 * @returns {{ outcome: 'placed'|'ambiguous'|'none', job?: object, strength?: 'strong'|'medium', evidence: Array<{ kind: string, jobId: string, detail: string }>, candidates: Array<{ id: string, name: string, code: string|null, status: string, evidence: string[] }> }}
 */
function inferPlacement(doc, jobs) {
  const text = String(doc.text || '');
  const lower = text.toLowerCase();
  const live = (Array.isArray(jobs) ? jobs : []).filter((j) => j && j.id && !j.deleted);
  const deliveryKey = doc.deliveryAddress ? addressKey(doc.deliveryAddress) : null;
  const textWords = addressWords(text).join(' ');
  const evidence = [];
  for (const j of live) {
    const jobKey = j.siteAddress ? addressKey(j.siteAddress) : null;
    if (jobKey && jobKey.number) {
      if (deliveryKey && sameAddress(deliveryKey, jobKey)) {
        evidence.push({ kind: 'address', strength: 'strong', jobId: j.id, detail: `delivery address “${doc.deliveryAddress}” is this job's site (${j.siteAddress})` });
      } else if (jobKey.numbers.some((n) => new RegExp(`(?<![\\w~])${n} ${jobKey.street.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w~])`).test(textWords))) {
        evidence.push({ kind: 'address', strength: 'strong', jobId: j.id, detail: `the document mentions this job's site address (${j.siteAddress})` });
      }
    }
    const name = String(j.name || '').trim();
    if (name.length >= 5 && !GENERIC_NAME.test(name) && !/^iv\d{4}$/i.test(name)) {
      const re = new RegExp(`(?<![a-z0-9])${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?![a-z0-9])`, 'i');
      if (re.test(lower) && !(jobKey && evidence.some((e) => e.jobId === j.id))) {
        evidence.push({ kind: 'name', strength: 'medium', jobId: j.id, detail: `the document mentions the job name “${name}”` });
      }
    }
    const ref = String(j.ref || '').trim();
    if (ref.length >= 4 && /\d/.test(ref) && lower.includes(ref.toLowerCase()) && !evidence.some((e) => e.jobId === j.id && e.kind === 'ref')) {
      evidence.push({ kind: 'ref', strength: 'medium', jobId: j.id, detail: `the document carries the job ref “${ref}”` });
    }
    for (const r of Array.isArray(doc.references) ? doc.references : []) {
      const rl = String(r || '').toLowerCase().trim();
      if (rl.length >= 5 && name.length >= 5 && rl.includes(name.toLowerCase()) && !evidence.some((e) => e.jobId === j.id)) {
        evidence.push({ kind: 'name', strength: 'medium', jobId: j.id, detail: `the customer reference “${r}” names the job “${name}”` });
      }
    }
  }
  const byJob = new Map();
  for (const e of evidence) {
    const c = byJob.get(e.jobId) || { job: live.find((j) => j.id === e.jobId), score: 0, strong: false, evidence: [] };
    c.score += e.strength === 'strong' ? 3 : 1;
    c.strong = c.strong || e.strength === 'strong';
    c.evidence.push(e);
    byJob.set(e.jobId, c);
  }
  const ranked = Array.from(byJob.values()).sort((a, b) => b.score - a.score);
  const candidates = ranked.map((c) => ({ id: c.job.id, name: c.job.name || c.job.id, code: c.job.code || null, status: c.job.status || 'active', evidence: c.evidence.map((e) => e.detail) }));
  if (!ranked.length) return { outcome: 'none', evidence: [], candidates: [] };
  const top = ranked[0];
  const strongOnes = ranked.filter((c) => c.strong);
  if (strongOnes.length === 1 && top.strong) return { outcome: 'placed', job: top.job, strength: 'strong', evidence: top.evidence, candidates };
  if (strongOnes.length === 0 && ranked.length === 1) return { outcome: 'placed', job: top.job, strength: 'medium', evidence: top.evidence, candidates };
  return { outcome: 'ambiguous', evidence, candidates };
}

module.exports = { addressWords, addressKey, sameAddress, extractDeliveryAddress, inferPlacement };
