import { z } from "zod";
import { httpDelete, httpGet, httpPatch, httpPost, type HttpResult } from "@/lib/http";
import type { JobCreateInput } from "./types";

/**
 * Job blueprints (#191) — reusable WHOLE-job shapes. The CLIENT half:
 * schemas, verbs and the instantiate mapper.
 *
 * Capture is server-side (api/job-blueprints.js, the shared duplicate-job
 * mapper family — ids stripped, archived skipped, no state, no site/client/
 * dates/money). Instantiate is a PURE mapper here → ONE POST /api/jobs,
 * where the create-path validators mint fresh ids + status:'draft'. No new
 * instantiation endpoint exists; that's the whole simplification.
 */

const BlueprintTaskSchema = z
  .object({ name: z.string(), order: z.number().optional() })
  .passthrough();

const BlueprintAreaSchema = z
  .object({
    name: z.string(),
    spaceType: z.string().optional(),
    order: z.number().optional(),
    roughInTasks: z.array(BlueprintTaskSchema).optional(),
    fitOffTasks: z.array(BlueprintTaskSchema).optional(),
    customFields: z.array(z.unknown()).optional(),
  })
  .passthrough();

const BlueprintGroupSchema = z
  .object({
    name: z.string(),
    order: z.number().optional(),
    areas: z.array(BlueprintAreaSchema),
  })
  .passthrough();

export const BlueprintStructureSchema = z
  .object({
    modules: z.record(z.unknown()).optional(),
    customFields: z.array(z.unknown()).optional(),
    roughInTasks: z.array(BlueprintTaskSchema).optional(),
    fitOffTasks: z.array(BlueprintTaskSchema).optional(),
    areaGroups: z.array(BlueprintGroupSchema).optional(),
  })
  .passthrough();

export const BlueprintSummarySchema = z.object({
  groupCount: z.number(),
  areaCount: z.number(),
  taskCount: z.number(),
});

export const JobBlueprintSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    structure: BlueprintStructureSchema,
    summary: BlueprintSummarySchema,
    sourceJobId: z.string().optional(),
    createdAt: z.string().optional(),
    createdByName: z.string().optional(),
  })
  .passthrough();

export const BlueprintListResponseSchema = z.object({
  blueprints: z.array(JobBlueprintSchema),
});
export const BlueprintMutationResponseSchema = z.object({
  blueprint: JobBlueprintSchema,
});

export type JobBlueprint = z.infer<typeof JobBlueprintSchema>;
export type BlueprintStructure = z.infer<typeof BlueprintStructureSchema>;

/**
 * Instantiate: a blueprint's structure → a CREATE payload for the new job.
 * Pure. The blueprint carries NO ids (captured id-less); the create-path
 * validators mint fresh ones, so the new job's structure can never share an
 * id with its source. Site/client/dates are absent by design — the admin
 * fills those in the builder. `type` is NOT captured (cross-site shapes
 * don't carry a job type), so a since-deleted type can never 400 here.
 */
export function instantiateBlueprint(
  blueprint: Pick<JobBlueprint, "structure">,
  name: string
): JobCreateInput {
  const s = blueprint.structure;
  const payload: JobCreateInput = {
    name: name.trim(),
    status: "draft",
  } as JobCreateInput;
  if (s.modules) (payload as Record<string, unknown>).modules = s.modules;
  if (s.customFields?.length) (payload as Record<string, unknown>).customFields = s.customFields;
  if (s.roughInTasks?.length) {
    (payload as Record<string, unknown>).roughInTasks = s.roughInTasks.map((t) => ({ name: t.name }));
  }
  if (s.fitOffTasks?.length) {
    (payload as Record<string, unknown>).fitOffTasks = s.fitOffTasks.map((t) => ({ name: t.name }));
  }
  if (s.areaGroups?.length) {
    (payload as Record<string, unknown>).areaGroups = s.areaGroups.map((g) => ({
      name: g.name,
      areas: g.areas.map((a) => {
        const area: Record<string, unknown> = { name: a.name };
        if (a.spaceType) area.spaceType = a.spaceType;
        if (a.roughInTasks?.length) area.roughInTasks = a.roughInTasks.map((t) => ({ name: t.name }));
        if (a.fitOffTasks?.length) area.fitOffTasks = a.fitOffTasks.map((t) => ({ name: t.name }));
        return area;
      }),
    }));
  }
  return payload;
}

/** One-line structure summary for the picker. */
export function blueprintSummaryLine(b: Pick<JobBlueprint, "summary">): string {
  const { groupCount, areaCount, taskCount } = b.summary;
  const parts = [
    `${groupCount} ${groupCount === 1 ? "group" : "groups"}`,
    `${areaCount} ${areaCount === 1 ? "area" : "areas"}`,
    `${taskCount} ${taskCount === 1 ? "task" : "tasks"}`,
  ];
  return parts.join(" · ");
}

// ── Client verbs ──────────────────────────────────────────────────────────

export function listBlueprints(): Promise<HttpResult<{ blueprints: JobBlueprint[] }>> {
  return httpGet("/api/job-blueprints", { schema: BlueprintListResponseSchema });
}

export function captureBlueprint(input: {
  jobId: string;
  name: string;
  description?: string;
}): Promise<HttpResult<{ blueprint: JobBlueprint }>> {
  return httpPost("/api/job-blueprints?action=capture", input, {
    schema: BlueprintMutationResponseSchema,
  });
}

export function renameBlueprint(
  id: string,
  name: string
): Promise<HttpResult<{ blueprint: JobBlueprint }>> {
  return httpPatch("/api/job-blueprints", { id, name }, {
    schema: BlueprintMutationResponseSchema,
  });
}

export function deleteBlueprint(id: string): Promise<HttpResult<{ ok: boolean }>> {
  return httpDelete(`/api/job-blueprints?id=${encodeURIComponent(id)}`, {
    schema: z.object({ ok: z.boolean() }),
  });
}
