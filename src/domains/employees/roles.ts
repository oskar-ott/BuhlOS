import type { AppAccess, EmployeeRole, RoleDef } from "./types";

/**
 * Role → surface → access definitions (bible §05 A3 role grid + §09 matrix).
 *
 * "Role IS the permission" in v1 — no granular matrix until O5. Each role is
 * pre-wired to an app-access bucket (the one branching decision in onboarding,
 * bible §03 principle 3). The plain-language `description` is the copy shown on
 * the role card; `surfaceLabel` is the footer scope line.
 *
 * These eight ids are a subset of the repo's existing role taxonomy
 * (src/lib/auth/roles.ts), so the stored role string flows through the
 * existing isAdminRole / isFieldRole / isLeadingHandRole helpers unchanged.
 */
export const ROLE_DEFS: Record<EmployeeRole, RoleDef> = {
  admin: {
    id: "admin",
    title: "Admin / Owner",
    appAccess: "both",
    surfaceChip: "buhlos",
    surfaceLabel: "Office, full access",
    description:
      "Full access to BuhlOS admin tools. Approves hours. Manages gear, jobs, employees.",
  },
  pm: {
    id: "pm",
    title: "Project manager",
    appAccess: "buhlos",
    surfaceChip: "buhlos",
    surfaceLabel: "Office only",
    description: "Views and reviews jobs. Approves snags and ITPs. No payroll access.",
  },
  office: {
    id: "office",
    title: "Office",
    appAccess: "buhlos",
    surfaceChip: "buhlos",
    surfaceLabel: "Office only",
    description: "Selected admin tools. Hours, gear, documents. No employee management.",
  },
  estimator: {
    id: "estimator",
    title: "Estimator",
    appAccess: "buhlos",
    surfaceChip: "buhlos",
    surfaceLabel: "Office · estimating (O5)",
    description: "Accesses estimating tools when available. UC placeholder in O1.",
    uc: true,
  },
  leadinghand: {
    id: "leadinghand",
    title: "Leading hand",
    appAccess: "phil",
    surfaceChip: "both",
    surfaceLabel: "Field, with sign-off",
    description:
      "Uses Phil daily. Can review crew hours and sign off snags on assigned jobs.",
  },
  electrician: {
    id: "electrician",
    title: "Electrician",
    appAccess: "phil",
    surfaceChip: "phil",
    surfaceLabel: "Field only",
    description: "Uses Phil for hours, gear, jobs, site records. The day-to-day field user.",
  },
  apprentice: {
    id: "apprentice",
    title: "Apprentice",
    appAccess: "phil",
    surfaceChip: "phil",
    surfaceLabel: "Field only",
    description: "Uses Phil for hours, gear, jobs. Same as electrician with year tag (1–4).",
  },
  labourer: {
    id: "labourer",
    title: "Labourer",
    appAccess: "phil",
    surfaceChip: "phil",
    surfaceLabel: "Field only",
    description: "Uses Phil for hours and jobs. Gear typically not assigned.",
  },
};

/** Roles in the order the cards appear in the drawer (bible A3). */
export const ROLE_ORDER: ReadonlyArray<EmployeeRole> = [
  "admin",
  "pm",
  "office",
  "estimator",
  "leadinghand",
  "electrician",
  "apprentice",
  "labourer",
];

/** Type guard for an arbitrary string being one of the eight roles. */
export function isEmployeeRole(value: unknown): value is EmployeeRole {
  return typeof value === "string" && value in ROLE_DEFS;
}

/**
 * Derive the app-access bucket from a role. The drawer footer shows this
 * read-only ("Will use Phil only" / "Will use BuhlOS only" / "Both") the
 * moment a role is picked (bible A3 acceptance criteria).
 */
export function deriveAppAccess(role: EmployeeRole): AppAccess {
  return ROLE_DEFS[role].appAccess;
}

/** Short sentence for the drawer footer once a role is selected (bible A3). */
export function appAccessFooter(role: EmployeeRole): string {
  switch (deriveAppAccess(role)) {
    case "phil":
      return "Will use Phil only.";
    case "buhlos":
      return "Will use BuhlOS only.";
    case "both":
      return "Will use both BuhlOS and Phil.";
  }
}

/**
 * Friendly label for any role string — including the legacy users.json tiers
 * (admin/boss/owner/manager/tradie/leadingHand/client) — so the register can
 * render existing staff alongside onboarding employees without a lossy stored
 * mapping. Unknown strings title-case through as a fallback.
 */
export function displayRoleLabel(rawRole: string | null | undefined): string {
  const r = String(rawRole ?? "").toLowerCase();
  if (isEmployeeRole(r)) return ROLE_DEFS[r].title;
  switch (r) {
    case "owner":
    case "boss":
    case "manager":
      return "Admin / Owner";
    case "leadinghand":
    case "leading_hand":
    case "leading-hand":
    case "lh":
      return "Leading hand";
    case "tradie":
      return "Field worker";
    case "client":
      return "Client";
    case "":
      return "—";
    default:
      return r.charAt(0).toUpperCase() + r.slice(1);
  }
}
