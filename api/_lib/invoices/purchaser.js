'use strict';

// Who was at the counter (owner, 2026-09-28: "there is sometimes a name added
// to the invoice for who was at the wholesaler"). Wholesalers print the person
// who placed or collected the order — "Ordered by: Sam", "Picked up by: DYLAN
// S", "Contact: Simon Exkhof". This reads that name, matches it to an employee,
// and — when the invoice carries no IV number — offers the job that worker
// logged hours on that day as placement evidence. Pure.
//
// Honest by construction: the name is shown exactly as printed; a match to an
// employee needs a full name, or a first name / preferred name / "first +
// initial" that only ONE employee has. Two Sams is no match. The wholesaler's
// own staff ("Served by", "Sales rep") are never read as the buyer.

const LABEL = /\b(?:ordered\s*by|order(?:ed)?\s*placed\s*by|placed\s*by|picked\s*up\s*by|pick[\s-]*up\s*by|collected\s*by|collected\s*:|pickup\s*:|customer\s*contact|contact\s*name|contact|attn\.?|attention|buyer|purchaser|requested\s*by|received\s*by|signed\s*for\s*by|ordered\s*:|orderer)\b\s*[:#\-]?\s*/i;
const NOT_BUYER = /\b(?:served\s*by|sales\s*(?:rep|person|contact)|rep\s*:|salesperson|account\s*manager|cashier|operator|picker|packed\s*by|checked\s*by|driver)\b/i;
const NOT_A_NAME = /\b(?:pty|ltd|limited|electrical|electric|buhl|bühl|services|group|cash|account|customer|office|n\/?a|none|tba|tbc|phone|email|mobile|ph|mob|www|http|abn|acn|job|site|iv\d|invoice|order|date|delivery|deliver|ship|total|qty|ref)\b/i;

/** The buyer's name as printed, or null. Pure. */
function extractPurchaserName(lines) {
  const src = Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/);
  for (const line of src) {
    if (!line || NOT_BUYER.test(line)) continue;
    const m = LABEL.exec(line);
    if (!m) continue;
    let v = line.slice(m.index + m[0].length).split(/\s{3,}|\t|\|/)[0];
    v = v.replace(/[^A-Za-z .'\-]+.*$/, '').replace(/[\s.\-]+$/, '').trim();
    if (!v || v.length < 2 || v.length > 40) continue;
    if (!/^[A-Za-z][A-Za-z.'\- ]*$/.test(v) || NOT_A_NAME.test(v)) continue;
    const words = v.split(/\s+/);
    if (words.length > 3) continue;
    return v.replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\b([A-Z])([A-Z]+)\b/g, (_, a, b) => a + b.toLowerCase());
  }
  return null;
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * @param {string|null} printed the name as printed
 * @param {Array<{ id: string, name?: string, username?: string, preferredName?: string, role?: string }>} users
 * @returns {{ userId: string, name: string, via: 'full_name'|'first_initial'|'first_name'|'preferred_name', ambiguous: false } | { ambiguous: true, names: string[] } | null}
 */
function matchWorker(printed, users) {
  const p = norm(printed);
  if (!p) return null;
  const staff = (Array.isArray(users) ? users : []).filter((u) => u && u.id && u.name && !/^(client|owner)$/i.test(String(u.role || '')) && !u.disabled && !u.deleted);
  const pick = (list, via) => {
    if (list.length === 1) return { userId: list[0].id, name: list[0].name, via, ambiguous: false };
    if (list.length > 1) return { ambiguous: true, names: list.map((u) => u.name) };
    return null;
  };
  const full = staff.filter((u) => norm(u.name) === p);
  if (full.length) return pick(full, 'full_name');
  const parts = p.split(' ');
  if (parts.length === 2 && parts[1].length === 1) {
    const hit = staff.filter((u) => { const n = norm(u.name).split(' '); return n[0] === parts[0] && (n[n.length - 1] || '')[0] === parts[1]; });
    const r = pick(hit, 'first_initial');
    if (r) return r;
  }
  if (parts.length === 1) {
    const first = staff.filter((u) => norm(u.name).split(' ')[0] === p);
    const pref = staff.filter((u) => u.preferredName && norm(u.preferredName) === p && norm(u.name).split(' ')[0] !== p);
    const both = [...first, ...pref.filter((u) => !first.includes(u))];
    if (both.length === 1) return { userId: both[0].id, name: both[0].name, via: first.length ? 'first_name' : 'preferred_name', ambiguous: false };
    if (both.length > 1) return { ambiguous: true, names: both.map((u) => u.name) };
  }
  return null;
}

/** Jobs a worker put hours against on a day, from their time entry. Pure. */
function jobsFromEntry(entry) {
  if (!entry || entry.status === 'rejected' || !Array.isArray(entry.allocations)) return [];
  const out = [];
  for (const a of entry.allocations) {
    if (a && a.jobId && Number(a.hours) > 0 && !out.includes(a.jobId)) out.push(a.jobId);
  }
  return out;
}

module.exports = { extractPurchaserName, matchWorker, jobsFromEntry };
