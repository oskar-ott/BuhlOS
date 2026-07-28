import { z } from "zod";

/**
 * Crew sign-up link — shared pure logic for the public self-signup flow.
 *
 * The server sides live in api/signup.js (public resolve/submit — instant
 * access since 2026-07-28: a valid submission creates the account on the
 * spot) and api/employees.js (admin link controls + the joined-via-link
 * queue; approve remains for pre-instant leftover pending rows).
 * `resolveLinkState` here is the TS mirror of resolveLinkState in BOTH those
 * files — keep all three in sync (same rule as the invite-state mirror in
 * service.ts).
 */

export const SIGNUP_LINK_STATES = [
  "valid",
  "expired",
  "paused",
  "capped",
  "revoked",
  "invalid",
] as const;
export type SignupLinkState = (typeof SIGNUP_LINK_STATES)[number];

/** Roles a stranger with the group-chat link may request — field tiers only. */
export const SIGNUP_ROLES = ["electrician", "apprentice"] as const;
export type SignupRole = (typeof SIGNUP_ROLES)[number];

/**
 * Roles that may still sit in the stored request queue from before the picker
 * was narrowed to electrician/apprentice. The admin review schema and label
 * map accept these so old pending rows keep rendering and can be approved;
 * new submissions are held to SIGNUP_ROLES.
 */
export const LEGACY_SIGNUP_ROLES = [...SIGNUP_ROLES, "labourer", "leadinghand"] as const;
export type LegacySignupRole = (typeof LEGACY_SIGNUP_ROLES)[number];

/**
 * Which signup roles carry an apprentice-year tag. Data-driven so UI never
 * compares role-string literals (no-restricted-syntax tier-bug rule).
 */
export const SIGNUP_ROLE_NEEDS_YEAR: Record<LegacySignupRole, boolean> = {
  electrician: false,
  apprentice: true,
  labourer: false,
  leadinghand: false,
};

export const SIGNUP_ROLE_LABELS: Record<LegacySignupRole, string> = {
  electrician: "Electrician",
  apprentice: "Apprentice",
  labourer: "Labourer",
  leadinghand: "Leading hand",
};

export interface SignupLinkLike {
  status: "active" | "paused" | "revoked";
  expiresAt: string;
  cap?: number | null;
}

/** Mirror of api/signup.js#resolveLinkState — keep in sync. */
export function resolveLinkState(
  link: SignupLinkLike | null | undefined,
  pendingOrApprovedCount: number,
  nowMs: number,
): SignupLinkState {
  if (!link) return "invalid";
  if (link.status === "revoked") return "revoked";
  if (link.status === "paused") return "paused";
  const exp = Date.parse(link.expiresAt);
  if (Number.isFinite(exp) && exp < nowMs) return "expired";
  if (link.cap != null && pendingOrApprovedCount >= link.cap) return "capped";
  return "valid";
}

/** Safe public projection returned by /api/signup?action=resolve. */
export const SignupResolveResponseSchema = z.object({
  state: z.enum(SIGNUP_LINK_STATES),
  link: z
    .object({
      companyName: z.string(),
      createdByName: z.string().nullable().optional(),
      expiresAt: z.string(),
    })
    .nullable(),
});
export type SignupResolveResponse = z.infer<typeof SignupResolveResponseSchema>;

/** DOB sanity mirror of api/signup.js#isPlausibleDob — a typo net, not law. */
export function isPlausibleDob(iso: string, nowMs: number): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  const age = (nowMs - t) / (365.25 * 24 * 3600 * 1000);
  return age >= 14 && age <= 100;
}

/**
 * Queue row for the admin panel (pinHash never leaves the server). Since
 * instant access, new submissions arrive already `approved` (reviewedBy is a
 * server-side sentinel, stripped here with the other review fields) — pending
 * rows are pre-instant leftovers the admin can still approve or knock back.
 */
export const SignupRequestPublicSchema = z.object({
  id: z.string(),
  linkId: z.string(),
  status: z.enum(["pending", "approved", "rejected"]),
  firstName: z.string(),
  lastName: z.string(),
  preferredName: z.string().nullable(),
  email: z.string(),
  mobile: z.string(),
  role: z.enum(LEGACY_SIGNUP_ROLES),
  apprenticeYear: z.number().nullable(),
  legalName: z.string(),
  dob: z.string(),
  startDate: z.string().nullable(),
  submittedAt: z.string(),
  flags: z.object({
    duplicateEmail: z.boolean(),
    duplicateName: z.boolean(),
  }),
});
export type SignupRequestPublic = z.infer<typeof SignupRequestPublicSchema>;

/** Admin link projection returned by /api/employees?action=signup. */
export const SignupLinkViewSchema = z.object({
  id: z.string(),
  url: z.string(),
  status: z.enum(["active", "paused", "revoked"]),
  state: z.enum(SIGNUP_LINK_STATES),
  expiresAt: z.string(),
  cap: z.number().nullable(),
  createdAt: z.string(),
  counts: z.object({
    pending: z.number(),
    approved: z.number(),
    rejected: z.number(),
  }),
});
export type SignupLinkView = z.infer<typeof SignupLinkViewSchema>;

export const SignupAdminResponseSchema = z.object({
  link: SignupLinkViewSchema.nullable(),
  requests: z.array(SignupRequestPublicSchema),
});
export type SignupAdminResponse = z.infer<typeof SignupAdminResponseSchema>;
