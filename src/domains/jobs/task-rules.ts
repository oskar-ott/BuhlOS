/**
 * Rule-based task generation (#224) — TYPES + advisory UI validation.
 *
 * The generation ENGINE is CJS (api/_lib/task-rules.js), the single source of
 * truth shared by both serverless handlers (api/task-rules.js maintains the rule
 * set; api/generate-tasks.js applies it). This module carries only what the
 * admin UI needs: the rule shape and a client-side validity check that mirrors
 * the server's (the server is authoritative; this is for instant form feedback).
 */

export interface TaskRule {
  id: string;
  /** Match: the job's `type` id, or null = any job type (wildcard). */
  jobType: string | null;
  /** Match: case-insensitive substring of the AREA name, or null = any area. */
  areaPattern: string | null;
  /** Task names to seed into a matching area's rough-in list. */
  roughIn: string[];
  /** Task names to seed into a matching area's fit-off list. */
  fitOff: string[];
}

/** How an area's existing (non-empty) stage list is treated on generation. */
export type GenerationMode = "fill-empty" | "merge";

export interface GenerationSummary {
  areasMatched: number;
  areasFilled: number;
  roughInAdded: number;
  fitOffAdded: number;
  areasSkippedNonEmpty: number;
}

export interface RuleValidationError {
  index: number;
  message: string;
}

function cleanNames(names: ReadonlyArray<string>): string[] {
  return names.map((n) => (n ?? "").trim()).filter((n) => n.length > 0);
}

/**
 * Advisory client-side validation (the server's normaliseRules is authoritative):
 * a rule must seed at least one task, and the area pattern is length-capped.
 */
export function validateRules(rules: ReadonlyArray<Partial<TaskRule>>): RuleValidationError[] {
  const errors: RuleValidationError[] = [];
  rules.forEach((r, index) => {
    if (cleanNames(r.roughIn ?? []).length === 0 && cleanNames(r.fitOff ?? []).length === 0) {
      errors.push({ index, message: "A rule needs at least one rough-in or fit-off task" });
    }
    if ((r.areaPattern ?? "").length > 120) {
      errors.push({ index, message: "Area pattern is too long" });
    }
  });
  return errors;
}
