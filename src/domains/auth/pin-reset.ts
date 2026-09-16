import { z } from "zod";
import { httpGet, httpPost, type HttpResult, type HttpError } from "@/lib/http";

/**
 * Self-service PIN / password recovery — the client half of api/pin-reset.js
 * (owner pull 2026-09-14: "I want the worker to be able to reset the pin if
 * they have logged out").
 *
 * The gate is inbox control: a link only ever goes to the address ON FILE, so
 * naming an account grants nobody anything. Asking DOES now say which of four
 * things happened (owner decision 2026-09-15) — the earlier
 * same-answer-every-time design left a worker who mistyped their address
 * waiting on a link that was never sent. See the header of api/pin-reset.js for
 * what protects the accounts instead.
 */

/** What a token is worth right now. Anything but `valid` is a dead end. */
export const PIN_RESET_STATES = ["valid", "expired", "used", "invalid"] as const;
export const PinResetStateSchema = z.enum(PIN_RESET_STATES);
export type PinResetState = z.infer<typeof PinResetStateSchema>;

export const PinResetResolveResponseSchema = z.object({
  state: PinResetStateSchema,
  /** Greeting only, and only on a valid token (the holder already proved
   *  inbox control). Absent for every dead-end state. */
  firstName: z.string().nullable().optional(),
  /** A literal 'admin' login sets a password; everyone else a 4-digit PIN. */
  isPassword: z.boolean().optional(),
});
export type PinResetResolveResponse = z.infer<typeof PinResetResolveResponseSchema>;

/** What the request actually did. Each one gets its own screen. */
export const PIN_RESET_OUTCOMES = ["sent", "no_account", "unavailable", "throttled"] as const;
export const PinResetOutcomeSchema = z.enum(PIN_RESET_OUTCOMES);
export type PinResetOutcome = z.infer<typeof PinResetOutcomeSchema>;

export const PinResetRequestResponseSchema = z.object({
  ok: z.literal(true),
  /** Optional so a reply from an older deploy still parses — treated as 'sent'. */
  outcome: PinResetOutcomeSchema.optional(),
  /** Present on 'throttled' only. */
  retryAfterSec: z.number().optional(),
});
export type PinResetRequestResponse = z.infer<typeof PinResetRequestResponseSchema>;

export const PinResetAcceptResponseSchema = z.object({
  ok: z.literal(true),
  /** Returned so the sign-in screen can prefill it. No session is created —
   *  they sign in with the new credential, which proves it works. */
  username: z.string().nullable().optional(),
});
export type PinResetAcceptResponse = z.infer<typeof PinResetAcceptResponseSchema>;

const sameOrigin = { cache: "no-store", credentials: "same-origin" } as const;

/** Friendly text from a failed call; the API returns `{ error }`. */
export function pinResetErrorText(err: HttpError): string {
  if (err.body && typeof err.body === "object" && "error" in err.body) {
    const e = (err.body as { error?: unknown }).error;
    if (typeof e === "string" && e) return e;
  }
  return err.message || "Something went wrong";
}

/**
 * Ask for a reset link. `outcome` says what happened, and the screen says it
 * plainly — including "there's no account with that email", which is the whole
 * point of the 2026-09-15 change: a worker who mistypes finds out immediately
 * instead of waiting on a link that was never coming.
 */
export function requestPinReset(email: string): Promise<HttpResult<PinResetRequestResponse>> {
  return httpPost<PinResetRequestResponse>(
    "/api/pin-reset?action=request",
    { email },
    { schema: PinResetRequestResponseSchema, init: { ...sameOrigin }, timeoutMs: 15000 }
  );
}

/** Check a token before showing the form, so there's no valid→error flicker. */
export function resolvePinResetToken(token: string): Promise<HttpResult<PinResetResolveResponse>> {
  return httpGet<PinResetResolveResponse>(
    `/api/pin-reset?action=resolve&token=${encodeURIComponent(token)}`,
    { schema: PinResetResolveResponseSchema, init: { ...sameOrigin } }
  );
}

/** Spend the link and set the new credential. */
export function acceptPinReset(input: {
  token: string;
  pin: string;
  confirmPin: string;
}): Promise<HttpResult<PinResetAcceptResponse>> {
  return httpPost<PinResetAcceptResponse>(
    "/api/pin-reset?action=accept",
    input,
    { schema: PinResetAcceptResponseSchema, init: { ...sameOrigin }, timeoutMs: 15000 }
  );
}
