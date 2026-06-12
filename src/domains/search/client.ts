import { z } from "zod";
import { httpGet, type HttpResult } from "@/lib/http";

/**
 * Universal admin search (#188) — typed wrapper over GET /api/search.
 *
 * The endpoint is admin/LH-scoped server-side (visibility never widens
 * client-side); this just parses its shape and groups for the UI. Ranking
 * and the visible set are the server's; the client renders what it returns.
 */

export const SearchResultSchema = z
  .object({
    type: z.enum(["job", "snag", "user"]),
    id: z.string(),
    label: z.string(),
    sub: z.string().optional(),
    /** Deep link — null for records with no destination (e.g. clients). */
    url: z.string().nullable().optional(),
    /** Snags carry their job id (job context + deep link). */
    jobId: z.string().optional(),
  })
  .passthrough();

export type SearchResult = z.infer<typeof SearchResultSchema>;

export const SearchResponseSchema = z.object({
  q: z.string(),
  results: z.array(SearchResultSchema),
});

export type SearchResponse = z.infer<typeof SearchResponseSchema>;

/** Group key + display label + ordering for the result list. */
export const SEARCH_GROUPS = [
  { type: "job" as const, label: "Jobs" },
  { type: "snag" as const, label: "Snags" },
  { type: "user" as const, label: "People" },
];

export interface SearchGroup {
  type: SearchResult["type"];
  label: string;
  results: SearchResult[];
}

/** Bucket a flat result list into the fixed group order, dropping empties. */
export function groupResults(results: ReadonlyArray<SearchResult>): SearchGroup[] {
  return SEARCH_GROUPS.map((g) => ({
    type: g.type,
    label: g.label,
    results: results.filter((r) => r.type === g.type),
  })).filter((g) => g.results.length > 0);
}

/** A flat, group-ordered list — what keyboard navigation walks. */
export function flattenGroups(groups: ReadonlyArray<SearchGroup>): SearchResult[] {
  return groups.flatMap((g) => g.results);
}

export function searchAll(
  q: string,
  signal?: AbortSignal
): Promise<HttpResult<SearchResponse>> {
  return httpGet(`/api/search?q=${encodeURIComponent(q)}`, {
    schema: SearchResponseSchema,
    init: { cache: "no-store", credentials: "same-origin", signal },
  });
}
