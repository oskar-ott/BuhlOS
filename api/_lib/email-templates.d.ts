// Type declarations for the CommonJS invite-email templates (api/_lib/email-templates.js).
// The module runs in the legacy API layer; this shim lets the vitest suite in
// src/ import and type-check it. Context shape is loose by design — the
// templates accept a plain context object assembled in api/employees.js.

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface InviteEmailContext {
  firstName: string;
  lastName?: string;
  companyName: string;
  roleLabel?: string;
  ctaUrl: string;
  expiresText: string;
  adminName: string;
  adminPhone?: string | null;
  optionalNote?: string | null;
}

export interface AcceptedEmailContext {
  firstName: string;
  lastName: string;
  timeText: string;
  jobText?: string | null;
  buhlosUrl: string;
  companyName?: string;
}

export function inviteEmail(ctx: InviteEmailContext): RenderedEmail;
export function resendEmail(ctx: InviteEmailContext): RenderedEmail;
export function expiredReplacementEmail(ctx: InviteEmailContext): RenderedEmail;
export function acceptedNotificationEmail(ctx: AcceptedEmailContext): RenderedEmail;
export function article(word: string): "a" | "an";
export const TEMPLATES: Record<string, (ctx: Record<string, unknown>) => RenderedEmail>;
