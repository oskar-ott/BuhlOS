import { describe, expect, it } from "vitest";
import {
  philJobCommandInputFromJobData,
  philJobCommandLoadFailureInput,
} from "./job-command-input";
import { buildPhilJobCommandModel } from "./job-command-model";
import type { Job } from "@/domains/jobs/types";
import type { SnagItem } from "@/domains/snags/types";
import type { ITPInstance } from "@/domains/itp/types";
import type { Document } from "@/domains/documents/types";

const job = (over: Partial<Job> = {}): Job =>
  ({ id: "job-1", name: "Birdwood IV3232", ...over }) as unknown as Job;
const snag = (status: string): SnagItem => ({ status }) as unknown as SnagItem;
const itp = (status: string, archived = false): ITPInstance =>
  ({ status, archived }) as unknown as ITPInstance;
const doc = (status?: string): Document => ({ status }) as unknown as Document;

describe("philJobCommandInputFromJobData — module gating", () => {
  it("uses server module defaults: photos/snags/plans on, itps off", () => {
    const inp = philJobCommandInputFromJobData({ job: job() });
    expect(inp.capture.kind).toBe("available");
    expect(inp.snags.kind).toBe("count");
    expect(inp.plans.kind).toBe("count");
    expect(inp.itps.kind).toBe("not_configured"); // ITP module defaults OFF
  });

  it("honours an explicit module-off flag (photos)", () => {
    const inp = philJobCommandInputFromJobData({ job: job({ modules: { photos: false } }) });
    expect(inp.capture.kind).toBe("unavailable");
  });

  it("counts outstanding ITP checks only when the ITP module is on", () => {
    const inp = philJobCommandInputFromJobData({
      job: job({ modules: { itps: true } }),
      itps: [itp("pending"), itp("in-progress"), itp("witnessed"), itp("signed-off"), itp("pending", true)],
    });
    // pending + in-progress = 2; witnessed/signed-off/archived excluded
    expect(inp.itps).toEqual({ kind: "count", value: 2 });
  });
});

describe("philJobCommandInputFromJobData — honest counts", () => {
  it("counts only active (open) snags", () => {
    const inp = philJobCommandInputFromJobData({
      job: job(),
      snags: [snag("open"), snag("in_progress"), snag("resolved"), snag("verified"), snag("closed"), snag("rejected")],
    });
    expect(inp.snags).toEqual({ kind: "count", value: 3 }); // open + in_progress + resolved
  });

  it("counts only current documents (missing status defaults to current)", () => {
    const inp = philJobCommandInputFromJobData({
      job: job(),
      documents: [doc("current"), doc(undefined), doc("superseded"), doc("archived")],
    });
    expect(inp.plans).toEqual({ kind: "count", value: 2 });
  });

  it("treats a genuinely empty list as a real zero, not unknown", () => {
    const inp = philJobCommandInputFromJobData({ job: job(), snags: [] });
    expect(inp.snags).toEqual({ kind: "count", value: 0 });
  });

  it("derives visible task count from the same preview the live surface uses", () => {
    const inp = philJobCommandInputFromJobData({
      job: job({ roughInTasks: [{ id: "t1", name: "Rough in power" }], fitOffTasks: [] }),
    });
    expect(inp.tasks).toEqual({ kind: "list_only", visible: 1 });
  });

  it("uses real task state when supplied, and does not invent completion when absent", () => {
    const jobWithAreas = job({
      areaGroups: [
        {
          id: "g1",
          name: "Ground",
          areas: [{ id: "area-1", name: "Kitchen" }],
        },
      ],
      roughInTasks: [
        { id: "t1", name: "Cable run" },
        { id: "t2", name: "Back boxes" },
      ],
    });

    const withoutState = philJobCommandInputFromJobData({ job: jobWithAreas });
    expect(withoutState.tasks).toEqual({ kind: "list_only", visible: 2 });

    const withState = philJobCommandInputFromJobData({
      job: jobWithAreas,
      taskState: {
        "area-1": { roughIn: { t1: "complete" }, fitOff: {} },
      },
    });
    expect(withState.tasks).toEqual({ kind: "tracked", visible: 2, incomplete: 1 });
  });
});

