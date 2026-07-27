import { z } from "zod";

/**
 * Certainty — the builder-time triage lifecycle of a cert-bearing item (a scope
 * line, a task, an area, a requirement) in the Job Builder cockpit (§4).
 *
 * The persisted job model carries no certainty; this is the office's running
 * decision state ABOUT a proposed item as it moves from a suggestion toward
 * something the field is allowed to see. It is the pure engine behind the
 * CertaintyChip, the readiness meter, the review queue and the publish gate —
 * no fetch, no React, so every rule here is unit-testable.
 *
 * Hard rules (the brief's §4 non-negotiables, encoded as the state machine):
 *   - Confirmation is ALWAYS an explicit human act. No transition auto-confirms
 *     or auto-converts a suggestion.
 *   - Only `confirmed` and `converted` are field-eligible — a raw suggestion
 *     never reaches the crew.
 *   - `rfi` is the explicit unknown — a raised question, never a guess. It is
 *     acknowledged (out of the review queue) but NOT resolved: it keeps
 *     depressing readiness until it's answered.
 * */

export const CERTAINTY_STATES = [
  "suggested", // proposed by import/AI; not yet triaged
  "needs_review", // a human flagged it for a decision (≡ reconciliation `unclear`)
  "confirmed", // an explicit human act — field-eligible
  "converted", // confirmed AND realised as a task instance — field-eligible
  "ignored", // triaged out — not field-relevant (rendered struck-through)
  "rfi", // the explicit unknown — a raised question, never a guess
] as const;

export type CertaintyState = (typeof CERTAINTY_STATES)[number];

export const CertaintyStateSchema = z.enum(CERTAINTY_STATES);

/** Fixed wording — the chip never invents a synonym (StatusChip marker law). */
export const CERTAINTY_LABEL: Record<CertaintyState, string> = {
  suggested: "Suggested",
  needs_review: "Needs review",
  confirmed: "Confirmed",
  converted: "Converted",
  ignored: "Ignored",
  rfi: "RFI",
};

/* ---------------------------------------------------------------------
 * Predicates
 * -------------------------------------------------------------------*/

/** Only confirmed/converted items reach assigned field crew. */
export function isFieldEligible(state: CertaintyState): boolean {
  return state === "confirmed" || state === "converted";
}

/**
 * Items that still owe the office a decision — they populate the review queue
 * and block publish. RFI is deliberately NOT here: it's acknowledged, parked on
 * an answer, not awaiting a triage swipe.
 */
export function needsTriage(state: CertaintyState): boolean {
  return state === "suggested" || state === "needs_review";
}

/**
 * Items the office has dispositioned — they count toward the readiness %. An RFI
 * is acknowledged but unanswered, so it is intentionally NOT resolved.
 */
export function isResolved(state: CertaintyState): boolean {
  return state === "confirmed" || state === "converted" || state === "ignored";
}

/** The explicit unknown — raised, not guessed; awaiting an answer. */
export function isRfi(state: CertaintyState): boolean {
  return state === "rfi";
}

/* ---------------------------------------------------------------------
 * Transition machine
 * -------------------------------------------------------------------*/

/**
 * The allowed moves. Two invariants the brief insists on:
 *   - `converted` is reachable ONLY from `confirmed` — you confirm, THEN realise
 *     a task. Nothing auto-converts a suggestion.
 *   - any state can be pulled back to `needs_review` (the office can always
 *     re-open something) and triaged to `ignored` or raised as an `rfi`.
 */
const ALLOWED_TRANSITIONS: Record<CertaintyState, ReadonlyArray<CertaintyState>> = {
  suggested: ["needs_review", "confirmed", "ignored", "rfi"],
  needs_review: ["confirmed", "ignored", "rfi"],
  confirmed: ["converted", "needs_review", "ignored", "rfi"],
  converted: ["confirmed", "needs_review", "ignored"],
  ignored: ["needs_review", "confirmed"],
  rfi: ["needs_review", "confirmed", "ignored"],
};

/** The states a row can legally move to from `from` (excludes a no-op). */
export function availableTransitions(from: CertaintyState): ReadonlyArray<CertaintyState> {
  return ALLOWED_TRANSITIONS[from];
}

/** Whether `from → to` is a legal, non-trivial move. */
export function canTransition(from: CertaintyState, to: CertaintyState): boolean {
  if (from === to) return false;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Apply a transition. Returns the target on a legal move, or throws on an
 * illegal one so a caller can never silently land a row in an impossible state.
 */
export function transition(from: CertaintyState, to: CertaintyState): CertaintyState {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal certainty transition: ${from} → ${to}`);
  }
  return to;
}
