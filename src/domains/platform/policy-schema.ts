import { z } from "zod";

/**
 * #222 — advisory client-side schemas for the v2 /settings hub.
 *
 * These mirror what `api/policy.js` and `api/job-types.js` enforce server-side;
 * they are ADVISORY (the endpoints stay authoritative). The point is to fail a
 * bad input in the form before a round-trip, with the same bounds the server
 * uses, so the UI never sends a value the API will 400.
 *
 *  - `api/policy.js` PUT requires `hours.dailyThreshold` to be a finite number
 *    in `[1, 24]` (it rounds to 2dp on write).
 *  - `api/job-types.js` stores `{ jobTypes: [{ id, name }] }`; create/update
 *    require a non-empty trimmed `name`.
 *
 * No new persistence is introduced — these are parse/reject helpers only.
 */

/** The hours-policy slice the PUT body carries. */
export const HoursPolicySchema = z.object({
  dailyThreshold: z
    .number()
    .finite()
    .min(1, "Daily threshold must be at least 1 hour")
    .max(24, "Daily threshold can't exceed 24 hours"),
});
export type HoursPolicyInput = z.infer<typeof HoursPolicySchema>;

/** The full PUT /api/policy body the form submits. */
export const PolicyPutSchema = z.object({
  hours: HoursPolicySchema,
});
export type PolicyPutInput = z.infer<typeof PolicyPutSchema>;

/** A single job type as stored / listed. */
export const JobTypeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});
export type JobTypeInput = z.infer<typeof JobTypeSchema>;

/** The job-types collection (`GET ?action=list` shape). */
export const JobTypesSchema = z.object({
  jobTypes: z.array(JobTypeSchema),
});
export type JobTypesInput = z.infer<typeof JobTypesSchema>;

/**
 * Validate a daily-threshold input the way the server will. Accepts a raw value
 * (e.g. a parsed input string) and returns either the clean number or an error
 * message — never throws. Advisory: a green result here does NOT replace the
 * server's own 400.
 */
export function validateDailyThreshold(
  value: unknown,
): { ok: true; value: number } | { ok: false; error: string } {
  const parsed = HoursPolicySchema.safeParse({ dailyThreshold: value });
  if (parsed.success) return { ok: true, value: parsed.data.dailyThreshold };
  const first = parsed.error.issues[0];
  return {
    ok: false,
    error: first?.message ?? "Daily threshold must be a number between 1 and 24",
  };
}

/** Validate a job-type name the way create/update will. */
export function validateJobTypeName(
  name: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = typeof name === "string" ? name.trim() : "";
  const parsed = z.string().min(1).safeParse(trimmed);
  if (parsed.success) return { ok: true, value: trimmed };
  return { ok: false, error: "Name can't be empty" };
}
