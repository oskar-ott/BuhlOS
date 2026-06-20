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
    groupRows: Array<Record<string, unknown>>;
    areaRows: Array<Record<string, unknown>>;
    templateRows: Array<Record<string, unknown>>;
    quarantine: Array<{ table: string; id: string; reason: string }>;
  };
  USER_MUTABLE_COLS: string[];
  JOB_MUTABLE_COLS: string[];
  USER_INSERT_COLS: string[];
  JOB_INSERT_COLS: string[];
  GROUP_MUTABLE_COLS: string[];
  AREA_MUTABLE_COLS: string[];
  GROUP_INSERT_COLS: string[];
  AREA_INSERT_COLS: string[];
  TEMPLATE_MUTABLE_COLS: string[];
  TEMPLATE_INSERT_COLS: string[];
};
const {
  buildStructureRows, USER_INSERT_COLS, JOB_INSERT_COLS, USER_MUTABLE_COLS, JOB_MUTABLE_COLS,
  GROUP_INSERT_COLS, AREA_INSERT_COLS, GROUP_MUTABLE_COLS, AREA_MUTABLE_COLS,
  TEMPLATE_INSERT_COLS, TEMPLATE_MUTABLE_COLS,
} = mod;

const legacyIdPath = requireFromHere.resolve("../../../scripts/importers/lib/structure-legacy-id.js");
const { compositeLegacyId } = requireFromHere(legacyIdPath) as {
  compositeLegacyId: (jobLegacyId: string, localId: string) => string;
};

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

  it("quarantines a case-insensitive username collision (user_profiles_username_uq)", () => {
    const { userRows, quarantine } = buildStructureRows(
      sources(
        [
          { id: "u1", username: "Dev", role: "admin" },
          { id: "u2", username: "dev", role: "tradie" },
        ],
        []
      ),
      { nowIso: NOW }
    );
    expect(userRows).toHaveLength(1);
    expect(userRows[0]!.legacy_user_id).toBe("u1");
    expect(quarantine).toEqual([
      expect.objectContaining({ table: "user_profiles", id: "u2", reason: expect.stringContaining("username") }),
    ]);
  });

  it("nulls a calendar-invalid date instead of passing it to the DATE column", () => {
    const { jobRows } = buildStructureRows(
      sources([], [{ id: "j1", name: "J", status: "draft", startDate: "2026-13-45", dueDate: "2026-06-30" }]),
      { nowIso: NOW }
    );
    expect(jobRows[0]!.start_date).toBeNull();
    expect(jobRows[0]!.due_date).toBe("2026-06-30");
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

// ── J1: site_area_groups + site_areas ──────────────────────────────────────
function jobWith(id: string, areaGroups: unknown[], extra: Record<string, unknown> = {}) {
  return { id, name: `Job ${id}`, status: "active", areaGroups, ...extra };
}

describe("compositeLegacyId — minting", () => {
  it("mints a deterministic job-scoped composite (not the raw blob id)", () => {
    expect(compositeLegacyId("job1", "apt_001")).toBe('["job1","apt_001"]');
    expect(compositeLegacyId("job1", "apt_001")).toBe(compositeLegacyId("job1", "apt_001"));
  });

  it("is delimiter-safe — a '::'-style scheme would collide, the JSON tuple does not", () => {
    // job "a::b" + area "c"  vs  job "a" + area "b::c" would both be "a::b::c"
    // under naive joining; the JSON tuple keeps them distinct.
    expect(compositeLegacyId("a::b", "c")).not.toBe(compositeLegacyId("a", "b::c"));
  });
});

describe("buildStructureRows — J1 groups/areas", () => {
  it("maps a clean group + area faithfully with composite legacy_ids (jobs keep the raw id)", () => {
    const { jobRows, groupRows, areaRows, quarantine } = buildStructureRows(
      sources([], [jobWith("j1", [
        { id: "g1", name: "Ground floor", order: 2, areas: [
          { id: "apt_001", name: "Unit 1", spaceType: "apartment", order: 5 },
        ] },
      ])]),
      { nowIso: NOW }
    );
    expect(quarantine).toHaveLength(0);
    expect(jobRows[0]!.legacy_id).toBe("j1"); // jobs keep the raw id
    expect(groupRows[0]).toEqual({
      legacy_id: '["j1","g1"]', job_legacy_id: "j1", name: "Ground floor",
      sort_order: 2, deleted_at: null, deleted_by: null, created_at: NOW,
    });
    expect(areaRows[0]).toEqual({
      legacy_id: '["j1","apt_001"]', job_legacy_id: "j1", group_legacy_id: '["j1","g1"]',
      name: "Unit 1", space_type: "apartment", sort_order: 5,
      deleted_at: null, deleted_by: null, created_at: NOW,
    });
  });

  it("defaults a missing order to sort_order 0 and a missing spaceType to null", () => {
    const { areaRows } = buildStructureRows(
      sources([], [jobWith("j1", [{ id: "g1", name: "G", areas: [{ id: "a1", name: "A" }] }])]),
      { nowIso: NOW }
    );
    expect(areaRows[0]!.sort_order).toBe(0);
    expect(areaRows[0]!.space_type).toBeNull();
  });

  it("does NOT collide on the same blob area id across DIFFERENT jobs (the whole point of job-scoping)", () => {
    const { areaRows, quarantine } = buildStructureRows(
      sources([], [
        jobWith("j1", [{ id: "g1", name: "G", areas: [{ id: "apt_001", name: "U1" }] }]),
        jobWith("j2", [{ id: "g1", name: "G", areas: [{ id: "apt_001", name: "U1" }] }]),
      ]),
      { nowIso: NOW }
    );
    expect(quarantine).toHaveLength(0);
    expect(areaRows.map((r) => r.legacy_id).sort()).toEqual(['["j1","apt_001"]', '["j2","apt_001"]']);
  });

  it("QUARANTINES a duplicate area id WITHIN one job (composite collision — fail closed)", () => {
    const { areaRows, quarantine } = buildStructureRows(
      sources([], [jobWith("j1", [
        { id: "g1", name: "G", areas: [
          { id: "apt_001", name: "U1" },
          { id: "apt_001", name: "U1 again" },
        ] },
      ])]),
      { nowIso: NOW }
    );
    expect(areaRows).toHaveLength(1);
    expect(quarantine).toEqual([
      expect.objectContaining({ table: "site_areas", id: '["j1","apt_001"]', reason: expect.stringContaining("collision") }),
    ]);
  });

  it("QUARANTINES a duplicate group id within one job", () => {
    const { groupRows, quarantine } = buildStructureRows(
      sources([], [jobWith("j1", [
        { id: "g1", name: "G", areas: [] },
        { id: "g1", name: "G dup", areas: [] },
      ])]),
      { nowIso: NOW }
    );
    expect(groupRows).toHaveLength(1);
    expect(quarantine).toEqual([
      expect.objectContaining({ table: "site_area_groups", id: '["j1","g1"]', reason: expect.stringContaining("collision") }),
    ]);
  });

  it("maps archived → deleted_at (proxy = nowIso), deleted_by stays NULL (no fabricated actor)", () => {
    const { groupRows, areaRows } = buildStructureRows(
      sources([], [jobWith("j1", [
        { id: "g1", name: "Archived wing", archived: true, areas: [
          { id: "a1", name: "Archived area", archived: true },
          { id: "a2", name: "Live area" },
        ] },
      ])]),
      { nowIso: NOW }
    );
    expect(groupRows[0]!.deleted_at).toBe(NOW);
    expect(groupRows[0]!.deleted_by).toBeNull();
    const archived = areaRows.find((r) => r.legacy_id === '["j1","a1"]')!;
    const live = areaRows.find((r) => r.legacy_id === '["j1","a2"]')!;
    expect(archived.deleted_at).toBe(NOW);
    expect(archived.deleted_by).toBeNull();
    expect(live.deleted_at).toBeNull();
  });

  it("quarantines a group/area missing required identity fields", () => {
    const { quarantine } = buildStructureRows(
      sources([], [jobWith("j1", [
        { name: "no id group", areas: [] },
        { id: "g2", name: "G", areas: [{ name: "no id area" }] },
      ])]),
      { nowIso: NOW }
    );
    expect(quarantine).toEqual([
      expect.objectContaining({ table: "site_area_groups" }),
      expect.objectContaining({ table: "site_areas" }),
    ]);
  });

  it("builds rows deterministically (idempotent row building — same input → identical rows)", () => {
    const src = sources([], [jobWith("j1", [
      { id: "g1", name: "G", areas: [{ id: "a1", name: "A", spaceType: "x", order: 1 }] },
    ])]);
    const a = buildStructureRows(src, { nowIso: NOW });
    const b = buildStructureRows(src, { nowIso: NOW });
    expect(a.groupRows).toEqual(b.groupRows);
    expect(a.areaRows).toEqual(b.areaRows);
  });

  it("keeps the group/area insert + mutable column lists in lock-step with the mapped keys", () => {
    const { groupRows, areaRows } = buildStructureRows(
      sources([], [jobWith("j1", [{ id: "g1", name: "G", areas: [{ id: "a1", name: "A" }] }])]),
      { nowIso: NOW }
    );
    // The insert col lists are EXACTLY these (the writer resolves the row's
    // job_legacy_id/group_legacy_id into the job_id/group_id FK columns). Strict
    // equality so an added/removed column is caught.
    expect(new Set(GROUP_INSERT_COLS)).toEqual(
      new Set(["tenant_id", "job_id", "legacy_id", "name", "sort_order", "deleted_at", "deleted_by", "created_at"])
    );
    expect(new Set(AREA_INSERT_COLS)).toEqual(
      new Set(["tenant_id", "job_id", "group_id", "legacy_id", "name", "space_type", "sort_order", "deleted_at", "deleted_by", "created_at"])
    );
    // plain mutable cols are a subset of insert cols (deleted_at handled via CASE)
    for (const c of GROUP_MUTABLE_COLS) expect(GROUP_INSERT_COLS).toContain(c);
    for (const c of AREA_MUTABLE_COLS) expect(AREA_INSERT_COLS).toContain(c);
    // deleted_at is handled by a special CASE, so it must NOT be a plain mutable col
    expect(GROUP_MUTABLE_COLS).not.toContain("deleted_at");
    expect(AREA_MUTABLE_COLS).not.toContain("deleted_at");
    expect(GROUP_MUTABLE_COLS).not.toContain("legacy_id");
    expect(AREA_MUTABLE_COLS).not.toContain("legacy_id");
    expect(groupRows).toHaveLength(1);
    expect(areaRows).toHaveLength(1);
  });
});

// ── J2: job_task_templates ─────────────────────────────────────────────────
describe("buildStructureRows — J2 templates", () => {
  it("emits job-level templates (site_area_legacy_id null, legacy_id = BARE taskId)", () => {
    const { templateRows, quarantine } = buildStructureRows(
      sources([], [jobWith("j1", [], {
        roughInTasks: [{ id: "rough_power", name: "Rough power", order: 1 }],
        fitOffTasks: [{ id: "fit_gpo", name: "Fit GPOs" }],
      })]),
      { nowIso: NOW }
    );
    expect(quarantine).toHaveLength(0);
    expect(templateRows).toHaveLength(2);
    const rough = templateRows.find((r) => r.legacy_id === "rough_power")!;
    expect(rough).toEqual({
      legacy_id: "rough_power", job_legacy_id: "j1", site_area_legacy_id: null,
      stage: "roughIn", name: "Rough power", sort_order: 1, deleted_at: null, deleted_by: null, created_at: NOW,
    });
    const fit = templateRows.find((r) => r.legacy_id === "fit_gpo")!;
    expect(fit.stage).toBe("fitOff");
    expect(fit.sort_order).toBe(0); // missing order → 0
  });

  it("emits per-area override templates (site_area_legacy_id = composite area id)", () => {
    const { templateRows } = buildStructureRows(
      sources([], [jobWith("j1", [
        { id: "g1", name: "G", areas: [{ id: "a1", name: "A", roughInTasks: [{ id: "rough_data", name: "Rough data" }] }] },
      ])]),
      { nowIso: NOW }
    );
    const t = templateRows.find((r) => r.legacy_id === "rough_data")!;
    expect(t.site_area_legacy_id).toBe(compositeLegacyId("j1", "a1"));
    expect(t.job_legacy_id).toBe("j1");
    expect(t.stage).toBe("roughIn");
  });

  it("job-level default and per-area override of the SAME taskId coexist as distinct rows (no collision)", () => {
    const { templateRows, quarantine } = buildStructureRows(
      sources([], [jobWith("j1", [
        { id: "g1", name: "G", areas: [{ id: "a1", name: "A", roughInTasks: [{ id: "rough_power", name: "Rough power (area)" }] }] },
      ], { roughInTasks: [{ id: "rough_power", name: "Rough power (job)" }] })]),
      { nowIso: NOW }
    );
    expect(quarantine).toHaveLength(0);
    const rows = templateRows.filter((r) => r.legacy_id === "rough_power");
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.site_area_legacy_id))).toEqual(new Set([null, compositeLegacyId("j1", "a1")]));
  });

  it("the same bare taskId in two different areas does NOT collide", () => {
    const { templateRows, quarantine } = buildStructureRows(
      sources([], [jobWith("j1", [
        { id: "g1", name: "G", areas: [
          { id: "a1", name: "A1", roughInTasks: [{ id: "rough_power", name: "RP" }] },
          { id: "a2", name: "A2", roughInTasks: [{ id: "rough_power", name: "RP" }] },
        ] },
      ])]),
      { nowIso: NOW }
    );
    expect(quarantine).toHaveLength(0);
    expect(templateRows.filter((r) => r.legacy_id === "rough_power")).toHaveLength(2);
  });

  it("QUARANTINES a duplicate template id within the same job-level stage", () => {
    const { templateRows, quarantine } = buildStructureRows(
      sources([], [jobWith("j1", [], {
        roughInTasks: [{ id: "dup", name: "First" }, { id: "dup", name: "Second" }],
      })]),
      { nowIso: NOW }
    );
    expect(templateRows).toHaveLength(1);
    expect(quarantine).toEqual([
      expect.objectContaining({ table: "job_task_templates", reason: expect.stringContaining("partial-unique collision") }),
    ]);
  });

  it("QUARANTINES a duplicate template id within the same area stage", () => {
    const { templateRows, quarantine } = buildStructureRows(
      sources([], [jobWith("j1", [
        { id: "g1", name: "G", areas: [{ id: "a1", name: "A", fitOffTasks: [{ id: "dup", name: "x" }, { id: "dup", name: "y" }] }] },
      ])]),
      { nowIso: NOW }
    );
    expect(templateRows).toHaveLength(1);
    expect(quarantine.filter((q) => q.table === "job_task_templates")).toHaveLength(1);
  });

  it("maps archived template → deleted_at, deleted_by NULL", () => {
    const { templateRows } = buildStructureRows(
      sources([], [jobWith("j1", [], {
        roughInTasks: [{ id: "live", name: "Live" }, { id: "old", name: "Old", archived: true }],
      })]),
      { nowIso: NOW }
    );
    expect(templateRows.find((r) => r.legacy_id === "live")!.deleted_at).toBeNull();
    const old = templateRows.find((r) => r.legacy_id === "old")!;
    expect(old.deleted_at).toBe(NOW);
    expect(old.deleted_by).toBeNull();
  });

  it("NEVER writes PG-owned fields (required_photo_count/requires_note/is_active/description)", () => {
    const { templateRows } = buildStructureRows(
      sources([], [jobWith("j1", [], { roughInTasks: [{ id: "t1", name: "T", requiredPhotoCount: 3, requiresNote: true }] })]),
      { nowIso: NOW }
    );
    const keys = Object.keys(templateRows[0]!);
    for (const pgOwned of ["required_photo_count", "requires_note", "is_active", "description"]) {
      expect(keys).not.toContain(pgOwned);
    }
  });

  it("quarantines a template missing id/name", () => {
    const { quarantine } = buildStructureRows(
      sources([], [jobWith("j1", [], { roughInTasks: [{ name: "no id" }, { id: "no_name" }] })]),
      { nowIso: NOW }
    );
    expect(quarantine.filter((q) => q.table === "job_task_templates")).toHaveLength(2);
  });

  it("keeps the template insert + mutable column lists in lock-step (PG-owned fields excluded)", () => {
    expect(new Set(TEMPLATE_INSERT_COLS)).toEqual(
      new Set(["tenant_id", "job_id", "site_area_id", "stage", "legacy_id", "name", "sort_order", "deleted_at", "deleted_by", "created_at"])
    );
    // mutable = only blob-sourced fields; deleted_at via CASE; PG-owned never present
    expect(TEMPLATE_MUTABLE_COLS).toEqual(["name", "sort_order"]);
    expect(TEMPLATE_MUTABLE_COLS).not.toContain("deleted_at");
    for (const pgOwned of ["required_photo_count", "requires_note", "is_active", "description"]) {
      expect(TEMPLATE_INSERT_COLS).not.toContain(pgOwned);
      expect(TEMPLATE_MUTABLE_COLS).not.toContain(pgOwned);
    }
  });
});
