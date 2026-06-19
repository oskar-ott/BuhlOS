import { evaluateAgainstCriteria } from "./criteria";
import {
  TestRecordSchema,
  type TestRecord,
  type TestRecordInput,
  type TestRecordRow,
  type TestRecordRowInput,
  type TestStatus,
} from "./schema";

/**
 * Pure derivation for structured test records (#517). Pass/fail is NEVER taken
 * from the client — it is derived here from the measured value against the row's
 * criteria via the one shared rule (`criteria.ts`). This is what lets a TestRecord
 * honestly stand as `test_result` proof: a row with no value, or a value outside
 * its limits, cannot read "pass".
 */

/** Derive one row's status: pass/fail from the measured value vs its min/max,
 *  or `na` when there is no criterion or no numeric value to judge. */
export function deriveRowStatus(row: TestRecordRowInput): TestStatus {
  const result = evaluateAgainstCriteria(row.value, row.min, row.max);
  return result ?? "na";
}

/** Roll the rows up: any failing row fails the record; otherwise pass when at
 *  least one row passed; otherwise `na` (nothing judged). */
export function deriveOverallStatus(rows: ReadonlyArray<{ status: TestStatus }>): TestStatus {
  if (rows.some((r) => r.status === "fail")) return "fail";
  if (rows.some((r) => r.status === "pass")) return "pass";
  return "na";
}

/**
 * Build a stored, validated TestRecord from a parsed input: derive every row's
 * status and the overall status, stamp id + audit, and re-parse through the
 * schema so the persisted shape is always valid. Pure — id/time/actor injected.
 */
export function buildTestRecord(
  input: TestRecordInput,
  ctx: { id: string; at: string; createdBy?: string | null },
): TestRecord {
  const rows: TestRecordRow[] = input.rows.map((row) => ({
    ...row,
    status: deriveRowStatus(row),
  }));
  return TestRecordSchema.parse({
    ...input,
    id: ctx.id,
    rows,
    overallStatus: deriveOverallStatus(rows),
    createdAt: ctx.at,
    ...(ctx.createdBy != null ? { createdBy: ctx.createdBy } : {}),
  });
}