describe("philJobCommandInputFromJobData — failed loads become unknown, not false zero", () => {
  it("marks a list as unknown when its fetch failed", () => {
    const inp = philJobCommandInputFromJobData({
      job: job({ modules: { itps: true } }),
      loadErrors: { snags: true, documents: true, itps: true },
    });
    expect(inp.snags.kind).toBe("unknown");
    expect(inp.plans.kind).toBe("unknown");
    expect(inp.itps.kind).toBe("unknown");
  });
});

describe("philJobCommandInputFromJobData — rejected hours upgrade hook", () => {
  it("is unknown on the job screen by default (hours aren't fetched here)", () => {
    const inp = philJobCommandInputFromJobData({ job: job() });
    expect(inp.rejectedHours.kind).toBe("unknown");
  });

  it("becomes a real count when the caller supplies per-job rejected hours", () => {
    const inp = philJobCommandInputFromJobData({ job: job(), rejectedHoursForJob: 2 });
    expect(inp.rejectedHours).toEqual({ kind: "count", value: 2 });
    // ...and the decision layer lights up fix_rejected_hours with no model change
    const model = buildPhilJobCommandModel(inp);
    expect([model.primaryAction, ...model.actions].some((a) => a?.id === "fix_rejected_hours")).toBe(true);
  });
});

describe("philJobCommandInputFromJobData — standing capabilities", () => {
  it("logs hours via the Day tab and keeps materials a limitation, not an action", () => {
    const inp = philJobCommandInputFromJobData({ job: job() });
    expect(inp.hours).toEqual({ kind: "elsewhere", href: "/phil/my-day" });
    expect(inp.materials.kind).toBe("unavailable");
  });
});

describe("bridge + model end to end", () => {
  it("produces a ready model for a normal assigned job", () => {
    const model = buildPhilJobCommandModel(
      philJobCommandInputFromJobData({
        job: job({ roughInTasks: [{ id: "t1", name: "Rough in" }] }),
        snags: [snag("open")],
        documents: [doc("current"), doc("current")],
      }),
    );
    expect(model.state).toBe("ready");
    expect(model.jobName).toBe("Birdwood IV3232");
    const ids = [model.primaryAction, ...model.actions].map((a) => a?.id);
    expect(ids).toEqual(expect.arrayContaining(["capture", "view_plans", "report_issue", "continue_tasks", "log_hours"]));
    // open snags surface as awareness, rejected hours as an honest limitation
    expect(model.attention.some((a) => a.id === "open-snags")).toBe(true);
    expect(model.limitations.some((l) => l.id === "rejected-hours-unknown")).toBe(true);
  });

  it("globally hidden snags/ITPs derive not_configured — no report_issue, no dead anchor (#915)", () => {
    const model = buildPhilJobCommandModel(
      philJobCommandInputFromJobData({
        job: job({ roughInTasks: [{ id: "t1", name: "Rough in" }] }),
        features: { snags: false, itps: false },
        snags: [],
        itps: [],
        documents: [doc("current")],
      }),
    );
    const ids = [model.primaryAction, ...model.actions].map((a) => a?.id);
    expect(ids).not.toContain("report_issue");
    expect(ids).not.toContain("complete_checks");
    expect(model.attention.some((a) => a.id === "open-snags")).toBe(false);
    // The kept core still works: capture / plans / tasks / hours are untouched.
    expect(ids).toEqual(expect.arrayContaining(["capture", "view_plans", "continue_tasks", "log_hours"]));
  });

  it("routes a draft job to office-only through the bridge", () => {
    const model = buildPhilJobCommandModel(
      philJobCommandInputFromJobData({ job: job({ status: "draft" }) }),
    );
    expect(model.state).toBe("office_only");
  });

  it("routes a load failure to the error state with job context preserved", () => {
    const model = buildPhilJobCommandModel(
      philJobCommandLoadFailureInput({ kind: "error", jobId: "job-7", message: "API returned 503" }),
    );
    expect(model.state).toBe("error");
    expect(model.jobId).toBe("job-7");
  });
});
