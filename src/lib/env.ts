import { z } from "zod";

/**
 * Validated env vars. Read once at module load; failures throw at boot
 * rather than mysteriously at runtime.
 *
 * Vars used by the new Phase A surface are read here. Anything used only
 * by the legacy api/*.js endpoints is intentionally NOT validated here —
 * those endpoints validate their own env.
 */

const ServerEnvSchema = z.object({
  SESSION_SECRET: z.string().min(16, "SESSION_SECRET must be at least 16 chars"),
  BLOB_READ_WRITE_TOKEN: z.string().min(1).optional(),
  VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  VAPID_SUBJECT: z.string().min(1).optional(),
  // Transactional email provider for invite sending (bible §07, Open Decision
  // Q6 default = Resend). All optional — when the provider isn't fully
  // configured the onboarding flow falls back to the copy-invite-link path and
  // never fakes a send (bible §15 / §03 p5). Sending needs BOTH key + from.
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(1).optional(),
  /** Canonical base for invite CTA links in emails. Server falls back to the request host. */
  APP_BASE_URL: z.string().url().optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

let cached: ServerEnv | null = null;

/**
 * Returns validated server-side env. Safe to call from server components,
 * route handlers, and middleware. Will throw at app boot if invalid.
 *
 * In test mode (vitest/playwright), missing optional vars are tolerated;
 * SESSION_SECRET still must be set to a long-enough value via env.
 */
export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = ServerEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const message = parsed.error.errors
      .map((e) => `${e.path.join(".") || "(root)"}: ${e.message}`)
      .join("; ");
    throw new Error(`Invalid server env: ${message}`);
  }
  cached = parsed.data;
  return cached;
}

/**
 * Whether a real transactional-email provider is wired. Sending needs BOTH an
 * API key and a verified From address, so both must be present. Drives the
 * onboarding invite UI: true → "Send invite"; false → "Copy invite link"
 * fallback. Returns only a boolean — never exposes the key/from to the client.
 * api/_lib/email.js#isEmailConfigured() is the authoritative server check and
 * echoes the same boolean in API responses; this lets server components render
 * the right label on first paint.
 */
export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}
