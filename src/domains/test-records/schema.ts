import { z } from "zod";

/**
 * Structured electrical test results (#517) — the schema for a TestRecord and
 * its per-circuit rows. A TestRecord is a facet of a task (optional
 * areaId/stage/taskId scope) under a job, capturing the measured values an
 * electrician records when testing circuits (continuity, insulation resistance,
 * polarity, Zs, RCD…). Pass/fail per row is DERIVED, never client-asserted —
 * see `derive.ts`, which uses the one shared rule (`criteria.ts`).
 *
 * Objects are `.passthrough()` for forward-compatibility (new report fields flow
 * through unrejected), mirroring the job-control schema convention.
 */

/** The electrical test a row records. `other` keeps the set open for the
 *  long tail without a schema change; the value passes through verbatim. */
export const TEST_TYPES = [
  "continuity_r1r2",
  "continuity_r2",
  "ring_continuity",
  "insulation_resistance",
  "polarity",
  "earth_fault_loop_zs",
  "earth_electrode_resistance",
  "prospective_fault_current",
  "rcd_trip_time",
  "rcd_trip_current",
  "functional",
  "other",
] as const;
export const TestTypeSchema = z.enum(TEST_TYPES);
export type TestType = z.infer<typeof TestTypeSchema>;

/** The certificate/report a record belongs to (site metadata). */
export const REPORT_TYPES = ["eicr", "eic", "minor_works", "other"] as const;
export const ReportTypeSchema = z.enum(REPORT_TYPES);
export type ReportType = z.infer<typeof ReportTypeSchema>;

/** A derived per-row / overall outcome. `na` = no criterion or no numeric value
 *  to judge (the one rule returned null). */
export const TEST_STATUSES = ["pass", "fail", "na"] as const;
export const TestStatusSchema = z.enum(TEST_STATUSES);
export type TestStatus = z.infer<typeof TestStatusSchema>;

/** One circuit/test line as SUBMITTED — no derived status (the server derives it). */
export const TestRecordRowInputSchema = z
  .object({
    /** Circuit reference, e.g. "Ring final — kitchen sockets". */
    circuit: z.string().min(1),
    testType: TestTypeSchema,
    /** Measured value (Ω, MΩ, ms, mA, …). Null when not yet recorded. */
    value: z.number().nullable().optional(),
    unit: z.string().nullable().optional(),
    /** Inclusive pass criteria — either, both, or neither. */
    min: z.number().nullable().optional(),
    max: z.number().nullable().optional(),
    note: z.string().nullable().optional(),
  })
  .passthrough();
export type TestRecordRowInput = z.infer<typeof TestRecordRowInputSchema>;

/** A stored row — the submitted shape plus its DERIVED pass/fail/na status. */
export const TestRecordRowSchema = TestRecordRowInputSchema.extend({
  status: TestStatusSchema,
});
export type TestRecordRow = z.infer<typeof TestRecordRowSchema>;

/** A TestRecord as SUBMITTED (POST body) — no id, no derived statuses. */
export const TestRecordInputSchema = z
  .object({
    jobId: z.string().min(1),
    /** Optional task-facet scope (a record may cover a whole job or one area/task). */
    areaId: z.string().nullable().optional(),
    stage: z.string().nullable().optional(),
    taskId: z.string().nullable().optional(),
    reportType: ReportTypeSchema.default("other"),
    siteAddress: z.string().nullable().optional(),
    rows: z.array(TestRecordRowInputSchema).min(1),
    /** Who performed the test (named, never inferred). */
    tester: z.string().min(1),
    /** When the test was performed (ISO). */
    testedAt: z.string().min(1),
    note: z.string().nullable().optional(),
    /** AC3 — immutability/supersede. A correction is a NEW record that names the
     *  record it replaces; records are never edited in place. The superseded
     *  record's id (`tr_…`) on this job. Absent = a fresh, non-superseding record. */
    supersedesId: z.string().nullable().optional(),
  })
  .passthrough();
export type TestRecordInput = z.infer<typeof TestRecordInputSchema>;

/** A stored TestRecord — submitted fields, derived row statuses + overall, id + audit. */
export const TestRecordSchema = TestRecordInputSchema.extend({
  id: z.string().min(1),
  rows: z.array(TestRecordRowSchema).min(1),
  overallStatus: TestStatusSchema,
  createdAt: z.string().min(1),
  createdBy: z.string().nullable().optional(),
}).passthrough();
export type TestRecord = z.infer<typeof TestRecordSchema>;

/** The per-job persisted store shape (`jobs/<jobId>/test-records.json`). */
export const TestRecordStoreSchema = z
  .object({
    records: z.array(TestRecordSchema).default([]),
  })
  .passthrough();
export type TestRecordStore = z.infer<typeof TestRecordStoreSchema>;

export const TEST_RECORD_ID_PREFIX = "tr_";
