import { RfisResponseSchema, type RfisResponse } from "./schema";
import { philWrite, type PhilWriteResult } from "@/domains/phil/write-client";

/**
 * Browser client for the RFI register (#276). Admin/manager only — raise, send
 * to the builder, record the answer, close. Plus `philRaiseRfi`: the field's
 * flag-gated raise (Phil sharpened capture), routed through philWrite so the
 * write is bounded + non-optimistic and returns the CREATED rfi (the real ref
 * for the "RFI sent" receipt).
 */

export async function fetchRfis(jobId: string): Promise<RfisResponse> {
  const res = await fetch(`/api/rfis?jobId=${encodeURIComponent(jobId)}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(await errText(res, "Couldn't load RFIs"));
  return RfisResponseSchema.parse(await res.json());
}

export async function raiseRfi(
  jobId: string,
  input: {
    subject: string;
    question: string;
    askedOf?: string;
    responseDue?: string;
    areaId?: string;
    planId?: string;
    observationId?: string;
  }
): Promise<void> {
  await post(jobId, "", input);
}

/** The slice of the created RFI the Phil capture receipt needs. */
export interface PhilRaisedRfi {
  id: string;
  ref: string;
  status: string;
}

/**
 * Field raise (Phil sharpened §2.5 RFI branch) — POST /api/rfis?jobId=X with
 * no action. Server gate: admin/manager as today, OR a field/LH worker
 * assigned to the job with `phil_sharpened` enabled (api/rfis.js). Returns
 * the created RFI (real sequential ref) via the philWrite honesty contract:
 * bounded timeout, typed failure, success only on a parsed server reply.
 */
export function philRaiseRfi(
  jobId: string,
  input: {
    subject: string;
    question: string;
    askedOf?: string;
    areaId?: string | null;
    observationId?: string | null;
  },
): Promise<PhilWriteResult<PhilRaisedRfi>> {
  return philWrite<PhilRaisedRfi>(
    `/api/rfis?jobId=${encodeURIComponent(jobId)}`,
    {
      subject: input.subject,
      question: input.question,
      ...(input.askedOf ? { askedOf: input.askedOf } : {}),
      ...(input.areaId ? { areaId: input.areaId } : {}),
      ...(input.observationId ? { observationId: input.observationId } : {}),
    },
    (raw) => {
      const rfi = (raw as { rfi?: { id?: unknown; ref?: unknown; status?: unknown } } | null)?.rfi;
      if (!rfi || typeof rfi.id !== "string" || typeof rfi.ref !== "string") return null;
      return { id: rfi.id, ref: rfi.ref, status: typeof rfi.status === "string" ? rfi.status : "open" };
    },
  );
}

export async function sendRfi(jobId: string, id: string, to?: string): Promise<void> {
  await post(jobId, "send", { id, to });
}

export async function answerRfi(jobId: string, id: string, answer: string): Promise<void> {
  await post(jobId, "answer", { id, answer });
}

export async function closeRfi(
  jobId: string,
  id: string,
  opts: { reason?: string } = {}
): Promise<void> {
  await post(jobId, "close", { id, reason: opts.reason });
}

async function post(jobId: string, action: string, body: Record<string, unknown>): Promise<void> {
  const q = action ? `&action=${action}` : "";
  const res = await fetch(`/api/rfis?jobId=${encodeURIComponent(jobId)}${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errText(res, "RFI action failed"));
}

async function errText(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error || `${fallback} (${res.status})`;
}
