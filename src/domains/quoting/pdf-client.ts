import { z } from "zod";
import { httpGet, httpPost, type HttpResult } from "@/lib/http";

/**
 * Client for /api/quote-pdf (#243) — branded client quote PDFs.
 *
 * Two verbs matter here:
 *   - PREVIEW: a fresh render streamed back as application/pdf, NOT filed
 *     (the document itself says "Preview — not yet issued") — link straight
 *     to `quotePdfPreviewUrl`.
 *   - ISSUE: generate + file. The server put()s the PDF to Blob and appends
 *     an immutable entry to the quote's issued-PDF register; re-issuing after
 *     edits always creates a NEW artifact (issue AC).
 */

export const IssuedQuotePdfSchema = z
  .object({
    id: z.string(),
    quoteId: z.string(),
    documentType: z.string(),
    fileName: z.string(),
    url: z.string(),
    sizeBytes: z.number(),
    issueNumber: z.number(),
    issuedAt: z.string(),
    issuedBy: z.string(),
    /** The quote document's updatedAt at generation time — the honest content
     *  stamp until v2 grows revision lineage. */
    quoteUpdatedAt: z.string(),
    quoteName: z.string(),
    totalIncGst: z.number().nullable(),
    generatorVersion: z.string(),
  })
  .passthrough();
export type IssuedQuotePdf = z.infer<typeof IssuedQuotePdfSchema>;

const ListResponseSchema = z.object({ documents: z.array(IssuedQuotePdfSchema) });
const IssueResponseSchema = z.object({ document: IssuedQuotePdfSchema });

export function quotePdfPreviewUrl(quoteId: string): string {
  return `/api/quote-pdf?id=${encodeURIComponent(quoteId)}&download=1`;
}

export async function listIssuedQuotePdfs(
  quoteId: string
): Promise<HttpResult<IssuedQuotePdf[]>> {
  const r = await httpGet(`/api/quote-pdf?id=${encodeURIComponent(quoteId)}`, {
    schema: ListResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
  return r.ok ? { ok: true, data: r.data.documents } : r;
}

export async function issueQuotePdf(quoteId: string): Promise<HttpResult<IssuedQuotePdf>> {
  const r = await httpPost(`/api/quote-pdf?id=${encodeURIComponent(quoteId)}`, {}, {
    schema: IssueResponseSchema,
    timeoutMs: 30000,
    init: { credentials: "same-origin" },
  });
  return r.ok ? { ok: true, data: r.data.document } : r;
}
