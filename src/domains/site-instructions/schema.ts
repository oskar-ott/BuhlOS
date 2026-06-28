import { z } from "zod";

/**
 * #283 — per-job site-instructions register.
 *
 * Builders direct work on the fly — "move that GPO", "board goes on the other
 * wall", "don't rough-in unit 4 yet". These change cost and sequence, and today
 * they live in nobody's records: when the directed work is later disputed
 * ("we never told you to do that") the contractor has no proof, and instructions
 * with cost implications quietly become free work instead of variations.
 *
 * This is the formal, per-job register: who instructed what, when, through which
 * channel; an acknowledgement back to the builder; and a flag for instructions
 * with cost/time implications so they spawn a linked RFI (#276) or variation
 * (#280) instead of being absorbed.
 *
 * Per-job store jobs/<jobId>/site-instructions.json (like snags/rfis/minutes).
 * Office-side: admin / managing-LH read, admin write. The field side (the
 * `client_instruction` observation + its capture chip) is unchanged.
 *
 * Two "acknowledgement" patterns exist in the backlog and must not share a
 * primitive: inbound worker acknowledge-read (#219/#299, per-user-per-version)
 * vs. this OUTBOUND formal acknowledgement (the OFFICE confirms TO the builder).
 * This register is solely the second — snag-email discipline (a send only
 * stamps on provider success); `acknowledgedAt` is never `emailSentAt`.
 */

/** Server-side instruction-text cap (re-asserted in the handler). */
export const INSTRUCTION_TEXT_MAX = 2000;
/** Cap for a close reason. */
export const CLOSE_REASON_MAX = 500;

/** How the instruction reached the office. */
export const INSTRUCTION_CHANNELS = ["verbal", "phone", "email", "text", "on_site"] as const;
export const InstructionChannelSchema = z.enum(INSTRUCTION_CHANNELS);
export type InstructionChannel = z.infer<typeof InstructionChannelSchema>;

/**
 * Lifecycle. `recorded` → `acknowledged` (the office formally confirms back) →
 * `closed`. A verbal-only instruction may close without an acknowledgement
 * (close carries a reason). The instruction text is frozen once it leaves
 * `recorded` — the acknowledgement quoted it verbatim, so the record and the
 * sent words must never diverge.
 */
export const INSTRUCTION_STATUSES = ["recorded", "acknowledged", "closed"] as const;
export const InstructionStatusSchema = z.enum(INSTRUCTION_STATUSES);
export type InstructionStatus = z.infer<typeof InstructionStatusSchema>;

/** Who gave the instruction — snapshotted at record time (contacts are mutable). */
export const InstructedBySchema = z.object({
  name: z.string(),
  /** Links to a project contact when picked from /api/contacts; free-text → null. */
  contactId: z.string().nullable(),
  /** Snapshotted email (for a later acknowledgement send), or null. */
  email: z.string().nullable(),
});
export type InstructedBy = z.infer<typeof InstructedBySchema>;

export const SiteInstructionSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  /** Per-job human reference, "SI-001" … — server-assigned, never reused. */
  ref: z.string(),
  instructedBy: InstructedBySchema,
  channel: InstructionChannelSchema,
  /** Verbatim instruction text. Capped server-side; frozen once acknowledged/closed. */
  instructionText: z.string().max(INSTRUCTION_TEXT_MAX),
  /** Date the instruction was received (ISO YYYY-MM-DD). */
  dateReceived: z.string(),
  status: InstructionStatusSchema,
  /** Flagged when the instruction carries a cost/time implication — the row
   *  that needs a spawned RFI/variation or it becomes free work. */
  costTimeImplication: z.boolean().default(false),
  /** A spawned #276 RFI / #280 variation by id, or null. */
  linkedRfiId: z.string().nullable(),
  linkedVariationId: z.string().nullable(),
  /** Recorded when the office acknowledges (verbal or email). Honesty: this is
   *  the formal ack, NOT proof an email was sent — see emailSentAt. */
  acknowledgedAt: z.string().nullable(),
  acknowledgedBy: z.string().nullable(),
  /** How the office acknowledged ("verbal" / "phone" / "email" …), or null. */
  acknowledgementChannel: InstructionChannelSchema.nullable(),
  /** Stamped ONLY on a real provider send ({ok:true}); null on a verbal /
   *  not_configured acknowledgement. acknowledgedAt ≠ emailSentAt by design. */
  emailSentAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  closedBy: z.string().nullable(),
  closeReason: z.string().nullable(),
  /** Server-attributed recorder. */
  recordedBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  auditLogIds: z.array(z.string()),
});
export type SiteInstruction = z.infer<typeof SiteInstructionSchema>;

export const SiteInstructionsResponseSchema = z.object({
  instructions: z.array(SiteInstructionSchema),
});
export type SiteInstructionsResponse = z.infer<typeof SiteInstructionsResponseSchema>;
