import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * #271 — the portal sanitisation boundary itself (api/_lib/portal-projection.js).
 *
 * Pure-function tests: the allowlist is exactly the six client-safe fields, a
 * non-visible status never projects, and progress is the canonical #198
 * pooled-count %. This is the single-source-of-truth allowlist both portal
 * endpoints depend on, tested in isolation from the HTTP layer.
 */

const requireFromHere = createRequire(import.meta.url);
const {
  projectJobForClient,
  isClientVisibleStatus,
  stageLabelFor,
} = requireFromHere("../../../api/_lib/portal-projection.js");

const ALLOWED_KEYS = ["id", "name", "siteAddress", "status", "progressPct", "stageLabel"].sort();

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "j1",
    name: "Riverside Units",
    siteAddress: "12 River Rd",
    status: "active",
    clientUserId: "u_client",
    ref: "REF-001",
    contractValue: 500000,
    internalNotes: "secret",
    roughInTasks: [{ id: "t1" }, { id: "t2" }],
    areaGroups: [{ id: "g1", areas: [{ id: "a1" }] }],
    ...overrides,
  };
}

describe("projectJobForClient — allowlist", () => {
  it("returns exactly the six client-safe keys", () => {
    const out = projectJobForClient(job(), {});
    expect(out).not.toBeNull();
    expect(Object.keys(out).sort()).toEqual(ALLOWED_KEYS);
  });

  it("never carries internal fields, even as values", () => {
    const out = projectJobForClient(job(), {});
    const s = JSON.stringify(out);
    for (const bad of ["REF-001", "contractValue", "500000", "internalNotes", "secret", "clientUserId", "roughInTasks"]) {
      expect(s).not.toContain(bad);
    }
  });

  it("returns null for a draft / archived / complete job (never serialised)", () => {
    for (const status of ["draft", "archived", "complete"]) {
      expect(projectJobForClient(job({ status }), {})).toBeNull();
    }
  });

  it("progress is the canonical pooled-count %, null when no checklist", () => {
    // 1 of 2 rough-in tasks complete → 50%.
    const dwellings = { a1: { roughIn: { tasks: { t1: "complete" } } } };
    expect(projectJobForClient(job(), dwellings).progressPct).toBe(50);
    // No checklist at all → null (UI renders "Not started", not a fake 0%).
    expect(projectJobForClient(job({ roughInTasks: [], areaGroups: [] }), {}).progressPct).toBeNull();
  });
});

describe("stageLabelFor", () => {
  it("maps the number to a coarse phase word", () => {
    expect(stageLabelFor(null)).toBe("Not started");
    expect(stageLabelFor(0)).toBe("Not started");
    expect(stageLabelFor(1)).toBe("In progress");
    expect(stageLabelFor(99)).toBe("In progress");
    expect(stageLabelFor(100)).toBe("Complete");
  });
});

describe("isClientVisibleStatus", () => {
  it("only active-like statuses are visible", () => {
    expect(isClientVisibleStatus("active")).toBe(true);
    expect(isClientVisibleStatus(undefined)).toBe(true); // defaults to active
    expect(isClientVisibleStatus("draft")).toBe(false);
    expect(isClientVisibleStatus("archived")).toBe(false);
    expect(isClientVisibleStatus("complete")).toBe(false);
  });
});
