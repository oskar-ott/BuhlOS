import type { z } from "zod";
import type {
  AmendDiaryPayloadSchema,
  CreateDiaryPayloadSchema,
  DiaryAmendmentSchema,
  DiaryAttendanceRowSchema,
  DiaryAttendanceSourceSchema,
  DiaryDelaySchema,
  DiaryEntrySchema,
  DiaryListResponseSchema,
} from "./schema";

/** Inferred types for the diary domain. Consumers import these, never the Zod
 *  schemas (house pattern, jobs/types.ts). */

export type DiaryAttendanceRow = z.infer<typeof DiaryAttendanceRowSchema>;
export type DiaryAttendanceSource = z.infer<typeof DiaryAttendanceSourceSchema>;
export type DiaryDelay = z.infer<typeof DiaryDelaySchema>;
export type DiaryAmendment = z.infer<typeof DiaryAmendmentSchema>;
export type DiaryEntry = z.infer<typeof DiaryEntrySchema>;

export type CreateDiaryPayload = z.infer<typeof CreateDiaryPayloadSchema>;
export type AmendDiaryPayload = z.infer<typeof AmendDiaryPayloadSchema>;

export type DiaryListResponse = z.infer<typeof DiaryListResponseSchema>;
