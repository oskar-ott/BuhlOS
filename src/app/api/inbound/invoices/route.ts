import { NextResponse } from "next/server";
import { handleInboundWebhook } from "../../../../../api/_lib/invoices/webhook.js";
import { webhookDeps } from "../../../../../api/_lib/invoices/runtime.js";

/**
 * Resend Inbound webhook for supplier invoices — `POST /api/inbound/invoices`.
 *
 * Why a Next route handler and not an api/*.js function: Svix signature
 * verification needs the EXACT raw request body, and the Vercel api/ runtime
 * hands handlers a pre-parsed body. `request.text()` here is the raw bytes.
 * Everything else about the flow (verification, replay guard, quarantine
 * while the flag is off, bounded ingest) lives in api/_lib/invoices/webhook.js
 * and is unit-tested there with signed fixtures. No session cookie is read:
 * the webhook is authenticated by the provider signature alone, scoped by the
 * unguessable inbound address token, and does nothing but record + fetch.
 *
 * docs/invoice-capture.md → "Inbound email".
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const headers: Record<string, string | undefined> = {
    "svix-id": request.headers.get("svix-id") ?? undefined,
    "svix-timestamp": request.headers.get("svix-timestamp") ?? undefined,
    "svix-signature": request.headers.get("svix-signature") ?? undefined,
  };
  const result = await handleInboundWebhook({ rawBody, headers, deps: webhookDeps() });
  return NextResponse.json(result.body, {
    status: result.status,
    headers: { "cache-control": "no-store" },
  });
}

export function GET(): Response {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
