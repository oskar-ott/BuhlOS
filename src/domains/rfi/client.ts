import { RfisResponseSchema, type RfisResponse } from "./schema";

/**
 * Browser client for the RFI register (#276). Admin/manager only — raise, send
 * to the builder, record the answer, close.
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
