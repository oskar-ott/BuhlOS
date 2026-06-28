import { z } from "zod";

/**
 * #217 — per-job meeting-minutes register.
 *
 * Site meetings, client meetings, coordination meetings — the minutes of who
 * was there and what was decided are the record the job relies on. Today they
 * live in one person's inbox or a loose PDF. This is the formal, per-job
 * register: an APPEND-ONLY list of minute entries (date, title, attendees,
 * body and/or a PDF attachment). A minute is never edited in place — a
 * correction is a stamped amendment recorded beneath the unchanged original
 * (who/when/note).
 *
 * Per-job store jobs/<jobId>/minutes.json (like snags/rfis). No cross-job index
 * in v1. The attachment is a direct-blob sibling (jobs/<id>/minutes/<id>.<ext>),
 * NOT a Documents-register category — this register owns its own files.
 */

/** Server-side body cap (re-asserted in the handler, not just at the edge). */
export const MINUTE_BODY_MAX = 10000;

export const MinuteAttendeeSchema = z.object({
  name: z.string(),
  /** Links to a project contact when picked from /api/contacts; free-text → null. */
  contactId: z.string().nullable(),
});
export type MinuteAttendee = z.infer<typeof MinuteAttendeeSchema>;

export const MinuteAttachmentSchema = z.object({
  blobPath: z.string(),
  url: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
});
export type MinuteAttachment = z.infer<typeof MinuteAttachmentSchema>;

export const MinuteAmendmentSchema = z.object({
  at: z.string(),
  by: z.string(),
  note: z.string(),
});
export type MinuteAmendment = z.infer<typeof MinuteAmendmentSchema>;

export const MinuteEntrySchema = z.object({
  id: z.string(),
  jobId: z.string(),
  /** Meeting date (ISO YYYY-MM-DD). */
  date: z.string(),
  title: z.string(),
  attendees: z.array(MinuteAttendeeSchema),
  /** The minutes themselves. Capped at MINUTE_BODY_MAX server-side; may be "". */
  body: z.string().max(MINUTE_BODY_MAX).default(""),
  /** Optional PDF/image attachment (direct blob), or null when body-only. */
  attachment: MinuteAttachmentSchema.nullable(),
  /** Stamped, append-only corrections — the original is never mutated. */
  amendments: z.array(MinuteAmendmentSchema),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  auditLogIds: z.array(z.string()),
});
export type MinuteEntry = z.infer<typeof MinuteEntrySchema>;

export const MinutesResponseSchema = z.object({
  minutes: z.array(MinuteEntrySchema),
});
export type MinutesResponse = z.infer<typeof MinutesResponseSchema>;
