import { z } from "zod";

/**
 * #276 — per-job RFI (Request For Information) register.
 *
 * When the drawings don't say where the panel goes, someone asks the builder.
 * Today the question, who it went to, when, and the answer live in one person's
 * phone — and an unanswered question silently stalls an area (delay the
 * contractor eats). This is the formal register: raise → send → answered →
 * closed, with a response-due deadline, overdue surfacing, and the answer stored
 * as the record the job relies on.
 *
 * Per-job store jobs/<jobId>/rfis.json (like snags). v1 has no cross-job index.
 */

export const RFI_STATUSES = ["open", "sent", "answered", "closed"] as const;
export type RfiStatus = (typeof RFI_STATUSES)[number];

export const RFI_STATUS_LABEL: Record<RfiStatus, string> = {
  open: "Open",
  sent: "Sent",
  answered: "Answered",
  closed: "Closed",
};

export const RfiSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  /** Sequential per-job reference, e.g. "RFI-001" — appears in the email subject. */
  ref: z.string(),
  subject: z.string(),
  question: z.string(),
  /** Who it's asked of (a per-job contact name/email). May be "". */
  askedOf: z.string(),
  status: z.enum(RFI_STATUSES),
  /** Response-due date (ISO YYYY-MM-DD) or "" — drives overdue surfacing. */
  responseDue: z.string(),
  sentAt: z.string().nullable(),
  answer: z.string(),
  answeredAt: z.string().nullable(),
  answeredBy: z.string().nullable(),
  /** Reason recorded when closed WITHOUT an answer ("no longer required"). */
  closedReason: z.string(),
  // Link fields (the field's "Question for office" chip + drawing/area context).
  observationId: z.string().nullable(),
  convertedFromObservationId: z.string().nullable(),
  areaId: z.string().nullable(),
  planId: z.string().nullable(),
  raisedById: z.string(),
  raisedByName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  auditLogIds: z.array(z.string()),
});
export type Rfi = z.infer<typeof RfiSchema>;

export const RfisResponseSchema = z.object({
  rfis: z.array(RfiSchema),
});
export type RfisResponse = z.infer<typeof RfisResponseSchema>;
