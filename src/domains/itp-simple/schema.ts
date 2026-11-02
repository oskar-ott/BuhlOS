import { z } from "zod";

/**
 * Client contract for the simple mobile ITP builder (#912; redesigned per
 * the 2026-11-02 developer handoff) — `/api/itp-simple`. Metadata is
 * Supabase-first server-side; this schema is the tolerant client-side edge:
 * unknown keys strip, optional artefact fields default to null so a report
 * without a PDF renders honestly as "No PDF yet".
 */

export const ItpPhotoSchema = z.object({
  id: z.string(),
  url: z.string(),
  caption: z.string().default(""),
  takenBy: z.string().default(""),
  createdAt: z.coerce.string(),
});
export type ItpPhoto = z.infer<typeof ItpPhotoSchema>;

export const ItpAreaSchema = z.object({
  id: z.string(),
  name: z.string(),
  position: z.number().default(0),
  createdAt: z.coerce.string().optional(),
  photos: z.array(ItpPhotoSchema).default([]),
});
export type ItpArea = z.infer<typeof ItpAreaSchema>;

/** The last successful send of any PDF on a report (list badge input). */
export const ItpLastSendSchema = z.object({
  kind: z.enum(["office", "email"]),
  recipient: z.string().default(""),
  sentAt: z.coerce.string(),
});
export type ItpLastSend = z.infer<typeof ItpLastSendSchema>;

export const ItpReportSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  areaCount: z.number().default(0),
  photoCount: z.number().default(0),
  pdfUrl: z.string().nullable().default(null),
  pdfGeneratedAt: z.coerce.string().nullable().default(null),
  pdfCount: z.number().default(0),
  staleCount: z.number().default(0),
  lastMadeAt: z.coerce.string().nullable().default(null),
  lastSend: ItpLastSendSchema.nullable().default(null),
  createdBy: z.string().default(""),
  createdAt: z.coerce.string(),
  updatedAt: z.coerce.string(),
});
export type ItpReportSummary = z.infer<typeof ItpReportSummarySchema>;

export const ItpReportDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  pdfUrl: z.string().nullable().default(null),
  pdfGeneratedAt: z.coerce.string().nullable().default(null),
  createdBy: z.string().default(""),
  createdAt: z.coerce.string(),
  updatedAt: z.coerce.string(),
  areas: z.array(ItpAreaSchema).default([]),
});
export type ItpReportDetail = z.infer<typeof ItpReportDetailSchema>;

/** One PDF made from a report. `stale` = photos changed in ITS areas since. */
export const ItpPdfSchema = z.object({
  id: z.string(),
  name: z.string(),
  nameIsAuto: z.boolean().default(true),
  areaIds: z.array(z.string()).default([]),
  areaCount: z.number().default(0),
  photoCount: z.number().default(0),
  url: z.string(),
  madeAt: z.coerce.string(),
  madeBy: z.string().default(""),
  stale: z.boolean().default(false),
});
export type ItpPdf = z.infer<typeof ItpPdfSchema>;

export const ItpSendSchema = z.object({
  id: z.string(),
  pdfId: z.string().nullable().default(null),
  kind: z.enum(["office", "email"]),
  recipient: z.string(),
  pdfName: z.string().default(""),
  result: z.enum(["sent", "failed"]),
  sentAt: z.coerce.string(),
});
export type ItpSend = z.infer<typeof ItpSendSchema>;

export const ItpListResponseSchema = z.object({
  job: z.object({ id: z.string(), name: z.string() }),
  reports: z.array(ItpReportSummarySchema).default([]),
  walkthroughSeen: z.boolean().optional(),
  officeEmailSet: z.boolean().default(false),
});
export type ItpListResponse = z.infer<typeof ItpListResponseSchema>;

export const ItpReportResponseSchema = z.object({
  report: ItpReportDetailSchema,
  pdfs: z.array(ItpPdfSchema).default([]),
  sends: z.array(ItpSendSchema).default([]),
  recentNames: z.array(z.string()).default([]),
  emailSuggestions: z.array(z.string()).default([]),
  officeEmail: z.string().nullable().default(null),
});
export type ItpReportResponse = z.infer<typeof ItpReportResponseSchema>;

export const ItpPdfResponseSchema = z.object({ pdf: ItpPdfSchema });

export const ItpSendResponseSchema = z.object({
  send: ItpSendSchema,
  pdf: ItpPdfSchema,
});

export const ItpAreaResponseSchema = z.object({ area: ItpAreaSchema });
export const ItpPhotoResponseSchema = z.object({ photo: ItpPhotoSchema });
export const ItpCreatedReportSchema = z.object({ report: ItpReportSummarySchema });

/**
 * True when areas or photos were ADDED after the last PDF was made. Kept for
 * the legacy single-PDF stamp; the redesign's per-PDF `stale` flag (server
 * fingerprint of the PDF's own areas) is what the builder and list show.
 */
export function pdfMissingNewCaptures(report: {
  pdfGeneratedAt: string | null;
  areas: ReadonlyArray<{ createdAt?: string; photos: ReadonlyArray<{ createdAt: string }> }>;
}): boolean {
  if (!report.pdfGeneratedAt) return false;
  const madeAt = Date.parse(report.pdfGeneratedAt);
  if (Number.isNaN(madeAt)) return false;
  const touched: number[] = [];
  for (const a of report.areas) {
    if (a.createdAt) touched.push(Date.parse(a.createdAt));
    for (const p of a.photos) touched.push(Date.parse(p.createdAt));
  }
  return touched.some((t) => !Number.isNaN(t) && t > madeAt);
}
