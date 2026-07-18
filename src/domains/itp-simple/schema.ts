import { z } from "zod";

/**
 * Client contract for the simple mobile ITP builder (#912) —
 * `/api/itp-simple`. Metadata is Supabase-first server-side; this schema is
 * the tolerant client-side edge: unknown keys strip, optional artefact fields
 * default to null so a report without a PDF renders honestly as "no PDF yet".
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

export const ItpReportSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  areaCount: z.number().default(0),
  photoCount: z.number().default(0),
  pdfUrl: z.string().nullable().default(null),
  pdfGeneratedAt: z.coerce.string().nullable().default(null),
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

export const ItpListResponseSchema = z.object({
  job: z.object({ id: z.string(), name: z.string() }),
  reports: z.array(ItpReportSummarySchema).default([]),
});
export type ItpListResponse = z.infer<typeof ItpListResponseSchema>;

export const ItpReportResponseSchema = z.object({
  report: ItpReportDetailSchema,
});

export const ItpPdfResponseSchema = z.object({
  url: z.string(),
  generatedAt: z.coerce.string().nullable().default(null),
});

/**
 * True when areas or photos were ADDED after the last PDF was made. The
 * builder's note claims exactly that ("added since this PDF") — deletions
 * leave no newer timestamp and are deliberately not claimed (P7: an
 * imprecise warning is worse than a precise one; the PDF's own made-at
 * date carries the vintage either way).
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
