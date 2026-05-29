import { z } from "zod";

/**
 * Zod schemas for the employee-onboarding domain (Pass O1).
 *
 * Source of truth for screens/copy/states: "BuhlOS Phil Onboarding Interface
 * Bible.html" §08 (state model). Source of truth for storage convention:
 * the existing Vercel-Blob JSON pattern (api/_lib/blob.js) — onboarding lives
 * in two new blobs, `employees.json` and `invites.json`, so the production
 * `users.json` login store is never touched until a worker actually completes
 * setup (O3). Field nullability follows the server: optional fields are written
 * as explicit `null` (matching api/assets.js's sanitise pattern), so schemas
 * use `.nullable().optional()` to accept both shapes.
 *
 * SECURITY: the invite `token` is never stored or returned in plaintext except
 * once, at creation, for the admin copy-link. At rest only `tokenHash` (bcrypt)
 * exists, and it is NEVER serialised to the client — see InviteSchema vs
 * InvitePublicSchema. PIN handling is O3; see §10 of the bible.
 */

/* ---------------------------------------------------------------------------
 * Roles & access (bible §09)
 * ------------------------------------------------------------------------- */

/**
 * The eight named roles from the bible's role grid (A3 / §09). These map
 * cleanly onto the repo's existing role taxonomy in src/lib/auth/roles.ts —
 * apprentice/electrician/labourer are FIELD_ROLES, leadinghand is a
 * LEADING_HAND_ROLE, and admin/pm/office/estimator are ADMIN_ROLES — so the
 * precise role string can be stored verbatim with no lossy mapping. "Custom"
 * is the UC placeholder (granular permissions land in O5) and is NOT a
 * selectable value.
 */
export const EMPLOYEE_ROLES = [
  "admin",
  "pm",
  "office",
  "estimator",
  "leadinghand",
  "electrician",
  "apprentice",
  "labourer",
] as const;
export const EmployeeRoleSchema = z.enum(EMPLOYEE_ROLES);

/** Which app surface the person gets. Computed from role; never free-set. */
export const APP_ACCESS = ["phil", "buhlos", "both"] as const;
export const AppAccessSchema = z.enum(APP_ACCESS);

/**
 * Employee lifecycle status (bible §08 — the `employee` record carries the
 * coarse state; the fine-grained invite progress lives on the invite record).
 */
export const EMPLOYEE_STATUSES = ["draft", "invited", "active", "disabled"] as const;
export const EmployeeStatusSchema = z.enum(EMPLOYEE_STATUSES);

/** Invite lifecycle status (bible §08 — seven values). */
export const INVITE_STATUSES = [
  "draft",
  "sent",
  "opened",
  "accepted",
  "expired",
  "revoked",
  "failed",
] as const;
export const InviteStatusSchema = z.enum(INVITE_STATUSES);

/* ---------------------------------------------------------------------------
 * Employee record (bible §08 — "Employee · the person")
 * ------------------------------------------------------------------------- */

export const EmployeeSchema = z
  .object({
    id: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    /** Computed from first+last unless an explicit nickname override exists. */
    displayName: z.string().nullable().optional(),
    email: z.string(),
    /** AU mobile in E.164 when present. Optional (Open Decision Q8 default). */
    phone: z.string().nullable().optional(),
    role: EmployeeRoleSchema,
    /** Required when role = apprentice (validated in service.ts / API). */
    apprenticeYear: z.number().int().min(1).max(4).nullable().optional(),
    /** Derived from role — surfaced read-only in the drawer footer. */
    appAccess: AppAccessSchema,
    status: EmployeeStatusSchema,
    // Required on the wire — the server always writes an array (possibly empty)
    // so the response type stays exact (no zod input/output divergence).
    assignedJobIds: z.array(z.string()),
    assignedGearIds: z.array(z.string()),
    /** Admin-only — never surfaced to the worker. */
    notes: z.string().nullable().optional(),
    createdAt: z.string(),
    createdBy: z.string(),
    /** Updated on a Phil heartbeat — no heartbeat exists yet, so usually null. */
    lastActiveAt: z.string().nullable().optional(),
    disabledAt: z.string().nullable().optional(),
    /**
     * Link to the users.json login record, set only once the worker completes
     * setup (O3). Null for draft/invited employees — keeps the production
     * login store untouched during O1/O2.
     */
    userId: z.string().nullable().optional(),
    /**
     * `user` = mapped from an existing users.json login (the current team).
     * `onboarding` = created through the Add Employee drawer. Lets the UI
     * distinguish "already on the tools" from "pending invite".
     */
    source: z.enum(["user", "onboarding"]),
  })
  .passthrough();

