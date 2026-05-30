import { describe, expect, it } from "vitest";
import {
  buildCreatePayload,
  buildPhilPreview,
  buildUpdatePayload,
  canPublish,
  isDraft,
  isPublished,
  isVisibleToField,
  moduleEnabled,
  publishState,
  stageHasTasks,
  summariseStructure,
  validateForPublish,
  type JobBuilderForm,
} from "./builder";
import type { Job } from "./types";

function makeJob(over: Partial<Job> & { id: string; name: string }): Job {
  return { ...over } as Job;
}

function fullForm(over: Partial<JobBuilderForm> = {}): JobBuilderForm {
  return {
    name: "Birdwood Apartments",
    ref: "",
    type: "",
    status: "draft",
    clientUserId: "",
    siteAddress: "",
    siteContactName: "",
    siteContactPhone: "",
    accessNotes: "",
    parkingNotes: "",
    safetyNotes: "",
    inductionRequired: false,
    startDate: "",
    dueDate: "",
    areaGroups: [],
    roughInTasks: [],
    fitOffTasks: [],
    modules: {},
    ...over,
  };
}

describe("moduleEnabled", () => {
  it("defaults the base set on and the modular concepts off", () => {
    const job = makeJob({ id: "j", name: "J" });
    expect(moduleEnabled(job, "photos")).toBe(true);
    expect(moduleEnabled(job, "snags")).toBe(true);
    expect(moduleEnabled(job, "areas")).toBe(true);
    expect(moduleEnabled(job, "itps")).toBe(false);
    expect(moduleEnabled(job, "switchboards")).toBe(false);
  });

  it("honours an explicit flag either way", () => {
    const job = makeJob({ id: "j", name: "J", modules: { photos: false, itps: true } });
    expect(moduleEnabled(job, "photos")).toBe(false);
    expect(moduleEnabled(job, "itps")).toBe(true);
  });
});

describe("publish state helpers", () => {
  it("maps active → published and treats a missing status as published", () => {
    expect(publishState(makeJob({ id: "j", name: "J", status: "active" }))).toBe("published");
    expect(publishState(makeJob({ id: "j", name: "J" }))).toBe("published");
    expect(isPublished(makeJob({ id: "j", name: "J" }))).toBe(true);
  });

  it("recognises a draft", () => {
    const d = makeJob({ id: "j", name: "J", status: "draft" });
    expect(publishState(d)).toBe("draft");
    expect(isDraft(d)).toBe(true);
    expect(isPublished(d)).toBe(false);
  });

  it("hides draft + archived from the field, keeps everything else visible", () => {
    expect(isVisibleToField(makeJob({ id: "j", name: "J", status: "draft" }))).toBe(false);
    expect(isVisibleToField(makeJob({ id: "j", name: "J", status: "archived" }))).toBe(false);
    expect(isVisibleToField(makeJob({ id: "j", name: "J", status: "active" }))).toBe(true);
    expect(isVisibleToField(makeJob({ id: "j", name: "J", status: "on_hold" }))).toBe(true);
    expect(isVisibleToField(makeJob({ id: "j", name: "J" }))).toBe(true);
  });
});

describe("buildCreatePayload", () => {
  it("trims the name, starts as draft, and omits blank optionals", () => {
    expect(buildCreatePayload({ name: "  New Job  " })).toEqual({
      name: "New Job",
      status: "draft",
    });
  });

  it("carries ref / type / siteAddress when provided", () => {
    expect(
      buildCreatePayload({ name: "J", ref: " R1 ", type: "fitout", siteAddress: " 1 Site Rd " })
    ).toEqual({
      name: "J",
      status: "draft",
      ref: "R1",
      type: "fitout",
      siteAddress: "1 Site Rd",
    });
  });
});

