import { z } from "zod";
import { ProgressClaimSchema } from "./schema";
import type { ProgressClaim } from "./types";

/**
 * Client wire layer for /api/job-claims (#372). The server route serves the
 * store's ClaimsView; this module is the UI-side parse of that wire shape plus
 * typed action posts. Zod-parse fail-soft (house loader pattern).
 */

export const ClaimsViewWireSchema = z
  .object({
    ok: z.literal(true),
    jobId: z.string(),
    jobName: z.string().nullable(),
    revision: z.string(),
    claims: z.array(ProgressClaimSchema),
    derived: z
      .object({
        claimedToDateCents: z.number().int(),
        oldestUnpaidDays: z.number().int().nullable(),
        scalarClaimedToDateCents: z.number().int().nullable(),
        contractValueCents: z.number().int().nullable(),
        certifiedVarianceByClaimId: z.record(z.string(), z.number().int().nullable()),
      })
      .passthrough(),
    seed: z
      .object({
        source: z.enum(["quote", "packages", "blank"]),
        quoteId: z.string().nullable(),
      })
      .passthrough(),
    references: z.array(
      z
        .object({
          workPackageId: z.string(),
          tasksComplete: z.number().int(),
          tasksTotal: z.number().int(),
        })
        .passthrough(),
    ),
    linkable: z.array(
      z
        .object({ kind: z.enum(["evidence", "itp"]), id: z.string(), label: z.string() })
        .passthrough(),
    ),
    attachable: z.array(
      z
        .object({
          kind: z.enum(["variation", "daywork"]),
          id: z.string(),
          ref: z.string().nullable(),
          label: z.string(),
          valueCents: z.number().int().nullable(),
          attachedToClaimNumber: z.number().int().nullable(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type ClaimsViewWire = z.infer<typeof ClaimsViewWireSchema>;

export type ClaimsViewLoad =
  | { kind: "ok"; view: ClaimsViewWire }
  | { kind: "error"; message: string };

export async function fetchClaimsView(jobId: string): Promise<ClaimsViewLoad> {
  try {
    const res = await fetch(`/api/job-claims?jobId=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
    });
    if (!res.ok) return { kind: "error", message: `Claims API ${res.status}` };
    const parsed = ClaimsViewWireSchema.safeParse(await res.json());
    if (!parsed.success) return { kind: "error", message: "Unexpected claims response" };
    return { kind: "ok", view: parsed.data };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : "Network error" };
  }
}

const ActionOkSchema = z
  .object({
    ok: z.literal(true),
    revision: z.string(),
    claim: ProgressClaimSchema.nullable(),
    rollupWarning: z.string().optional(),
  })
  .passthrough();

export type ClaimsActionResult =
  | { kind: "ok"; revision: string; claim: ProgressClaim | null; rollupWarning: string | null }
  | { kind: "stale" }
  | { kind: "error"; message: string };

export async function postClaimsAction(body: Record<string, unknown>): Promise<ClaimsActionResult> {
  try {
    const res = await fetch("/api/job-claims", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json: unknown = await res.json().catch(() => null);
    if (res.status === 409) {
      const reason =
        json && typeof json === "object" && "reason" in json ? (json as { reason?: string }).reason : undefined;
      if (reason === "stale_revision") return { kind: "stale" };
    }
    if (!res.ok) {
      const msg =
        json && typeof json === "object" && "error" in json && typeof (json as { error?: unknown }).error === "string"
          ? ((json as { error: string }).error)
          : `Claims API ${res.status}`;
      return { kind: "error", message: msg };
    }
    const parsed = ActionOkSchema.safeParse(json);
    if (!parsed.success) return { kind: "error", message: "Unexpected claims response" };
    return {
      kind: "ok",
      revision: parsed.data.revision,
      claim: parsed.data.claim,
      rollupWarning: parsed.data.rollupWarning ?? null,
    };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : "Network error" };
  }
}

export function claimCsvHref(jobId: string, claimId: string): string {
  return `/api/job-claims/export?jobId=${encodeURIComponent(jobId)}&claimId=${encodeURIComponent(claimId)}`;
}

export function claimPrintHref(jobId: string, claimId: string): string {
  return `/v2/jobs/${encodeURIComponent(jobId)}/claims/${encodeURIComponent(claimId)}/print`;
}
