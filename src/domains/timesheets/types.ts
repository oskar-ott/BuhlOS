import type { z } from "zod";
import type {
  TimeEntrySchema,
  TimeEntryAllocationSchema,
  TimeEntryStatusSchema,
  CreateTimeEntryPayloadSchema,
  PatchTimeEntryPayloadSchema,
  ApproveTimeEntryPayloadSchema,
  RejectTimeEntryPayloadSchema,
  TimeEntryListResponseSchema,
  TimeEntryMutationResponseSchema,
} from "./schema";

/**
 * Phase B timesheet entity types.
 *
 * The wire shape mirrors api/_lib/time-entries.js exactly. Field names that
 * look unusual (`rejectedReason`, not `rejectionReason`; `userId`, not
 * `workerId`) match the legacy server so the typed client can talk to the
 * existing endpoints unchanged.
 *
 * Cross-ref:
 *   docs/rebuild-audit/12-domain-model-deep-dive.md §Hours
 *   docs/rebuild-audit/19-phase-b-hours-implementation-brief.md
 *   api/_lib/time-entries.js
 */

export type TimeEntryStatus = z.infer<typeof TimeEntryStatusSchema>;

export type TimeEntryAllocation = z.infer<typeof TimeEntryAllocationSchema>;

export type TimeEntry = z.infer<typeof TimeEntrySchema>;

export type CreateTimeEntryPayload = z.infer<typeof CreateTimeEntryPayloadSchema>;

export type PatchTimeEntryPayload = z.infer<typeof PatchTimeEntryPayloadSchema>;

export type ApproveTimeEntryPayload = z.infer<typeof ApproveTimeEntryPayloadSchema>;

export type RejectTimeEntryPayload = z.infer<typeof RejectTimeEntryPayloadSchema>;

export type TimeEntryListResponse = z.infer<typeof TimeEntryListResponseSchema>;

export type TimeEntryMutationResponse = z.infer<typeof TimeEntryMutationResponseSchema>;
