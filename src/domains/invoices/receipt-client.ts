import { z } from "zod";
import { httpPost, type HttpResult } from "@/lib/http";

/**
 * Field client for POST /api/invoices?action=receipt (receipt_capture). A
 * worker's photographed card receipt, logged to a job. The server reads the
 * photo inline, so this waits up to a minute — the sheet says so.
 */
export const ReceiptResultSchema = z.object({
  id: z.string(),
  status: z.string(),
  duplicate: z.boolean().default(false),
  read: z.boolean(),
  storeName: z.string().nullable(),
  totalCents: z.number().nullable(),
  receiptDate: z.string().nullable(),
  lineCount: z.number().default(0),
  job: z.object({ id: z.string(), name: z.string(), code: z.string().nullable() }),
  paidPersonally: z.boolean().default(false),
});
export type ReceiptResult = z.infer<typeof ReceiptResultSchema>;

export function submitReceipt(input: {
  jobId: string;
  filename: string;
  dataUrl: string;
  paidPersonally: boolean;
}): Promise<HttpResult<ReceiptResult>> {
  return httpPost("/api/invoices?action=receipt", input, { schema: ReceiptResultSchema, timeoutMs: 70_000 });
}

/**
 * The one honest sentence about a receipt the worker paid for themselves.
 * BuhlOS records the fact for the office and nothing more: it runs no
 * reimbursement, sends nothing to payroll, and cannot know whether a payback
 * was approved or made (P7 — no promise the system can't keep). Shown under
 * the checkbox while it is ticked and again in the outcome after sending.
 */
export const PAID_PERSONALLY_NOTE =
  "Recorded for the office. This does not confirm that a payback has been approved or paid.";

/** "$84.50" from integer cents (the field never sees floats). */
export function formatReceiptCents(cents: number | null | undefined): string {
  if (cents == null) return "—";
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return `${neg ? "-" : ""}$${Math.floor(abs / 100).toLocaleString("en-AU")}.${String(abs % 100).padStart(2, "0")}`;
}

/** The one line the worker reads after sending — true to what happened (P7). */
export function receiptOutcomeText(r: ReceiptResult): { title: string; body: string; tone: "success" | "info" } {
  const where = r.job.code ? `${r.job.code} · ${r.job.name}` : r.job.name;
  if (r.duplicate) return { title: "Already sent", body: `That receipt was logged before — nothing added twice. (${where})`, tone: "info" };
  if (r.read && r.totalCents != null) {
    const bits = [r.storeName, formatReceiptCents(r.totalCents), r.lineCount ? `${r.lineCount} ${r.lineCount === 1 ? "item" : "items"}` : null].filter(Boolean).join(" · ");
    return {
      title: "Receipt logged",
      body: `${bits} → ${where}.${r.paidPersonally ? ` ${PAID_PERSONALLY_NOTE}` : ""}`,
      tone: "success",
    };
  }
  return {
    title: "Receipt saved",
    body: `Logged to ${where}. The total couldn't be read from the photo — the office will check it.`,
    tone: "info",
  };
}
