// Employee-match suggestions (#248) — PURE scoring, no IO, no side effects.
//
// A suggestion is NEVER a link: only an explicit admin confirm creates a
// mapping. This module just ranks the signals honestly:
//
//   1. email exact (case-insensitive)   — users.json holds real emails; the
//      strongest signal we have (audit ruling: email-exact first)
//   2. legacy free-text xeroEmployeeId  — admin-typed, unvalidated; matching
//      a real EmployeeID is meaningful but historically messy, so it ranks
//      below an email match. A legacy id matching NO current employee is
//      returned as an INVALID legacy id (visible, never dropped).
//   3. full-name exact (case-insensitive, trimmed) — usernames are display
//      names by convention (api/employees.js splits them on whitespace —
//      proof name-matching is guesswork), so names are the weakest signal.
//
// Duplicate legacy ids (two workers hand-typed the same Xero id) are a NAMED
// conflict on every involved worker — never two silent suggestions.

const REASON_RANK = { email: 0, legacy_id: 1, name: 2 };

function norm(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

/**
 * @param {Array<{id: string, username?: string, name?: string, email?: string, xeroEmployeeId?: string}>} workers
 * @param {Array<{xeroId: string, name: string, active: boolean, payload?: {email?: string|null, status?: string|null}}>} employees
 *   the #610 reference cache rows (allow-listed payloads)
 * @returns {Map<string, {
 *   suggestion: { employeeId: string, employeeName: string, reason: 'email'|'legacy_id'|'name' } | null,
 *   invalidLegacyId: string | null,
 *   legacyConflictWith: string[] }>} keyed by worker id
 */
function suggestEmployeeMatches(workers, employees) {
  const byEmail = new Map();
  const byId = new Map();
  const byName = new Map();
  for (const e of employees) {
    byId.set(e.xeroId, e);
    const email = norm(e.payload && e.payload.email);
    if (email && !byEmail.has(email)) byEmail.set(email, e);
    const name = norm(e.name);
    if (name) byName.set(name, byName.has(name) ? null : e); // duplicate names → ambiguous, no suggestion
  }

  // duplicate legacy ids across workers → conflict, not suggestion
  const legacyUsers = new Map();
  for (const w of workers) {
    const legacy = norm(w.xeroEmployeeId);
    if (!legacy) continue;
    if (!legacyUsers.has(legacy)) legacyUsers.set(legacy, []);
    legacyUsers.get(legacy).push(w.id);
  }

  const out = new Map();
  for (const w of workers) {
    const candidates = [];
    const email = norm(w.email);
    if (email && byEmail.has(email)) {
      const e = byEmail.get(email);
      candidates.push({ employeeId: e.xeroId, employeeName: e.name, reason: 'email' });
    }
    const legacyRaw = w.xeroEmployeeId == null ? '' : String(w.xeroEmployeeId).trim();
    const legacy = norm(legacyRaw);
    let invalidLegacyId = null;
    let legacyConflictWith = [];
    if (legacy) {
      const holders = (legacyUsers.get(legacy) || []).filter((id) => id !== w.id);
      if (holders.length) {
        legacyConflictWith = holders;
      } else if (byId.has(legacyRaw)) {
        const e = byId.get(legacyRaw);
        candidates.push({ employeeId: e.xeroId, employeeName: e.name, reason: 'legacy_id' });
      } else {
        invalidLegacyId = legacyRaw; // visible stale value, never dropped
      }
    }
    const displayName = norm(w.name || w.username);
    if (displayName && byName.get(displayName)) {
      const e = byName.get(displayName);
      candidates.push({ employeeId: e.xeroId, employeeName: e.name, reason: 'name' });
    }
    candidates.sort((a, b) => REASON_RANK[a.reason] - REASON_RANK[b.reason]);
    out.set(w.id, {
      suggestion: candidates.length ? candidates[0] : null,
      invalidLegacyId,
      legacyConflictWith,
    });
  }
  return out;
}

module.exports = { suggestEmployeeMatches };