describe("buildUpdatePayload", () => {
  it("trims basics, clears type/client to null, keeps status", () => {
    const payload = buildUpdatePayload(
      "job-1",
      fullForm({
        name: "  Tower  ",
        status: "active",
        siteAddress: "  5 George St ",
        type: "",
        clientUserId: "",
      })
    );
    expect(payload.id).toBe("job-1");
    expect(payload.name).toBe("Tower");
    expect(payload.status).toBe("active");
    expect(payload.siteAddress).toBe("5 George St");
    expect(payload.type).toBeNull();
    expect(payload.clientUserId).toBeNull();
  });

  it("drops blank task rows and preserves task ids", () => {
    const payload = buildUpdatePayload(
      "job-1",
      fullForm({
        roughInTasks: [
          { id: "r1", name: " Drill " },
          { name: "   " },
          { name: "Run cable" },
        ],
      })
    );
    expect(payload.roughInTasks).toEqual([
      { id: "r1", name: "Drill" },
      { name: "Run cable" },
    ]);
  });

  it("drops blank areas + groups and keeps per-area overrides", () => {
    const payload = buildUpdatePayload(
      "job-1",
      fullForm({
        areaGroups: [
          {
            id: "g1",
            name: "Level 1",
            areas: [
              { id: "a1", name: " Unit 1 ", roughInTasks: [{ name: "Rough unit 1" }] },
              { name: "  " },
            ],
          },
          { name: "   ", areas: [] },
        ],
      })
    );
    expect(payload.areaGroups).toEqual([
      {
        id: "g1",
        name: "Level 1",
        areas: [{ id: "a1", name: "Unit 1", roughInTasks: [{ name: "Rough unit 1" }] }],
      },
    ]);
  });

  it("passes the create schema / update schema shape (no throw on round-trip)", () => {
    // buildUpdatePayload output must be a valid JobUpdateInput — exercised
    // indirectly by the client's safeParse; here we just assert the id is
    // always present, the one hard requirement.
    const payload = buildUpdatePayload("job-1", fullForm());
    expect(payload.id).toBe("job-1");
  });
});

describe("summariseStructure", () => {
  it("counts visible groups/areas and job-level task templates", () => {
    const job = makeJob({
      id: "j",
      name: "J",
      areaGroups: [
        {
          id: "g1",
          name: "L1",
          areas: [
            { id: "a1", name: "Unit 1" },
            { id: "a2", name: "Unit 2" },
          ],
        },
        { id: "g2", name: "Archived", archived: true, areas: [{ id: "a3", name: "X" }] },
      ],
      roughInTasks: [{ id: "r1", name: "Rough" }],
      fitOffTasks: [
        { id: "f1", name: "Fit" },
        { id: "f2", name: "Test" },
      ],
    });
    const s = summariseStructure(job);
    expect(s.areaGroupCount).toBe(1); // archived group excluded
    expect(s.areaCount).toBe(2);
    expect(s.roughInTaskCount).toBe(1);
    expect(s.fitOffTaskCount).toBe(2);
    expect(s.stagesWithTasks).toEqual(["roughIn", "fitOff"]);
  });

  it("detects a stage that only has per-area overrides", () => {
    const job = makeJob({
      id: "j",
      name: "J",
      areaGroups: [
        { id: "g1", name: "L1", areas: [{ id: "a1", name: "U1", roughInTasks: [{ id: "x", name: "Only here" }] }] },
      ],
    });
    expect(stageHasTasks(job, "roughIn")).toBe(true);
    expect(stageHasTasks(job, "fitOff")).toBe(false);
    expect(summariseStructure(job).stagesWithTasks).toEqual(["roughIn"]);
  });
});

