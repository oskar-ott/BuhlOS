import { z } from "zod";
import { httpGet, httpPost, type HttpResult } from "@/lib/http";

/** Client for the #240 quote delivery-lifecycle actions on /api/quotes. */

export const DeliveryStateSchema = z.object({
  state: z.enum(["never_sent", "sent", "viewed", "accepted", "declined"]),
  lastSentAt: z.string().nullable(),
  lastViewedAt: z.string().nullable(),
  recipient: z.string().nullable(),
  method: z.string().nullable(),
  since: z.string().nullable(),
});
export type DeliveryState = z.infer<typeof DeliveryStateSchema>;

const DeliveryResponseSchema = z.object({ deliveryState: DeliveryStateSchema });
const MarkResponseSchema = z.object({ deliveryState: DeliveryStateSchema, quote: z.unknown().optional() });

export async function getQuoteDelivery(quoteId: string): Promise<HttpResult<DeliveryState>> {
  const r = await httpGet(`/api/quotes?action=delivery&id=${encodeURIComponent(quoteId)}`, {
    schema: DeliveryResponseSchema,
  });
  return r.ok ? { ok: true, data: r.data.deliveryState } : r;
}

export async function markQuoteSent(
  quoteId: string,
  payload: { at: string; recipient: string; method: string },
): Promise<HttpResult<DeliveryState>> {
  const r = await httpPost(`/api/quotes?action=mark-sent&id=${encodeURIComponent(quoteId)}`, payload, {
    schema: MarkResponseSchema,
    timeoutMs: 15000,
  });
  return r.ok ? { ok: true, data: r.data.deliveryState } : r;
}

export async function markQuoteViewed(
  quoteId: string,
  payload: { at?: string; note?: string } = {},
): Promise<HttpResult<DeliveryState>> {
  const r = await httpPost(`/api/quotes?action=mark-viewed&id=${encodeURIComponent(quoteId)}`, payload, {
    schema: MarkResponseSchema,
    timeoutMs: 15000,
  });
  return r.ok ? { ok: true, data: r.data.deliveryState } : r;
}
