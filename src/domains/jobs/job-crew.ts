import { z } from "zod";

/**
 * "Who's on this job today" (#426) — the read shape of the EXISTING endpoint
 * GET /api/time-entries-on-site?jobId=<id>&date=YYYY-MM-DD, which returns the
 * crew who've logged time on a job for a date, gated by job-assignment access.
 * No new endpoint — this is just the typed client the Phil job-crew card uses.
 */
export const JobCrewMemberSchema = z.object({
  id: z.string(),
  username: z.string(),
  hours: z.number(),
});
export type JobCrewMember = z.infer<typeof JobCrewMemberSchema>;

export const JobCrewResponseSchema = z.object({
  count: z.number(),
  users: z.array(JobCrewMemberSchema),
});
export type JobCrewResponse = z.infer<typeof JobCrewResponseSchema>;

export type JobCrewResult =
  | { ok: true; data: JobCrewResponse }
  | { ok: false; error: string };

/**
 * Fetch today's on-site crew for a job. Read-only, client-side — degrades on
 * its own so it never blocks the job render. A 403 (no access) and a network
 * failure both resolve to an honest `{ ok: false }` the card shows quietly.
 */
export async function fetchJobCrew(jobId: string): Promise<JobCrewResult> {
  try {
    const res = await fetch(
      `/api/time-entries-on-site?jobId=${encodeURIComponent(jobId)}`,
      { cache: "no-store" },
    );
    if (!res.ok) return { ok: false, error: `on-site read failed (${res.status})` };
    const body = await res.json().catch(() => null);
    const parsed = JobCrewResponseSchema.safeParse(body);
    if (!parsed.success) return { ok: false, error: "unexpected response shape" };
    return { ok: true, data: parsed.data };
  } catch {
    return { ok: false, error: "couldn't reach the server" };
  }
}
