import { z } from "zod";

/**
 * Site diary (#210) — the job's daily record.
 *
 * A per-job, date-keyed daily diary: what happened on site, the weather, an
 * optional delay flag (with a mandatory reason), and a FROZEN snapshot of the
 * admin-confirmed attendance for the day. It is the office's CONTEMPORANEOUS
 * record and doubles as delay-claim evidence, so the integrity rules are
 * non-negotiable and test-locked:
 *
 *   - ONE entry per (job, date). A duplicate create is a 409 pointing at the
 *     amend path; the original is never silently overwritten.
 *   - FUTURE dates are rejected (a diary records what happened, not what will).
 *   - When `delay.flagged`, `delay.reason` is required and non-empty.
 *   - The attendance snapshot is FROZEN at save — a later hours change must NOT
 *     mutate a saved entry. We DENORMALISE (userId, userName, hours, status) and
 *     stamp `attendanceSource { fetchedAt, adjusted }`.
 *   - Amendments are APPEND-ONLY: the original fields stay unchanged and visible;
 *     an amendment is a stamped delta in `amendments[]` (mirrors api/dayworks.js
 *     amendDocket, #370). No fabricated data, ever (P7).
 *
 * House pattern: `.passthrough()` so later fields don't break older parsers.
 */

export const DIARY_LIMITS = {
  /** Happenings free-text cap (server rejects overflow with 400). */
  maxHappenings: 5000,
  maxWeatherNote: 500,
  maxDelayReason: 2000,
  maxAttendanceRows: 200,
  maxAmendmentNote: 2000,
} as const;

/** A single attendance row — denormalised so a later hours edit can't mutate it. */
export const DiaryAttendanceRowSchema = z
  .object({
    userId: z.string(),
    userName: z.string(),
    hours: z.number(),
    status: z.string(),
  })
  .passthrough();

/** Provenance of the attendance snapshot. `adjusted` flags that the admin
 *  hand-edited the pre-filled rows before saving. */
export const DiaryAttendanceSourceSchema = z
  .object({
    fetchedAt: z.string().nullable().optional(),
    adjusted: z.boolean().default(false),
  })
  .passthrough();

/** The delay flag. When `flagged`, `reason` is required (enforced at create). */
export const DiaryDelaySchema = z
  .object({
    flagged: z.boolean().default(false),
    reason: z.string().nullable().optional(),
  })
  .passthrough();

/** An append-only amendment — a stamped delta. The original entry fields are
 *  NEVER mutated; the amendment carries only the changed fields + actor stamp. */
export const DiaryAmendmentSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    createdById: z.string(),
    createdByName: z.string(),
    createdByRole: z.string().nullable().optional(),
    /** Free-text note explaining the amendment. */
    note: z.string().nullable().optional(),
    /** The fields this amendment changes, as a sparse patch (happenings,
     *  weatherNote, delay). The original keeps its values; the UI shows the
     *  amendment beneath the original. */
    changes: z.record(z.unknown()),
  })
  .passthrough();

export const DiaryEntrySchema = z
  .object({
    id: z.string(), // di_…
    jobId: z.string(),
    /** YYYY-MM-DD in the Sydney calendar — the day the work happened. */
    date: z.string(),
    happenings: z.string(),
    weatherNote: z.string().nullable().optional(),
    delay: DiaryDelaySchema,
    attendance: z.array(DiaryAttendanceRowSchema).default([]),
    attendanceSource: DiaryAttendanceSourceSchema,
    amendments: z.array(DiaryAmendmentSchema).default([]),
    // Actor stamps.
    createdById: z.string(),
    createdByName: z.string(),
    createdByRole: z.string().nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string().optional(),
    auditLogIds: z.array(z.string()).default([]),
  })
  .passthrough();

// ── Input payloads ───────────────────────────────────────────────────────────

const CreateAttendanceRowSchema = z.object({
  userId: z.string().min(1),
  userName: z.string().trim().min(1),
  hours: z.number().finite().min(0),
  status: z.string().trim().min(1),
});

const CreateDelaySchema = z.object({
  flagged: z.boolean().optional(),
  reason: z.string().nullable().optional(),
});

const CreateAttendanceSourceSchema = z.object({
  fetchedAt: z.string().nullable().optional(),
  adjusted: z.boolean().optional(),
});

export const CreateDiaryPayloadSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  happenings: z.string().trim().min(1).max(DIARY_LIMITS.maxHappenings),
  weatherNote: z.string().max(DIARY_LIMITS.maxWeatherNote).nullable().optional(),
  delay: CreateDelaySchema.optional(),
  attendance: z.array(CreateAttendanceRowSchema).max(DIARY_LIMITS.maxAttendanceRows).optional(),
  attendanceSource: CreateAttendanceSourceSchema.optional(),
});

export const AmendDiaryPayloadSchema = z.object({
  id: z.string().min(1),
  note: z.string().max(DIARY_LIMITS.maxAmendmentNote).nullable().optional(),
  /** A sparse patch of the changed fields. */
  changes: z
    .object({
      happenings: z.string().trim().min(1).max(DIARY_LIMITS.maxHappenings).optional(),
      weatherNote: z.string().max(DIARY_LIMITS.maxWeatherNote).nullable().optional(),
      delay: CreateDelaySchema.optional(),
    })
    .refine((c) => Object.keys(c).length > 0, {
      message: "an amendment must change at least one field",
    }),
});

// ── API responses ─────────────────────────────────────────────────────────────

/** GET /api/diary?jobId&fromDate&toDate — date-keyed entries in range. */
export const DiaryListResponseSchema = z.object({
  entries: z.array(DiaryEntrySchema),
  filters: z
    .object({
      jobId: z.string(),
      fromDate: z.string().nullable(),
      toDate: z.string().nullable(),
    })
    .passthrough(),
});
