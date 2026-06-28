import { MinutesResponseSchema, type MinutesResponse } from "./schema";

/**
 * Browser client for the meeting-minutes register (#217). Admin/managing-LH
 * read; admin writes. Record a minute (with an optional PDF attachment as a
 * dataUrl) and add stamped, append-only amendments — the body is never mutated.
 */

export async function fetchMinutes(jobId: string): Promise<MinutesResponse> {
  const res = await fetch(`/api/job-minutes?jobId=${encodeURIComponent(jobId)}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(await errText(res, "Couldn't load minutes"));
  return MinutesResponseSchema.parse(await res.json());
}

export async function recordMinute(
  jobId: string,
  input: {
    date: string;
    title: string;
    attendees?: Array<{ name: string; contactId?: string | null }>;
    body?: string;
    /** A data: URL for an optional PDF/image attachment. */
    dataUrl?: string;
    fileName?: string;
    mimeType?: string;
  }
): Promise<void> {
  await post(jobId, "", input);
}

export async function amendMinute(jobId: string, id: string, note: string): Promise<void> {
  await post(jobId, "amend", { id, note });
}

async function post(jobId: string, action: string, body: Record<string, unknown>): Promise<void> {
  const q = action ? `&action=${action}` : "";
  const res = await fetch(`/api/job-minutes?jobId=${encodeURIComponent(jobId)}${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errText(res, "Minutes action failed"));
}

async function errText(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error || `${fallback} (${res.status})`;
}
