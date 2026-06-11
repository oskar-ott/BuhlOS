import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Structure dry-run importer scaffold: pure planner counts, quarantine
 * buckets (missing refs / duplicates / invalid records), the
 * empty-override-means-default rule mirrored from api/_lib/job-tasks.js,
 * write-mode blocking through the Supabase env guard, and source-level
 * proof that the importer modules cannot write (no write imports at all).
 */

const requireFromHere = createRequire(import.meta.url);

const planPath = requireFromHere.resolve("../../../scripts/importers/lib/structure-plan.js");
const runModePath = requireFromHere.resolve("../../../scripts/importers/lib/run-mode.js");
const cliPath = requireFromHere.resolve("../../../scripts/importers/structure-dry-run.js");
const guardPath = requireFromHere.resolve("../../../api/_lib/supabase-env.js");

type TableCounts = { inserts: number; updates: number };

type Plan = {
  tables: {
    tenants: TableCounts;
    user_profiles: TableCounts;
    jobs: TableCounts;
    job_members: TableCounts;
    site_area_groups: TableCounts;
    site_areas: TableCounts;
    job_task_templates: TableCounts;
    tasks: TableCounts;
  };
  hardErrors: string[];
  warnings: string[];
  missingRefs: Array<{ kind: string; from: string; ref: string }>;
  duplicateLegacyIds: Array<{ table: string; legacyId: string }>;
  invalidRecords: Array<{ kind: string; id: string; reason: string }>;
  summary: {
    sources: { users: number; jobs: number; jobDataBlobs: number };
    members: { total: number; leads: number };
    archived: { groups: number; areas: number; templateEntries: number };
    taskStates: { complete: number; in_progress: number; unknown: number };
    clean: boolean;
  };
};

const { buildStructureImportPlan } = requireFromHere(planPath) as {
  buildStructureImportPlan: (sources: unknown) => Plan;
};
const { resolveRunMode } = requireFromHere(runModePath) as {
  resolveRunMode: (
    argv: string[],
    env: Record<string, string | undefined>,
    guard: unknown
  ) => { mode: string };
};
const guard = requireFromHere(guardPath) as {
  PRODUCTION_PROJECT_REF: string;
  SupabaseEnvError: new (...args: never[]) => Error & { code: string };
};

function task(id: string, name: string, extra: Record<string, unknown> = {}) {
  return { id, name, ...extra };
}

function fixtureSources() {
  const users = {
    users: [
      { id: "u-admin", username: "boss", role: "admin", assignedJobIds: [] },
      { id: "u-lh", username: "lh", role: "leadinghand", assignedJobIds: ["job-a"] },
      { id: "u-tradie", username: "sparky", role: "tradie", assignedJobIds: ["job-a", "job-gone"] },
    ],
  };
  const jobs = {
    jobs: [
      {
        id: "job-a",
        name: "Unit 4 Bondi",
        status: "active",
        roughInTasks: [task("t-r1", "Rough in power"), task("t-r2", "Rough in lights")],
        fitOffTasks: [task("t-f1", "Fit off power")],
        areaGroups: [
          {
            id: "ag-1",
            name: "Level 1",
            areas: [
              // empty override array = use job defaults (job-tasks.js rule)
              { id: "ar-1", name: "Bed 1", roughInTasks: [] },
              // non-empty override wins for roughIn; fitOff falls back
              { id: "ar-2", name: "Switch room", roughInTasks: [task("t-o1", "Mains")] },
              { id: "ar-3", name: "Old store", archived: true },
            ],
          },
        ],
      },
      { id: "job-b", name: "Draft job", status: "draft", areaGroups: [] },
    ],
  };
  const jobData = {
    "job-a": {
      dwellings: {
        "ar-1": { roughIn: { tasks: { "t-r1": "complete", "t-r2": "in_progress" } } },
        "ar-2": { roughIn: { tasks: { "t-o1": "complete", "t-r1": "complete" } } },
        "ar-gone": { roughIn: { tasks: { "t-r1": "complete" } } },
      },
    },
    "job-b": null,
  };
  return { users, jobs, jobData };
}

describe("structure dry-run planner — counts", () => {
  const plan = buildStructureImportPlan(fixtureSources());

  it("proposes the structure slice tables with correct insert counts", () => {
    expect(plan.tables.tenants.inserts).toBe(1);
    expect(plan.tables.user_profiles.inserts).toBe(3);
    expect(plan.tables.jobs.inserts).toBe(2);
    // u-lh→job-a, u-tradie→job-a (job-gone quarantined)
    expect(plan.tables.job_members.inserts).toBe(2);
    expect(plan.tables.site_area_groups.inserts).toBe(1);
    expect(plan.tables.site_areas.inserts).toBe(3); // incl. archived ar-3
    // job-level: 2 roughIn + 1 fitOff; area override: 1 → 4
    expect(plan.tables.job_task_templates.inserts).toBe(4);
    // live areas only: ar-1 (defaults 2+1) + ar-2 (override 1 + fitOff default 1) = 5
    expect(plan.tables.tasks.inserts).toBe(5);
  });

  it("applies the empty-override-means-default rule and counts states", () => {
    expect(plan.summary.taskStates.complete).toBe(2); // t-r1@ar-1, t-o1@ar-2
    expect(plan.summary.taskStates.in_progress).toBe(1);
    expect(plan.summary.archived.areas).toBe(1);
  });

  it("counts members and leads", () => {
    expect(plan.summary.members.total).toBe(2);
    expect(plan.summary.members.leads).toBe(1);
  });

  it("quarantines missing references without failing the run", () => {
    const kinds = plan.missingRefs.map((r) => r.kind).sort();
    // job-gone (member), ar-gone (state→area), t-r1 not effective in ar-2
    // because its non-empty override replaced the defaults (state→template)
    expect(kinds).toEqual(["job_member→job", "task_state→area", "task_state→template"]);
    expect(plan.summary.clean).toBe(true);
  });

  it("proposes zero updates against the known-empty target", () => {
    for (const counts of Object.values(plan.tables)) {
      expect(counts.updates).toBe(0);
    }
  });
});

