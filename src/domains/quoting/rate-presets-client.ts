import { z } from "zod";
import { httpGet, httpPost, httpPut, type HttpResult } from "@/lib/http";

/**
 * Typed client for /api/quote-rate-presets (#193) — reusable
 * {loadedCostRate, sellRate} pairs the quote builder's labour lines apply.
 * The API was shipped headless; this is its first consumer.
 *
 * Independence: applying a preset SNAPSHOTS its rates onto the line, so
 * editing/archiving a preset never changes an existing quote's totals.
 */

export const RatePresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  loadedCostRate: z.number(),
  sellRate: z.number(),
  archived: z.boolean(),
  createdAt: z.string().nullish(),
  createdBy: z.string().nullish(),
  updatedAt: z.string().nullish(),
  updatedBy: z.string().nullish(),
});
export type RatePreset = z.infer<typeof RatePresetSchema>;

export const RatePresetListSchema = z.object({ presets: z.array(RatePresetSchema) });
export type RatePresetList = z.infer<typeof RatePresetListSchema>;

const RatePresetMutationSchema = z.object({ preset: RatePresetSchema });
export type RatePresetMutation = z.infer<typeof RatePresetMutationSchema>;

export function listRatePresets(includeArchived = false): Promise<HttpResult<RatePresetList>> {
  const q = includeArchived ? "?includeArchived=1" : "";
  return httpGet(`/api/quote-rate-presets${q}`, {
    schema: RatePresetListSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

export function createRatePreset(input: {
  name: string;
  loadedCostRate: number;
  sellRate: number;
}): Promise<HttpResult<RatePresetMutation>> {
  return httpPost("/api/quote-rate-presets", input, {
    schema: RatePresetMutationSchema,
    init: { credentials: "same-origin" },
  });
}

export function updateRatePreset(input: {
  id: string;
  name?: string;
  loadedCostRate?: number;
  sellRate?: number;
  archived?: boolean;
}): Promise<HttpResult<RatePresetMutation>> {
  return httpPut("/api/quote-rate-presets", input, {
    schema: RatePresetMutationSchema,
    init: { credentials: "same-origin" },
  });
}
