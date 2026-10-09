'use strict';

// Workshop Stock permissions — one place, server-side, role-tier predicates only
// (docs/roles.md: never compare role strings). Pure.
//
//   employees (field tier, leading hands, office)
//       view stock, add / take / return existing stock, create a NEW item through
//       the constrained add flow (name, codes, unit, location, photo, opening
//       quantity — nothing else), read a photo, run an online code check, undo
//       their OWN recent add / take / return / opening
//   office (admin tier)
//       everything above, plus: edit catalogue details, manage identifiers and
//       pack conversions, change photos, correct counts, archive / restore, see
//       full history, and undo any movement (with a reason)
//   clients, unknown roles, signed-out
//       nothing (401 / 403 before any data is read)
//
// THE UNDO POLICY (documented in docs/workshop-stock.md):
//   • a worker may undo a movement THEY made, of kind opening / add / take /
//     return, within WORKER_UNDO_MINUTES of the server timestamp
//   • the office may undo any movement except an undo, at any time, and must
//     give a short reason
//   • a movement is undone at most once; an undo is never itself undone (record
//     the stock again instead); an undo that would take recorded stock below zero
//     is refused (the store checks that on the locked balance)
//   • nobody undoes a movement that a later count has absorbed — the count
//     already corrected it; correct the count instead (the store re-checks
//     under the item lock, and the ledger trigger refuses it too)

const { isAdminRole, isFieldRole, isLeadingHandRole } = require('../auth');

const WORKER_UNDO_MINUTES = 30;
const WORKER_UNDOABLE = new Set(['opening', 'add', 'take', 'return']);

function isEmployee(role) {
  return isAdminRole(role) || isLeadingHandRole(role) || isFieldRole(role);
}

function isOffice(role) {
  return isAdminRole(role);
}

/**
 * May `viewer` undo `movement`? Returns null when allowed, else a stable error
 * code. `nowMs` is the server clock.
 */
function undoDenial(movement, viewer, { nowMs = Date.now(), reason = '' } = {}) {
  if (!movement) return 'movement_not_found';
  if (movement.kind === 'reversal') return 'cannot_undo_undo';
  if (movement.reversedBy) return 'already_undone';
  if (movement.countedSince) return 'undo_counted_since';
  if (isOffice(viewer.role)) {
    return String(reason || '').trim().length >= 3 ? null : 'reason_required';
  }
  if (!isEmployee(viewer.role)) return 'forbidden';
  if (movement.actorId !== viewer.id) return 'undo_not_yours';
  if (!WORKER_UNDOABLE.has(movement.kind)) return 'undo_office_only';
  const age = nowMs - Date.parse(movement.createdAt);
  if (!Number.isFinite(age) || age > WORKER_UNDO_MINUTES * 60_000) return 'undo_window_passed';
  return null;
}

/** Light eligibility hint for a list row (the store re-checks under lock). */
function canUndo(movement, viewer, nowMs = Date.now()) {
  const d = undoDenial(movement, viewer, { nowMs, reason: 'office review' });
  return d === null;
}

module.exports = { WORKER_UNDO_MINUTES, isEmployee, isOffice, undoDenial, canUndo };
