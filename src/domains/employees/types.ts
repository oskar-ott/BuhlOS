import type { z } from "zod";
import type {
  EmployeeRoleSchema,
  AppAccessSchema,
  EmployeeStatusSchema,
  InviteStatusSchema,
  EmployeeSchema,
  InviteSchema,
  InvitePublicSchema,
  SetupSchema,
  EmployeeRowSchema,
  EmployeeListResponseSchema,
  EmployeeDetailResponseSchema,
  EmployeeMutationResponseSchema,
  CreateEmployeePayloadSchema,
  UpdateEmployeePayloadSchema,
  IssueInvitePayloadSchema,
  DisableEmployeePayloadSchema,
  InviteResolveStateSchema,
  ResolvedInviteSchema,
  ResolveInviteResponseSchema,
  AcceptInvitePayloadSchema,
  AcceptInviteResponseSchema,
} from "./schema";

/**
 * Employee-onboarding domain types (Pass O1).
 *
 * All entity types are inferred from the Zod schemas in ./schema.ts so the
 * wire shape and the TypeScript type can never drift. See ./schema.ts for the
 * storage and security notes (tokenHash is server-only; `Invite` carries it,
 * `InvitePublic` does not).
 *
 * Bible: "BuhlOS Phil Onboarding Interface Bible.html" §08.
 */

export type EmployeeRole = z.infer<typeof EmployeeRoleSchema>;
export type AppAccess = z.infer<typeof AppAccessSchema>;
export type EmployeeStatus = z.infer<typeof EmployeeStatusSchema>;
export type InviteStatus = z.infer<typeof InviteStatusSchema>;

export type Employee = z.infer<typeof EmployeeSchema>;
/** At-rest invite — carries `tokenHash`. Server-side only. */
export type Invite = z.infer<typeof InviteSchema>;
/** Client-safe invite — no `tokenHash`. */
export type InvitePublic = z.infer<typeof InvitePublicSchema>;
export type Setup = z.infer<typeof SetupSchema>;

export type EmployeeRow = z.infer<typeof EmployeeRowSchema>;
export type EmployeeListResponse = z.infer<typeof EmployeeListResponseSchema>;
export type EmployeeDetailResponse = z.infer<typeof EmployeeDetailResponseSchema>;
export type EmployeeMutationResponse = z.infer<typeof EmployeeMutationResponseSchema>;

/* O3 — worker invite resolution + acceptance. */
export type InviteResolveState = z.infer<typeof InviteResolveStateSchema>;
export type ResolvedInvite = z.infer<typeof ResolvedInviteSchema>;
export type ResolveInviteResponse = z.infer<typeof ResolveInviteResponseSchema>;
export type AcceptInvitePayload = z.infer<typeof AcceptInvitePayloadSchema>;
export type AcceptInviteResponse = z.infer<typeof AcceptInviteResponseSchema>;

export type CreateEmployeePayload = z.infer<typeof CreateEmployeePayloadSchema>;
export type UpdateEmployeePayload = z.infer<typeof UpdateEmployeePayloadSchema>;
export type IssueInvitePayload = z.infer<typeof IssueInvitePayloadSchema>;
export type DisableEmployeePayload = z.infer<typeof DisableEmployeePayloadSchema>;

/**
 * The visible status vocabulary from bible §08. These are the only chip labels
 * that may appear in the UI; internal employee/invite states are mapped onto
 * one of these markers by `employeeStatusMarker()` in ./service.ts.
 */
export type StatusMarkerKey =
  | "draft"
  | "invited"
  | "opened"
  | "active"
  | "expired"
  | "revoked"
  | "failed"
  | "disabled";

/** Repo StatusChip tones (src/components/ui/StatusChip.tsx). */
export type StatusTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "navy"
  | "yellow";

export interface StatusMarker {
  key: StatusMarkerKey;
  /** Human label exactly as it appears on a chip ("Invited", "Setup complete"…). */
  label: string;
  tone: StatusTone;
}

/** A selectable filter on the register (bible A1). */
export type EmployeeFilterKey =
  | "all"
  | "active"
  | "invited"
  | "incomplete"
  | "field"
  | "admin"
  | "disabled";

/** Static metadata for one role card (bible A3 / §09). */
export interface RoleDef {
  id: EmployeeRole;
  /** Card title, e.g. "Admin / Owner", "Leading hand". */
  title: string;
  appAccess: AppAccess;
  /** Chip styling bucket on the role card. */
  surfaceChip: "phil" | "buhlos" | "both";
  /** Display label under the card, e.g. "Field only", "Office only". */
  surfaceLabel: string;
  /** Plain-language outcome shown on the card. */
  description: string;
  /** True for roles surfaced but not fully wired (estimator tools are O5). */
  uc?: boolean;
}
