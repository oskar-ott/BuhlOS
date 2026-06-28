import type { InstructionStatus, SiteInstruction } from "./schema";

/**
 * Pure derivations for the site-instructions register (#283). The handler
 * (api/site-instructions.js) owns the writes; this module owns the read-side
 * rules the page renders and the invariants both sides agree on. Kept pure so
 * the ref numbering, the state machine, and the attention sort are unit-tested
 * without a server.
 */

/** "SI-" + zero-padded sequence. Three digits until SI-999, then it just grows. */
export function formatInstructionRef(seq: number): string {
  return `SI-${String(seq).padStart(3, "0")}`;
}

/** Parse the numeric sequence out of an "SI-NNN" ref, or null if it doesn't fit. */
export function parseInstructionRef(ref: string): number | null {
  const m = /^SI-(\d+)$/.exec(String(ref || "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The next register ref for a job, given everything already recorded. Always
 * max-seen + 1 (never a gap-fill — a reused SI number would forge history).
 * The caller MUST re-read the store immediately before assigning so two
 * concurrent records can't collide on the same number.
 */
export function nextInstructionRef(existing: ReadonlyArray<{ ref: string }>): string {
  let max = 0;
  for (const e of existing) {
    const n = parseInstructionRef(e.ref);
    if (n != null && n > max) max = n;
  }
  return formatInstructionRef(max + 1);
}

/**
 * Lifecycle. recorded → acknowledged → closed, plus the verbal-only shortcut
 * recorded → closed (some instructions never need a formal ack). Never
 * backwards, never out of closed — the register is a standing record.
 */
export const ALLOWED_INSTRUCTION_TRANSITIONS: Readonly<Record<InstructionStatus, ReadonlyArray<InstructionStatus>>> = {
  recorded: ["acknowledged", "closed"],
  acknowledged: ["closed"],
  closed: [],
};

export function canTransitionInstruction(from: InstructionStatus, to: InstructionStatus): boolean {
  return ALLOWED_INSTRUCTION_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * The instruction text is frozen once it leaves `recorded`: the acknowledgement
 * quoted it verbatim, so the stored words and the sent words must never
 * diverge. A post-ack correction is a new linked instruction, not an edit.
 */
export function isInstructionTextFrozen(status: InstructionStatus): boolean {
  return status !== "recorded";
}

/**
 * The register's top attention state: an instruction flagged as carrying a
 * cost/time implication with nothing spawned yet — that is free work in
 * progress until it becomes an RFI or a variation. A closed instruction is
 * settled and never flagged.
 */
export function isAwaitingSpawn(si: SiteInstruction): boolean {
  return (
    si.costTimeImplication === true &&
    si.status !== "closed" &&
    si.linkedRfiId == null &&
    si.linkedVariationId == null
  );
}

/** How many instructions are the "implication flagged, nothing spawned" rows. */
export function awaitingSpawnCount(instructions: ReadonlyArray<SiteInstruction>): number {
  return instructions.reduce((n, si) => n + (isAwaitingSpawn(si) ? 1 : 0), 0);
}

/**
 * Register display order: the flagged-but-unlinked rows first (the free-work
 * risk the office must act on), then newest received first, ref as the stable
 * tiebreak. Returns a new array — never mutates the input.
 */
export function sortInstructionsForRegister(
  instructions: ReadonlyArray<SiteInstruction>,
): SiteInstruction[] {
  return [...instructions].sort((a, b) => {
    const aa = isAwaitingSpawn(a);
    const ba = isAwaitingSpawn(b);
    if (aa !== ba) return aa ? -1 : 1;
    if (a.dateReceived !== b.dateReceived) return b.dateReceived.localeCompare(a.dateReceived);
    return b.ref.localeCompare(a.ref);
  });
}
