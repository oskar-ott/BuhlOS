import { z } from "zod";
import { httpGet, type HttpResult } from "@/lib/http";

/** Client for GET /api/crew-week (#337). Admin-tier only on the server. */

const DaySchema = z.object({
  date: z.string(),
  state: z.enum(["leave", "assigned", "free"]),
  leaveType: z.string().nullable(),
});

export const CrewWeekResponseSchema = z.object({
  weekStart: z.string(),
  weekDays: z.array(z.string()),
  workers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      role: z.string(),
      assignedJobNames: z.array(z.string()),
      days: z.array(DaySchema),
    }),
  ),
});
export type CrewWeekResponse = z.infer<typeof CrewWeekResponseSchema>;
export type CrewWeekDay = z.infer<typeof DaySchema>;

export async function fetchCrewWeek(weekStart?: string): Promise<HttpResult<CrewWeekResponse>> {
  const qs = weekStart ? `?weekStart=${encodeURIComponent(weekStart)}` : "";
  return httpGet(`/api/crew-week${qs}`, { schema: CrewWeekResponseSchema });
}
