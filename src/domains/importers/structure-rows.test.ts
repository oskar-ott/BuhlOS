import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Structure importer row builder (FK-root slice: tenant → user_profiles →
 * jobs). Pure mapping + quarantine rules — faithful field mapping, the
 * schema-CHECK value-lists (unknown role/status quarantines, never guesses),
 * duplicate-legacy-id detection, created_at preservation, and the
 * insert/mutable column lists staying in lock-step with the mapped keys.
 */

const requireFromHere = createRequire(import.meta.url);
const rowsPath = requireFromHere.resolve("../../../scripts/importers/lib/structure-rows.js");
const mod = requireFromHere(rowsPath) as {
  buildStructureRows: (
    sources: unknown,
    options?: { tenantSlug?: string; tenantName?: string; nowIso?: string }
  ) => {
    tenantRow: { slug: string; name: string };
    userRows: Array<Record<string, unknown>>;
    jobRows: Array<Record<string, unknown>>;
    quarantine: Array<{ table: string; id: string; reason: string }>;
  };
  USER_MUTABLE_COLS: string[];
  JOB_MUTABLE_COLS: string[];
  USER_INSERT_COLS: string[];
  JOB_INSERT_COLS: string[];
};
const { buildStructureRows, USER_INSERT_COLS, JOB_INSERT_COLS, USER_MUTABLE_COLS, JOB_MUTABLE_COLS } = mod;

const NOW = "2026-06-19T00:00:00.000Z";

function sources(users: unknown[], jobs: unknown[]) {
  return { users: { users }, jobs: { jobs } };
}

describe("buildStructureRows", () => {
  it("mints the tenant row from slug/name (defaults + overrides)", () => {
    expect(buildStructureRows(sources([], []), { nowIso: NOW }).tenantRow).toEqual({
      slug: "buhl",
      name: "Buhl Electrical",
    });
    expect(
      buildStructureRows(sources([], []), { tenantSlug: "acme", tenantName: "Acme" }).tenantRow
    ).toEqual({ slug: "acme", name: "Acme" });
  });

  it("maps a clean user faithfully", () => {
    const { userRows, quarantine } = buildStructureRows(
      sources([{ id: "u1", username: "Dev", role: "admin", createdAt: "2026-01-02T03:04:05.000Z" }], []),
      { nowIso: NOW }
    );
    expect(quarantine).toHaveLength(0);
    expect(userRows[0]).toEqual({
      legacy_user_id: "u1",
      username: "Dev",
      display_name: null,
      email: null,
      phone: null,
      role: "admin",
      is_active: true,
      created_at: "2026-01-02T03:04:05.000Z",
    });
  });

  it("marks a disabled user inactive and falls back created_at to import time", () => {
    const { userRows } = buildStructureRows(
      sources([{ id: "u2", username: "Old", role: "tradie", disabled: true }], []),
      { nowIso: NOW }
    );
    expect(userRows[0]!.is_active).toBe(false);
    expect(userRows[0]!.created_at).toBe(NOW);
  });

  it("maps a clean job faithfully (type→label, serviceM8→external_ref, empty ref→null, date coercion)", () => {
    const { jobRows, quarantine } = buildStructureRows(
      sources(
        [],
        [
          {
            id: "birdwood-x",
            name: "19 Birdwood Ave",
            status: "active",
            ref: "",
            type: "new build",
            serviceM8JobId: "sm8-123",
            siteAddress: "19 Birdwood Ave",
            inductionRequired: true,
            startDate: "2026-06-01T00:00:00.000Z",
            programmedDurationDays: 30,
          },
        ]
      ),
      { nowIso: NOW }
    );
    expect(quarantine).toHaveLength(0);
    expect(jobRows[0]).toMatchObject({
      legacy_id: "birdwood-x",
      name: "19 Birdwood Ave",
      status: "active",
      ref: null,
      job_type_label: "new build",
      external_ref: "sm8-123",
      site_address: "19 Birdwood Ave",
      induction_required: true,
      start_date: "2026-06-01",
      programmed_duration_days: 30,
    });
  });

  it("defaults a missing job status to draft", () => {
    const { jobRows } = buildStructureRows(sources([], [{ id: "j1", name: "J" }]), { nowIso: NOW });
    expect(jobRows[0]!.status).toBe("draft");
  });

  it("quarantines an unknown role and an unknown status — never guesses", () => {
    const { userRows, jobRows, quarantine } = buildStructureRows(
      sources(
        [{ id: "u1", username: "X", role: "supervisor" }],
        [{ id: "j1", name: "J", status: "tendering" }]
      ),
      { nowIso: NOW }
    );
    expect(userRows).toHaveLength(0);
    expect(jobRows).toHaveLength(0);
    expect(quarantine).toEqual([
      expect.objectContaining({ table: "user_profiles", id: "u1" }),
      expect.objectContaining({ table: "jobs", id: "j1" }),
    ]);
  });

  it("quarantines duplicate legacy ids on both sides", () => {
    const { userRows, jobRows, quarantine } = buildStructureRows(
      sources(
        [
          { id: "u1", username: "A", role: "tradie" },
          { id: "u1", username: "B", role: "tradie" },
        ],
        [
          { id: "j1", name: "A", status: "draft" },
          { id: "j1", name: "B", status: "draft" },
        ]
      ),
      { nowIso: NOW }
    );
    expect(userRows).toHaveLength(1);
    expect(jobRows).toHaveLength(1);
    expect(quarantine.filter((q) => q.reason.includes("duplicate"))).toHaveLength(2);
  });

  it("quarantines records missing required identity fields", () => {
    const { quarantine } = buildStructureRows(
      sources([{ username: "noid", role: "tradie" }], [{ id: "j", status: "draft" }]),
      { nowIso: NOW }
    );
    expect(quarantine).toHaveLength(2);
  });

  it("keeps the insert column lists in lock-step with the mapped keys", () => {
    const { userRows, jobRows } = buildStructureRows(
      sources([{ id: "u1", username: "X", role: "admin" }], [{ id: "j1", name: "J", status: "draft" }]),
      { nowIso: NOW }
    );
    // every mapped key is an insert col (minus tenant_id, added at write time)
    expect(new Set(USER_INSERT_COLS)).toEqual(new Set(["tenant_id", ...Object.keys(userRows[0]!)]));
    expect(new Set(JOB_INSERT_COLS)).toEqual(new Set(["tenant_id", ...Object.keys(jobRows[0]!)]));
    // mutable cols are a subset of insert cols and exclude the identity/created_at
    for (const c of USER_MUTABLE_COLS) expect(USER_INSERT_COLS).toContain(c);
    for (const c of JOB_MUTABLE_COLS) expect(JOB_INSERT_COLS).toContain(c);
    expect(USER_MUTABLE_COLS).not.toContain("legacy_user_id");
    expect(USER_MUTABLE_COLS).not.toContain("created_at");
    expect(JOB_MUTABLE_COLS).not.toContain("legacy_id");
    expect(JOB_MUTABLE_COLS).not.toContain("created_at");
  });
});
