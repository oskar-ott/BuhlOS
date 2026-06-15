import { describe, expect, it } from "vitest";
import { buildRuntimeCheckResult } from "./runtime-check";
import { ID_PREFIXES } from "@/domains/job-control/schema";

/**
 * Proves the runtime boundary's pure core: it imports a real job-control domain
 * symbol (no compiler duplication), gates on admin, and returns the probe shape.
 */
describe("buildRuntimeCheckResult", () => {
  it("401s when there is no role", () => {
    const r = buildRuntimeCheckResult({ role: null, storageConfigured: true });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ ok: false, error: "Not signed in" });
  });

  it("403s for a non-admin (field) role — workers cannot use the boundary", () => {
    const r = buildRuntimeCheckResult({ role: "electrician", storageConfigured: true });
    expect(r.status).toBe(403);
    expect(r.body.ok).toBe(false);
  });

  it("200s for an admin with the expected probe shape, echoing a real domain constant", () => {
    const r = buildRuntimeCheckResult({ role: "admin", storageConfigured: true });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      runtime: "ts-app-router",
      jobControlDomainImport: true,
      workPackageIdPrefix: ID_PREFIXES.workPackage,
      storage: "available",
    });
    // The echoed value is the real spine constant, proving a value-level import.
    expect(ID_PREFIXES.workPackage).toBe("wp_");
  });

  it("reports storage as unconfigured when no token is present (no network call)", () => {
    const r = buildRuntimeCheckResult({ role: "admin", storageConfigured: false });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, storage: "unconfigured" });
  });
});