describe("structure dry-run planner — fail closed", () => {
  it("hard-fails on missing sources", () => {
    const plan = buildStructureImportPlan({ users: null, jobs: null, jobData: {} });
    expect(plan.hardErrors.length).toBe(2);
    expect(plan.summary.clean).toBe(false);
  });

  it("detects duplicate legacy ids", () => {
    const sources = fixtureSources();
    sources.jobs.jobs.push({ id: "job-a", name: "Dup", status: "draft", areaGroups: [] });
    const plan = buildStructureImportPlan(sources);
    expect(plan.duplicateLegacyIds).toContainEqual({ table: "jobs", legacyId: "job-a" });
    expect(plan.summary.clean).toBe(false);
  });

  it("detects duplicate area legacy ids across jobs (tenant-wide unique)", () => {
    const sources = fixtureSources();
    sources.jobs.jobs.push({
      id: "job-x",
      name: "Clashing job",
      status: "draft",
      areaGroups: [{ id: "ag-2", name: "G", areas: [{ id: "ar-1", name: "Clash" }] }],
    } as never);
    const plan = buildStructureImportPlan(sources);
    expect(plan.duplicateLegacyIds).toContainEqual({ table: "site_areas", legacyId: "ar-1" });
  });

  it("quarantines users whose role fails the schema CHECK instead of guessing", () => {
    const sources = fixtureSources();
    sources.users.users.push({
      id: "u-lh2",
      username: "lh2",
      role: "leading hand",
      assignedJobIds: [],
    });
    const plan = buildStructureImportPlan(sources);
    expect(plan.invalidRecords.some((r) => r.id === "u-lh2" && /normalisation/.test(r.reason))).toBe(
      true
    );
    expect(plan.summary.clean).toBe(false);
  });

  it("quarantines jobs whose status fails the schema CHECK", () => {
    const sources = fixtureSources();
    sources.jobs.jobs.push({ id: "job-c", name: "Odd", status: "live", areaGroups: [] });
    const plan = buildStructureImportPlan(sources);
    expect(plan.invalidRecords.some((r) => r.id === "job-c")).toBe(true);
    expect(plan.summary.clean).toBe(false);
  });

  it("flags malformed records as invalid", () => {
    const sources = fixtureSources();
    sources.users.users.push({ id: "", username: "ghost", role: "tradie" } as never);
    const plan = buildStructureImportPlan(sources);
    expect(plan.invalidRecords.some((r) => r.kind === "user")).toBe(true);
  });

  it("warns on unknown task states without failing the run", () => {
    const sources = fixtureSources();
    sources.jobData["job-a"].dwellings["ar-1"].roughIn.tasks["t-r2"] = "donezo";
    const plan = buildStructureImportPlan(sources);
    expect(plan.summary.taskStates.unknown).toBe(1);
    expect(plan.warnings.some((w) => w.includes("donezo"))).toBe(true);
    expect(plan.summary.clean).toBe(true);
  });
});

describe("run mode — write is blocked", () => {
  const DEV_REF = "devprojectref0123456";
  const devEnv = {
    SUPABASE_ENV: "preview",
    SUPABASE_PROJECT_REF: DEV_REF,
    SUPABASE_DB_URL: `postgresql://postgres.${DEV_REF}:pw@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres`,
  };

  it("defaults to dry-run", () => {
    expect(resolveRunMode([], {}, guard)).toEqual({ mode: "dry-run" });
    expect(resolveRunMode(["--json"], {}, guard)).toEqual({ mode: "dry-run" });
  });

  it("refuses --write when the env guard blocks (production ref in preview)", () => {
    const env = {
      SUPABASE_ENV: "preview",
      SUPABASE_PROJECT_REF: guard.PRODUCTION_PROJECT_REF,
      SUPABASE_DB_URL: `postgresql://postgres.${guard.PRODUCTION_PROJECT_REF}:pw@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres`,
    };
    expect(() => resolveRunMode(["--write"], env, guard)).toThrowError(
      /PROD_REF_IN_NON_PROD_ENV/
    );
  });

  it("refuses --write even when the guard permits — not implemented", () => {
    expect(() => resolveRunMode(["--write"], devEnv, guard)).toThrowError(
      /WRITE_NOT_IMPLEMENTED/
    );
  });

  it("refuses --write with missing env (fail closed)", () => {
    expect(() => resolveRunMode(["--write"], {}, guard)).toThrowError(/MISSING_ENV/);
  });
});

describe("importer modules cannot write — source-level proof", () => {
  it("planner and run-mode import no Blob/Supabase modules at all", () => {
    for (const p of [planPath, runModePath]) {
      const src = readFileSync(p, "utf8");
      expect(src).not.toMatch(/@vercel\/blob|_lib\/blob|writeBlob|deleteBlob|postgres|supabase-js/);
    }
  });

  it("the CLI imports only readBlob and never any write function", () => {
    const src = readFileSync(cliPath, "utf8");
    expect(src).toMatch(/const \{ readBlob \} = require\('\.\.\/\.\.\/api\/_lib\/blob'\)/);
    expect(src).not.toMatch(/writeBlob|deleteBlob|\bput\(|@vercel\/blob/);
  });
});
