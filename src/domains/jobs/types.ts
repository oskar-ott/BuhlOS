import type { z } from "zod";
import type {
  CustomFieldSchema,
  JobAreaGroupSchema,
  JobAreaSchema,
  JobDetailResponseSchema,
  JobListResponseSchema,
  JobModulesSchema,
  JobSchema,
  JobStatusSchema,
  JobTaskTemplateSchema,
} from "./schema";

/**
 * Inferred types for the jobs domain. Components import these — never the
 * Zod schemas — so the validation layer stays an implementation detail of
 * the client.
 */

export type JobStatus = z.infer<typeof JobStatusSchema>;
export type JobModules = z.infer<typeof JobModulesSchema>;
export type JobTaskTemplate = z.infer<typeof JobTaskTemplateSchema>;
export type CustomField = z.infer<typeof CustomFieldSchema>;
export type JobArea = z.infer<typeof JobAreaSchema>;
export type JobAreaGroup = z.infer<typeof JobAreaGroupSchema>;
export type Job = z.infer<typeof JobSchema>;

export type JobListResponse = z.infer<typeof JobListResponseSchema>;
export type JobDetailResponse = z.infer<typeof JobDetailResponseSchema>;

/**
 * The two stages every job moves through. Mirrors the legacy
 * `roughIn` / `fitOff` enum in api/_lib/job-tasks.js. Phase D1 surfaces the
 * chooser; Phase D3 wires the task toggle to /api/task-toggle.
 */
export type JobStage = "roughIn" | "fitOff";
