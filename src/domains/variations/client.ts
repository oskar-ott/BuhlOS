import {
  VariationClaimMutationResponseSchema,
  VariationClaimsResponseSchema,
} from "./claim-schema";
import type {
  VariationApprovalEvidence,
  VariationClaimMutationResponse,
  VariationClaimsResponse,
} from "./claim-types";

/**
 * Browser client for the variation-claims register (#280). Admin-tier only —
 * raise a claim, work it through the pipeline (quote → submit → approve/reject
 * → invoice), pull a not-yet-decided or rejected claim back to draft.
 *
 * MONEY: valueCents is INTEGER CENTS everywhere on the wire — the UI parses
 * dollars at the input boundary and formats at render, never in between (P7).
 * The server (api/variations.js) is the transition/gate authority; these
 * wrappers just shape the requests. Mirrors src/domains/rfi/client.ts.
 */

export async function fetchVariationClaims(jobId: string): Promise<VariationClaimsResponse> {
  const res = await fetch(`/api/variations?jobId=${encodeURIComponent(jobId)}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(await errText(res, "Couldn't load variation claims"));
  return VariationClaimsResponseSchema.parse(await res.json());
}

export async function raiseVariationClaim(
  jobId: string,
  input: {
    scope: string;
    description?: string | null;
    /** Integer cents; omit/null while the claim is still being priced. */
    valueCents?: number | null;
  }
): Promise<VariationClaimMutationResponse> {
  const res = await fetch(`/api/variations?jobId=${encodeURIComponent(jobId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await errText(res, "Couldn't raise the variation claim"));
  return VariationClaimMutationResponseSchema.parse(await res.json());
}

/** Edit a claim's scope / description / value (PATCH without a status move). */
export async function updateVariationClaim(
  jobId: string,
  id: string,
  patch: { scope?: string; description?: string | null; valueCents?: number | null }
): Promise<VariationClaimMutationResponse> {
  return patchClaim({ id, jobId, ...patch });
}

// ── Lifecycle transitions ────────────────────────────────────────────────────
// Each sends the target status; api/variations.js enforces the transition
// table and THE approval gate server-side (a 409/400 here is the truth).

export async function quoteVariationClaim(
  jobId: string,
  id: string
): Promise<VariationClaimMutationResponse> {
  return patchClaim({ id, jobId, status: "quoted" });
}

export async function submitVariationClaim(
  jobId: string,
  id: string
): Promise<VariationClaimMutationResponse> {
  return patchClaim({ id, jobId, status: "submitted" });
}

/** Approve — REQUIRES complete evidence (approvedBy, approvedAt, method,
 *  reference). The server 400s anything less; the register mirrors the gate
 *  client-side but this wrapper sends whatever it's given. */
export async function approveVariationClaim(
  jobId: string,
  id: string,
  approval: VariationApprovalEvidence
): Promise<VariationClaimMutationResponse> {
  return patchClaim({ id, jobId, status: "approved", approval });
}

export async function rejectVariationClaim(
  jobId: string,
  id: string,
  opts: { note?: string } = {}
): Promise<VariationClaimMutationResponse> {
  return patchClaim({
    id,
    jobId,
    status: "rejected",
    ...(opts.note ? { decisionNote: opts.note } : {}),
  });
}

/** Mark invoiced — manual invoice reference ONLY (Xero is Epic 8 / #184). */
export async function invoiceVariationClaim(
  jobId: string,
  id: string,
  invoiceRef: string
): Promise<VariationClaimMutationResponse> {
  return patchClaim({ id, jobId, status: "invoiced", invoiceRef });
}

/** Pull a quoted/submitted/rejected claim back to draft to amend + re-submit. */
export async function reviseVariationClaim(
  jobId: string,
  id: string
): Promise<VariationClaimMutationResponse> {
  return patchClaim({ id, jobId, status: "draft" });
}

async function patchClaim(
  body: Record<string, unknown>
): Promise<VariationClaimMutationResponse> {
  const res = await fetch("/api/variations", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errText(res, "Variation claim update failed"));
  return VariationClaimMutationResponseSchema.parse(await res.json());
}

async function errText(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error || `${fallback} (${res.status})`;
}
