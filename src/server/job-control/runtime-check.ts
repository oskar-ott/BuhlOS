import { isAdminRole } from "@/lib/auth/roles";
import { ID_PREFIXES } from "@/domains/job-control/schema";

/**
 * Pure core of the job-control runtime-check route (ADR:
 * docs/architecture/job-control-runtime-adr.md).
 *
 * It exists to PROVE the new TypeScript runtime boundary: that a route handler
 * can import job-control domain code (`ID_PREFIXES` from the spine schema)
 * without duplicating any compiler logic, and that the boundary is admin-gated.
 * It compiles no job and writes no data. Pure + total → unit-testable without
 * mocking Next internals; the thin `route.ts` wrapper reads cookies/env and
 * calls this.
 */

export interface RuntimeCheckOk {
  ok: true;
  runtime: "ts-app-router";
  /** Proof the TS route imported the job-control domain at runtime. */
  jobControlDomainImport: true;
  /** A real domain constant echoed back, so the import is value-level, not just
   *  a type that erases at compile time. */
  workPackageIdPrefix: string;
  storage: "available" | "unconfigured";
}

export interface RuntimeCheckErr {
  ok: false;
  error: string;
}

export interface RuntimeCheckResult {
  status: number;
  body: RuntimeCheckOk | RuntimeCheckErr;
}

/**
 * Shape the runtime-check response. Admin-only: a missing role is 401, a
 * non-admin role is 403, an admin gets the 200 probe payload.
 */
export function buildRuntimeCheckResult(input: {
  role: string | null;
  storageConfigured: boolean;
}): RuntimeCheckResult {
  if (!input.role) {
    return { status: 401, body: { ok: false, error: "Not signed in" } };
  }
  if (!isAdminRole(input.role)) {
    return { status: 403, body: { ok: false, error: "Admin only" } };
  }
  return {
    status: 200,
    body: {
      ok: true,
      runtime: "ts-app-router",
      jobControlDomainImport: true,
      workPackageIdPrefix: ID_PREFIXES.workPackage,
      storage: input.storageConfigured ? "available" : "unconfigured",
    },
  };
}
