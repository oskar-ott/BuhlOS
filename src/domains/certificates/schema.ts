import { z } from "zod";

/**
 * #231 — commissioning documents + certificates register on the job.
 *
 * Test sheets, commissioning results and certificates of electrical safety end
 * up in inboxes; at handover (or a callback years later) finding them is a
 * scavenger hunt with legal stakes. This is a typed register with the fields
 * that matter — type, reference number, issue date, file — sortable by date.
 * NOT an approval workflow (Epic 11 owns ITP/QA process); shelf space the
 * handover pack reads from.
 *
 * Isolated store (purpose-built for the reference/date metadata the shared
 * documents register lacks): jobs/<jobId>/certificates.json.
 */

export const CERTIFICATE_TYPES = ["certificate", "test_sheet", "commissioning"] as const;
export type CertificateType = (typeof CERTIFICATE_TYPES)[number];

export const CERTIFICATE_TYPE_LABEL: Record<CertificateType, string> = {
  certificate: "Certificate",
  test_sheet: "Test sheet",
  commissioning: "Commissioning record",
};

export const CertificateSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  type: z.enum(CERTIFICATE_TYPES),
  title: z.string(),
  /** Reference / certificate number. May be "" (not every cert carries one). */
  referenceNo: z.string(),
  /** Issue date as an ISO date (YYYY-MM-DD), or "" — the register sorts by this. */
  issuedAt: z.string(),
  fileName: z.string(),
  blobPath: z.string(),
  url: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  status: z.enum(["current", "archived"]),
  uploadedAt: z.string(),
  uploadedBy: z.string(),
});
export type Certificate = z.infer<typeof CertificateSchema>;

export const CertificatesResponseSchema = z.object({
  certificates: z.array(CertificateSchema),
});
export type CertificatesResponse = z.infer<typeof CertificatesResponseSchema>;
