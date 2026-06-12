import { httpDelete, httpGet, httpPost, httpPut, type HttpResult } from "@/lib/http";
import {
  TagListResponseSchema,
  TagMutationResponseSchema,
  TagOcrResponseSchema,
  TagPhotoResponseSchema,
  type TagDraft,
} from "./schema";
import { z } from "zod";

/**
 * Typed client over api/tags.js (#388) — the endpoint the legacy cutover
 * orphaned, reused untouched. All calls are job-scoped; the server enforces
 * visibility via requireAuth({jobId}) and writes via canWrite (admin-tier
 * any job, field/LH their assigned jobs, clients read-only).
 */

type TagList = z.infer<typeof TagListResponseSchema>;
type TagMutation = z.infer<typeof TagMutationResponseSchema>;
type TagPhoto = z.infer<typeof TagPhotoResponseSchema>;
type TagOcr = z.infer<typeof TagOcrResponseSchema>;

const init = { cache: "no-store" as const, credentials: "same-origin" as const };

export function listTags(jobId: string): Promise<HttpResult<TagList>> {
  return httpGet<TagList>(`/api/tags?jobId=${encodeURIComponent(jobId)}`, {
    schema: TagListResponseSchema,
    init,
  });
}

export function createTag(jobId: string, draft: TagDraft): Promise<HttpResult<TagMutation>> {
  return httpPost<TagMutation>(`/api/tags?jobId=${encodeURIComponent(jobId)}`, draft, {
    schema: TagMutationResponseSchema,
    init,
  });
}

export function updateTag(
  jobId: string,
  id: string,
  draft: Partial<TagDraft>,
): Promise<HttpResult<TagMutation>> {
  // The endpoint takes the id in the BODY on PUT.
  return httpPut<TagMutation>(
    `/api/tags?jobId=${encodeURIComponent(jobId)}`,
    { id, ...draft },
    { schema: TagMutationResponseSchema, init },
  );
}

const OkResponseSchema = z.object({ ok: z.boolean() }).passthrough();

export function deleteTag(jobId: string, id: string): Promise<HttpResult<{ ok: boolean }>> {
  return httpDelete<{ ok: boolean }>(
    `/api/tags?jobId=${encodeURIComponent(jobId)}&id=${encodeURIComponent(id)}`,
    { schema: OkResponseSchema, init },
  );
}

/** Upload a tag photo (dataUrl ≤ 8 MB) → public Blob URL for OCR + the record. */
export function uploadTagPhoto(jobId: string, dataUrl: string): Promise<HttpResult<TagPhoto>> {
  return httpPost<TagPhoto>(
    `/api/tags?jobId=${encodeURIComponent(jobId)}&action=photo`,
    { dataUrl },
    { schema: TagPhotoResponseSchema, init },
  );
}

/**
 * Claude-vision OCR on an uploaded photo. Note: a 200 with `error` set means
 * the model reply couldn't be parsed — fields come back empty with zeroed
 * confidence, and the human types them in (AI assists, never silently decides).
 */
export function runTagOcr(jobId: string, photoUrl: string): Promise<HttpResult<TagOcr>> {
  return httpPost<TagOcr>(
    `/api/tags?jobId=${encodeURIComponent(jobId)}&action=ocr`,
    { photoUrl },
    { schema: TagOcrResponseSchema, init },
  );
}
