import { describe, expect, it } from "vitest";
import {
  canAccessBuhlOS,
  canAccessPhil,
  canAccessSurface,
  canApproveHours,
  canCreateJob,
  canManageGear,
  canPublishJobs,
  canReviewEvidence,
  canSubmitHours,
  canViewArchivedJobs,
  canViewAssignedGear,
  canViewCurrentPlans,
  canViewDraftJobs,
  canViewSupersededPlans,
  isOfficeRole,
} from "./permissions";

const ADMIN_TIER = ["admin", "boss", "owner", "manager", "office", "pm", "estimator"];
const LH_TIER = ["leadinghand", "leading_hand", "leading-hand", "lh"];
const FIELD_TIER = ["tradie", "apprentice", "labourer", "electrician"];
const DENIED = ["client", "", "  ", "nonsense", undefined, null];

/**
 * Job CREATE is literal-`admin`, deliberately narrower than the admin tier
 * that can build/edit a job. These tests lock in that asymmetry so a future
 * refactor can't quietly collapse create back onto canAccessSurface — which
 * would put a boss/pm in front of a create form whose submit 403s server-side.
 *
 * Cross-ref: api/jobs.js POST gate (`me.role !== 'admin'`); src/lib/auth/
 * permissions.ts canCreateJob; src/app/v2/jobs/new/page.tsx.
 */
describe("canCreateJob — job create is literal-admin, not the admin tier", () => {
  it("allows exactly the 'admin' role (case-insensitive)", () => {
    expect(canCreateJob("admin")).toBe(true);
    expect(canCreateJob("ADMIN")).toBe(true);
    expect(canCreateJob(" Admin ".trim())).toBe(true);
  });

  it("rejects the rest of the admin tier — they build/edit but can't create", () => {
    for (const role of ["boss", "owner", "manager", "office", "pm", "estimator"]) {
      expect(canCreateJob(role)).toBe(false);
    }
  });

  it("rejects leading-hand, field, client, and unknown/empty roles", () => {
    for (const role of [
      "lh",
      "leadinghand",
      "tradie",
      "apprentice",
      "labourer",
      "client",
      "",
      undefined,
      null,
    ]) {
      expect(canCreateJob(role)).toBe(false);
    }
  });

  it("is strictly narrower than admin-surface access (the anti-403 invariant)", () => {
    // A boss reaches the admin surface (and the builder/edit) but must NOT see
    // the create entry — POST /api/jobs would 403. If this ever fails, the
    // "New job" button / /v2/jobs/new gate has drifted back to admin-tier.
    expect(canAccessSurface("boss", "admin")).toBe(true);
    expect(canCreateJob("boss")).toBe(false);
  });
});

describe("named capability helpers — tier-aware, deny-by-default", () => {
  it("office/admin-tier capabilities admit the whole admin tier and nobody else", () => {
    for (const role of ADMIN_TIER) {
      expect(isOfficeRole(role)).toBe(true);
      expect(canAccessBuhlOS(role)).toBe(true);
      expect(canViewDraftJobs(role)).toBe(true);
      expect(canViewArchivedJobs(role)).toBe(true);
      expect(canPublishJobs(role)).toBe(true);
      expect(canReviewEvidence(role)).toBe(true);
      expect(canManageGear(role)).toBe(true);
    }
    for (const role of [...LH_TIER, ...FIELD_TIER, ...DENIED]) {
      expect(isOfficeRole(role)).toBe(false);
      expect(canAccessBuhlOS(role)).toBe(false);
      expect(canViewDraftJobs(role)).toBe(false);
      expect(canViewArchivedJobs(role)).toBe(false);
      expect(canPublishJobs(role)).toBe(false);
      expect(canReviewEvidence(role)).toBe(false);
      expect(canManageGear(role)).toBe(false);
    }
  });

  it("canApproveHours = staff (admin tier + every LH alias); never field/client/unknown", () => {
    for (const role of [...ADMIN_TIER, ...LH_TIER]) expect(canApproveHours(role)).toBe(true);
    for (const role of [...FIELD_TIER, ...DENIED]) expect(canApproveHours(role)).toBe(false);
  });

  it("canSubmitHours / Phil access = field + LH + admin (owner decision 2026-08-02); never client", () => {
    for (const role of [...FIELD_TIER, ...LH_TIER, ...ADMIN_TIER]) {
      expect(canSubmitHours(role)).toBe(true);
      expect(canAccessPhil(role)).toBe(true);
    }
    for (const role of DENIED) {
      expect(canSubmitHours(role)).toBe(false);
      expect(canAccessPhil(role)).toBe(false);
    }
  });

  it("assigned-gear stays field + LH; not admin or client", () => {
    for (const role of [...FIELD_TIER, ...LH_TIER]) {
      expect(canViewAssignedGear(role)).toBe(true);
    }
    for (const role of [...ADMIN_TIER, ...DENIED]) {
      expect(canViewAssignedGear(role)).toBe(false);
    }
  });

  it("plans: current viewable by field+LH+admin; superseded only by staff", () => {
    for (const role of [...ADMIN_TIER, ...LH_TIER, ...FIELD_TIER]) {
      expect(canViewCurrentPlans(role)).toBe(true);
    }
    for (const role of DENIED) expect(canViewCurrentPlans(role)).toBe(false);
    for (const role of [...ADMIN_TIER, ...LH_TIER]) expect(canViewSupersededPlans(role)).toBe(true);
    for (const role of [...FIELD_TIER, ...DENIED]) expect(canViewSupersededPlans(role)).toBe(false);
  });
});
