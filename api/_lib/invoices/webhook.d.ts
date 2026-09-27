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
  forward?: (input: { emailId: string; address: string; env: Record<string, string | undefined> }) => Promise<{ ok: boolean; reason?: string; attachments: number }>;
  nowSec?: number;
  /** Task H: the owner-configured burst limiter for this delivery, or null when off. */
  burst?: () => Promise<{ limiter: { isLimited: (key: string, now?: number) => boolean; record: (key: string, now?: number) => void; retryAfterSec: (key: string, now?: number) => number }; key: string } | null>;
  /** Tests: the clock the burst limiter uses (ms). */
  nowMs?: number;
}

export interface InboundWebhookResult {
  status: number;
  body: Record<string, unknown>;
  /** Extra response headers (e.g. `retry-after` on a 429). */
  headers?: Record<string, string>;
}

export declare function handleInboundWebhook(input: {
  rawBody: string;
  headers: Record<string, string | undefined>;
  env?: Record<string, string | undefined>;
  deps: InboundWebhookDeps;
}): Promise<InboundWebhookResult>;

export declare const INGEST_BUDGET_MS: number;
