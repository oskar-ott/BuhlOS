import { describe, expect, it } from "vitest";
import { canAccessSurface, canCreateJob } from "./permissions";

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
