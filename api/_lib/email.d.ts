// Type declarations for the CommonJS email sender (api/_lib/email.js).
// The module runs in the legacy API layer; this shim lets the vitest suite in
// src/ import and type-check it. Send results carry a stable failure category,
// never the provider's raw error body.

export interface SendResult {
  ok: boolean;
  id?: string | null;
  reason?: string;
  status?: number;
}

export function isEmailConfigured(): boolean;

export function sendEmail(msg: {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  /** Verified-domain sender overriding EMAIL_FROM for this message. */
  from?: string;
  replyTo?: string;
  /** content is base64-encoded file bytes. */
  attachments?: Array<{ filename: string; content: string }>;
}): Promise<SendResult>;

// kind ∈ invite | resend | expiredReplacement | accepted — but typed loose so
// tests can drive the unknown-kind branch.
export function sendTemplate(kind: string, ctx: Record<string, unknown>): Promise<SendResult>;

export function companyName(): string;