/* ---------------------------------------------------------------------------
 * Invite record (bible §08 — "Invite · the bridge")
 *
 * Two shapes: the at-rest record (server-only, carries tokenHash) and the
 * public projection sent to the client (NEVER carries tokenHash).
 * ------------------------------------------------------------------------- */

const InviteBaseShape = {
  id: z.string(),
  employeeId: z.string(),
  /** Snapshot of the delivery target at send time. */
  email: z.string(),
  status: InviteStatusSchema,
  expiresAt: z.string(),
  sentAt: z.string().nullable().optional(),
  openedAt: z.string().nullable().optional(),
  acceptedAt: z.string().nullable().optional(),
  revokedAt: z.string().nullable().optional(),
  createdBy: z.string(),
  resentCount: z.number().int().min(0),
  /** How the latest invite was delivered (O2). `link` = copy-link fallback. */
  delivery: z.enum(["email", "link"]).nullable().optional(),
  /** Sanitised send-failure category (O2), e.g. "provider_rejected". No raw provider body. */
  sendError: z.string().nullable().optional(),
} as const;

/** At-rest invite (server-side only). `tokenHash` must never leave the server. */
export const InviteSchema = z
  .object({
    ...InviteBaseShape,
    /** bcrypt hash of the 32-byte URL-safe token. Never plaintext, never logged. */
    tokenHash: z.string(),
    /** ISO timestamps of resend events — server-only, drives the 3/hr rate limit. Stripped before client. */
    resendTimestamps: z.array(z.string()).optional(),
  })
  .passthrough();

/** Client-safe invite projection — identical minus `tokenHash`. */
export const InvitePublicSchema = z.object(InviteBaseShape).passthrough();

/* ---------------------------------------------------------------------------
 * Setup record (bible §08 — "Setup · the worker's progress"). Defined now for
 * a complete model; wired in O3.
 * ------------------------------------------------------------------------- */

export const SetupSchema = z
  .object({
    employeeId: z.string(),
    detailsConfirmed: z.boolean().default(false),
    loginCreated: z.boolean().default(false),
    introSeen: z.boolean().default(false),
    homeScreenPromptSeen: z.boolean().default(false),
    setupCompleteAt: z.string().nullable().optional(),
  })
  .passthrough();

/* ---------------------------------------------------------------------------
 * API responses
 * ------------------------------------------------------------------------- */

/** One register row = employee + its (optional) public invite + derived counts. */
export const EmployeeRowSchema = z.object({
  employee: EmployeeSchema,
  invite: InvitePublicSchema.nullable().optional(),
  jobsCount: z.number().int().min(0),
  gearCount: z.number().int().min(0),
});

export const EmployeeListResponseSchema = z.object({
  employees: z.array(EmployeeRowSchema),
  /** Whether a real email provider is wired. False → copy-link fallback. */
  emailConfigured: z.boolean(),
});

export const EmployeeDetailResponseSchema = z.object({
  row: EmployeeRowSchema,
  emailConfigured: z.boolean(),
});

/**
 * Create / invite response. `inviteLink` + `token` appear ONLY here, once, so
 * the admin can copy the link when no email provider is wired. They are never
 * persisted and never returned by any GET.
 */
export const EmployeeMutationResponseSchema = z.object({
  row: EmployeeRowSchema,
  /** Plaintext one-time invite link, present only when an invite was issued. */
  inviteLink: z.string().nullable().optional(),
  emailConfigured: z.boolean(),
});

export const ApiErrorBodySchema = z.object({
  error: z.string(),
  /** Duplicate-email errors carry the existing employee id for the "View" link. */
  existingEmployeeId: z.string().optional(),
});

/* ---------------------------------------------------------------------------
 * Mutation payloads
 * ------------------------------------------------------------------------- */

const AU_MOBILE_HELP = "Australian mobile, e.g. 0421 558 902 or +61 421 558 902";

/**
 * POST /api/employees — create an employee (admin only). Mirrors the four-step
 * drawer: details + access on create; jobs/gear optional; the invite is issued
 * separately via `?action=invite` (or `sendInvite: true` here as a shortcut).
 */
