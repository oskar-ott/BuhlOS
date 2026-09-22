// Type declarations for the CommonJS inbound-webhook core
// (api/_lib/invoices/webhook.js) so the Next route handler consumes it
// type-checked. See api/_lib/feature-flags.d.ts for the pattern.

export interface InboundWebhookDeps {
  isFlagOn: (key: string) => Promise<boolean>;
  getDb: (opts: { mode: "read" | "write" }) => unknown;
  store: unknown;
  ingest: (input: unknown) => Promise<unknown>;
  resend: unknown;
  storePdf: (input: unknown) => Promise<{ url: string; pathname: string }>;
  sha256: (bytes: Uint8Array) => string;
  processOne?: (input: { sql: unknown; tenant: unknown; invoiceId: string }) => Promise<unknown>;
  nowSec?: number;
}

export interface InboundWebhookResult {
  status: number;
  body: Record<string, unknown>;
}

export declare function handleInboundWebhook(input: {
  rawBody: string;
  headers: Record<string, string | undefined>;
  env?: Record<string, string | undefined>;
  deps: InboundWebhookDeps;
}): Promise<InboundWebhookResult>;

export declare const INGEST_BUDGET_MS: number;
