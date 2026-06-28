import {
  SiteInstructionsResponseSchema,
  type InstructionChannel,
  type SiteInstructionsResponse,
} from "./schema";

/**
 * Browser client for the site-instructions register (#283). Admin/managing-LH
 * read; admin writes (record, edit/flag/link, acknowledge, close). The handler
 * is the source of truth for ref numbering, the state machine and text
 * immutability — this is a thin typed fetch layer over it.
 */

export interface RecordInstructionInput {
  instructedBy: { name: string; contactId?: string | null; email?: string | null };
  channel: InstructionChannel;
  instructionText: string;
  dateReceived: string;
  costTimeImplication?: boolean;
}

export async function fetchInstructions(jobId: string): Promise<SiteInstructionsResponse> {
  const res = await fetch(`/api/site-instructions?jobId=${encodeURIComponent(jobId)}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(await errText(res, "Couldn't load site instructions"));
  return SiteInstructionsResponseSchema.parse(await res.json());
}

export async function recordInstruction(jobId: string, input: RecordInstructionInput): Promise<void> {
  await send(jobId, "POST", "", input);
}

/** Pre-ack edits + the always-editable flag/link fields. */
export async function patchInstruction(
  jobId: string,
  id: string,
  patch: {
    instructionText?: string;
    dateReceived?: string;
    channel?: InstructionChannel;
    costTimeImplication?: boolean;
    linkedRfiId?: string | null;
    linkedVariationId?: string | null;
  },
): Promise<void> {
  await send(jobId, "PATCH", "", { id, ...patch });
}

export async function acknowledgeInstruction(jobId: string, id: string, channel: InstructionChannel): Promise<void> {
  await send(jobId, "POST", "acknowledge", { id, channel });
}

export async function closeInstruction(jobId: string, id: string, reason: string): Promise<void> {
  await send(jobId, "POST", "close", { id, reason });
}

async function send(jobId: string, method: string, action: string, body: unknown): Promise<void> {
  const q = action ? `&action=${action}` : "";
  const res = await fetch(`/api/site-instructions?jobId=${encodeURIComponent(jobId)}${q}`, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errText(res, "That didn't save"));
}

async function errText(res: Response, fallback: string): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string };
    return j.error || fallback;
  } catch {
    return fallback;
  }
}