export const CreateEmployeePayloadSchema = z
  .object({
    firstName: z.string().trim().min(1, "First name is required").max(80),
    lastName: z.string().trim().min(1, "Last name is required").max(80),
    displayName: z.string().trim().max(80).nullable().optional(),
    email: z
      .string()
      .trim()
      .min(1, "Email is required")
      .email("That doesn't look like an email"),
    phone: z.string().trim().max(40, AU_MOBILE_HELP).nullable().optional(),
    role: EmployeeRoleSchema,
    apprenticeYear: z.number().int().min(1).max(4).nullable().optional(),
    assignedJobIds: z.array(z.string()).max(200).optional(),
    assignedGearIds: z.array(z.string()).max(200).optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    /** When false (or omitted) the employee is saved as a draft. */
    sendInvite: z.boolean().optional(),
    /** Invite validity in days (Open Decision Q2 default 14). */
    expiryDays: z.number().int().min(1).max(60).optional(),
    /** Optional personal line shown in the invite ("from boss"). */
    inviteNote: z.string().trim().max(280).nullable().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.role === "apprentice" && (val.apprenticeYear == null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["apprenticeYear"],
        message: "Apprentice year (1–4) is required for apprentices",
      });
    }
  });

/** PATCH /api/employees?id= — partial update (role / details / jobs / gear). */
export const UpdateEmployeePayloadSchema = z.object({
  id: z.string().min(1),
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  displayName: z.string().trim().max(80).nullable().optional(),
  email: z.string().trim().email("That doesn't look like an email").optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  role: EmployeeRoleSchema.optional(),
  apprenticeYear: z.number().int().min(1).max(4).nullable().optional(),
  assignedJobIds: z.array(z.string()).max(200).optional(),
  assignedGearIds: z.array(z.string()).max(200).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

/** POST /api/employees?action=invite&id= — issue (or re-issue) the invite. */
export const IssueInvitePayloadSchema = z.object({
  id: z.string().min(1),
  expiryDays: z.number().int().min(1).max(60).optional(),
  inviteNote: z.string().trim().max(280).nullable().optional(),
});

/** POST /api/employees?action=disable&id= — soft-disable (reversible). */
export const DisableEmployeePayloadSchema = z.object({
  id: z.string().min(1),
});

/* ---------------------------------------------------------------------------
 * O3 — worker invite resolution + acceptance (the Phil setup flow).
 *
 * SECURITY: the resolve response carries ONLY what the worker setup screens
 * need to render (bible §06 / §10 S07) — never the tokenHash, never internal
 * ids, never other employees' data. The token (in the URL) is the worker's
 * proof of identity; the server validates it before returning anything.
 * ------------------------------------------------------------------------- */

/** Landing states for /phil/invite/[token] (bible P1 / P8–P10). */
export const INVITE_RESOLVE_STATES = [
  "valid",
  "expired",
  "revoked",
  "accepted",
  "invalid",
] as const;
export const InviteResolveStateSchema = z.enum(INVITE_RESOLVE_STATES);

/** The safe, worker-facing projection returned only when state === "valid". */
export const ResolvedInviteSchema = z.object({
  firstName: z.string(),
  lastName: z.string(),
  displayName: z.string().nullable().optional(),
  email: z.string(),
  phone: z.string().nullable().optional(),
  role: EmployeeRoleSchema,
  roleLabel: z.string(),
  appAccess: AppAccessSchema,
  apprenticeYear: z.number().int().min(1).max(4).nullable().optional(),
  companyName: z.string(),
  expiresAt: z.string(),
  /** Assigned job display names (no ids) for the confirm step. */
  jobs: z.array(z.string()),
});

export const ResolveInviteResponseSchema = z.object({
  state: InviteResolveStateSchema,
  /** Present only for state === "valid". */
  invite: ResolvedInviteSchema.nullable().optional(),
});

/** POST /api/invites?action=accept — confirm details + create the 4-digit PIN. */
export const AcceptInvitePayloadSchema = z.object({
  token: z.string().min(1),
  pin: z.string().regex(/^\d{4}$/, "PIN must be 4 digits"),
  confirmPin: z.string().regex(/^\d{4}$/, "PIN must be 4 digits"),
  /** Worker may fill a missing phone during confirm (AU mobile). */
  phone: z.string().trim().max(40).nullable().optional(),
});

export const AcceptInviteResponseSchema = z.object({
  ok: z.literal(true),
  /** Where the worker should land — "/phil/my-day" (auto-session) or "/v2/login". */
  landing: z.string(),
  /** True when an authenticated session cookie was set on accept. */
  sessionCreated: z.boolean(),
});
