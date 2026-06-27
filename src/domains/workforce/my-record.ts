import { z } from "zod";

/**
 * "Your work record" (#340) — zod contract for the self-only `window` block
 * on GET /api/my-stats. The endpoint rolls the caller's OWN time entries into
 * a trailing-weeks summary (api/_lib/my-record.js); the Phil More-tab card
 * (PhilMyRecordCard) renders it. There is no userId parameter — the session
 * cookie is the identity, so a worker only ever sees their own record.
 *
 * Honesty (P7): every number is a real recorded total. A new starter with no
 * history still gets the real calendar of weeks (each 0h) and an empty `jobs`
 * list — a true zero, never a fabricated one. The card frames the empty state.
 *
 * The schema is permissive on the rest of /api/my-stats (today/thisWeek/
 * thisMonth are owned by other surfaces); we parse only the `window` block the
 * card consumes, so adding fields elsewhere never breaks this card.
 */

export const MyRecordWeekSchema = z.object({
  weekStart: z.string(),
  weekEnd: z.string(),
  totalHours: z.number(),
});

export const MyRecordJobSchema = z.object({
  jobId: z.string(),
  jobName: z.string(),
  hours: z.number(),
});

export const MyRecordWindowSchema = z.object({
  weeks: z.array(MyRecordWeekSchema),
  jobs: z.array(MyRecordJobSchema),
  totalHours: z.number(),
  weekCount: z.number(),
  windowStart: z.string(),
  windowEnd: z.string(),
});

/** Parse just the `window` block off the (larger) /api/my-stats response. */
export const MyStatsRecordResponseSchema = z
  .object({
    window: MyRecordWindowSchema,
  })
  .passthrough();

export type MyRecordWeek = z.infer<typeof MyRecordWeekSchema>;
export type MyRecordJob = z.infer<typeof MyRecordJobSchema>;
export type MyRecordWindow = z.infer<typeof MyRecordWindowSchema>;
