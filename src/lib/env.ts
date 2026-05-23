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
