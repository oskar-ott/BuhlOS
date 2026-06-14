import type { z } from "zod";
import type {
  CreateDayworkPayloadSchema,
  DayworkLabourLineSchema,
  DayworkMaterialLineSchema,
  DayworkSchema,
  DayworkSignatureSchema,
  DayworkStatusSchema,
  SignDayworkPayloadSchema,
  UpdateDayworkStatusPayloadSchema,
} from "./schema";

/** Inferred types for the dayworks domain. Consumers import these, never the
 *  Zod schemas (house pattern, jobs/types.ts). */

export type DayworkStatus = z.infer<typeof DayworkStatusSchema>;
export type DayworkLabourLine = z.infer<typeof DayworkLabourLineSchema>;
export type DayworkMaterialLine = z.infer<typeof DayworkMaterialLineSchema>;
export type DayworkSignature = z.infer<typeof DayworkSignatureSchema>;
export type Daywork = z.infer<typeof DayworkSchema>;

export type CreateDayworkPayload = z.infer<typeof CreateDayworkPayloadSchema>;
export type SignDayworkPayload = z.infer<typeof SignDayworkPayloadSchema>;
export type UpdateDayworkStatusPayload = z.infer<typeof UpdateDayworkStatusPayloadSchema>;