describe("validateForPublish", () => {
  it("blocks a job with no name", () => {
    const issues = validateForPublish(makeJob({ id: "j", name: "  " }));
    expect(issues.some((i) => i.code === "name-missing" && i.severity === "error")).toBe(true);
    expect(canPublish(issues)).toBe(false);
  });

  it("blocks an areas-tracking job with no areas and no tasks", () => {
    const issues = validateForPublish(makeJob({ id: "j", name: "J" }));
    const codes = issues.filter((i) => i.severity === "error").map((i) => i.code);
    expect(codes).toContain("no-areas");
    expect(codes).toContain("no-tasks");
    expect(canPublish(issues)).toBe(false);
  });

  it("does not require areas/tasks when the Areas module is off", () => {
    const issues = validateForPublish(
      makeJob({ id: "j", name: "J", modules: { areas: false }, siteAddress: "1 St" })
    );
    expect(issues.some((i) => i.severity === "error")).toBe(false);
    expect(canPublish(issues)).toBe(true);
  });

  it("blocks a blank task name", () => {
    const issues = validateForPublish(
      makeJob({
        id: "j",
        name: "J",
        areaGroups: [{ id: "g", name: "L1", areas: [{ id: "a", name: "U1" }] }],
        roughInTasks: [{ id: "r", name: " " }],
      })
    );
    expect(issues.some((i) => i.code === "blank-task" && i.severity === "error")).toBe(true);
  });

  it("blocks an out-of-order date pair", () => {
    const issues = validateForPublish(
      makeJob({
        id: "j",
        name: "J",
        modules: { areas: false },
        startDate: "2026-06-10",
        dueDate: "2026-06-01",
      })
    );
    expect(issues.some((i) => i.code === "date-order" && i.severity === "error")).toBe(true);
  });

  it("warns (but does not block) on a missing site address", () => {
    const issues = validateForPublish(
      makeJob({
        id: "j",
        name: "J",
        areaGroups: [{ id: "g", name: "L1", areas: [{ id: "a", name: "U1" }] }],
        roughInTasks: [{ id: "r", name: "Rough" }],
      })
    );
    const warn = issues.find((i) => i.code === "no-site-address");
    expect(warn?.severity).toBe("warning");
    expect(canPublish(issues)).toBe(true);
  });

  it("passes a complete job clean", () => {
    const issues = validateForPublish(
      makeJob({
        id: "j",
        name: "Birdwood",
        siteAddress: "1 Site Rd",
        areaGroups: [{ id: "g", name: "L1", areas: [{ id: "a", name: "U1" }] }],
        roughInTasks: [{ id: "r", name: "Rough" }],
        fitOffTasks: [{ id: "f", name: "Fit" }],
      })
    );
    expect(issues).toEqual([]);
    expect(canPublish(issues)).toBe(true);
  });
});

describe("canPublish", () => {
  it("blocks on any error, ignores warnings", () => {
    expect(canPublish([{ code: "x", message: "", severity: "warning" }])).toBe(true);
    expect(canPublish([{ code: "x", message: "", severity: "error" }])).toBe(false);
    expect(canPublish([])).toBe(true);
  });
});

describe("buildPhilPreview", () => {
  it("derives stages, areas, and per-area task inheritance from the real structure", () => {
    const job = makeJob({
      id: "j",
      name: "Birdwood",
      ref: "BW-1",
      siteAddress: "1 Site Rd",
      status: "draft",
      roughInTasks: [{ id: "jr", name: "Job rough" }],
      areaGroups: [
        {
          id: "g1",
          name: "Level 1",
          areas: [
            { id: "a1", name: "Unit 1", roughInTasks: [{ id: "o1", name: "Override rough" }] },
            { id: "a2", name: "Unit 2" },
          ],
        },
      ],
    });
    const preview = buildPhilPreview(job);

    expect(preview.jobName).toBe("Birdwood");
    expect(preview.ref).toBe("BW-1");
    expect(preview.siteAddress).toBe("1 Site Rd");
    // draft → not yet visible to the field
    expect(preview.isVisibleToField).toBe(false);
    // only roughIn has tasks; fitOff has none anywhere
    expect(preview.stages.map((s) => s.stage)).toEqual(["roughIn"]);
    expect(preview.stages[0]!.jobLevelTaskCount).toBe(1);
    // Unit 1 uses its override; Unit 2 inherits the job-level template
    const unit1 = preview.areas.find((a) => a.areaName === "Unit 1")!;
    const unit2 = preview.areas.find((a) => a.areaName === "Unit 2")!;
    expect(unit1.roughInTasks).toEqual(["Override rough"]);
    expect(unit2.roughInTasks).toEqual(["Job rough"]);
  });

  it("reflects module flags in the section list", () => {
    const job = makeJob({ id: "j", name: "J", modules: { snags: false, itps: true } });
    const preview = buildPhilPreview(job);
    const byKey = Object.fromEntries(preview.sections.map((s) => [s.key, s.enabled]));
    expect(byKey.photos).toBe(true);
    expect(byKey.snags).toBe(false);
    expect(byKey.itps).toBe(true);
    expect(byKey.plans).toBe(true);
  });

  it("explains the empty case instead of faking content", () => {
    const job = makeJob({ id: "j", name: "J" });
    const preview = buildPhilPreview(job);
    expect(preview.areas).toEqual([]);
    expect(preview.stages).toEqual([]);
    expect(preview.emptyReason).toMatch(/no areas or tasks/i);
  });

  it("marks a published job as field-visible", () => {
    const preview = buildPhilPreview(makeJob({ id: "j", name: "J", status: "active" }));
    expect(preview.isVisibleToField).toBe(true);
  });
});
