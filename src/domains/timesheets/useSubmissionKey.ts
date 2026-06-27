"use client";

import { useRef } from "react";

// Stable idempotency key for one logical hours submission (#497 client half).
//
// The server dedupes writes carrying the same Idempotency-Key, but that only
// helps if the CLIENT sends the SAME key when a worker retries. There is no
// auto-retry in the HTTP layer — a "retry" is the worker tapping submit again
// after a timeout on bad signal. So the key must:
//   • stay the SAME while the submission is unchanged (the retry → server
//     replays the original result instead of a confusing 409 / a duplicate),
//   • become FRESH when the worker changes what they're submitting (so a real
//     edit is never silently swallowed as a replay of an earlier value),
//   • reset after a confirmed success (the next distinct submission is new).
//
// The decision is a pure function (resolveSubmissionKey) so it can be unit
// tested without React; the hook is a thin useRef wrapper. This is the
// foundation the offline outbox (#143) builds on: a queued write replayed on
// reconnect carries the key minted when it was first attempted.

export type SubmissionKeyState = { sig: string; key: string } | null;

/** crypto.randomUUID with a safe fallback for older mobile webviews. */
export function defaultMintKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `te-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Pure core: given the currently-held state and a payload `signature`, return
 * the key to use and the next state. Same signature → reuse the held key (a
 * retry); a changed signature → mint a fresh key (a new submission).
 */
export function resolveSubmissionKey(
  current: SubmissionKeyState,
  signature: string,
  mint: () => string = defaultMintKey
): { key: string; next: { sig: string; key: string } } {
  if (current && current.sig === signature) {
    return { key: current.key, next: current };
  }
  const key = mint();
  return { key, next: { sig: signature, key } };
}

export interface SubmissionKey {
  /**
   * Returns the key for a submission identified by `signature` (a stable string
   * derived from the payload). Same signature → same key (a retry); a changed
   * signature → a fresh key (a new submission).
   */
  keyFor: (signature: string) => string;
  /** Drop the held key so the next submission starts fresh — call on success. */
  clear: () => void;
}

export function useSubmissionKey(): SubmissionKey {
  const ref = useRef<SubmissionKeyState>(null);
  return {
    keyFor(signature: string): string {
      const { key, next } = resolveSubmissionKey(ref.current, signature);
      ref.current = next;
      return key;
    },
    clear() {
      ref.current = null;
    },
  };
}
