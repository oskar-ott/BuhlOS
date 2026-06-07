import { describe, expect, it } from "vitest";
import {
  buildPhilJobCommandModel,
  rankPhilJobActions,
  type PhilJobCommandAction,
  type PhilJobCommandInput,
} from "./job-command-model";

/** A released job with every signal quiet. Override per test. `materials:
 *  available` and `hours: unavailable` keep the baseline noise-free so each
 *  test asserts only what it sets. */
function input(over: Partial<PhilJobCommandInput> = {}): PhilJobCommandInput {
  return {
    job: {
      kind: "ok",
      id: "job-1",
      name: "Birdwood IV3232",
      visibleToField: true,
      onHold: false,
      inductionRequired: false,
    },
    capture: { kind: "unavailable" },
    plans: { kind: "not_configured" },
    snags: { kind: "not_configured" },
    itps: { kind: "not_configured" },
    tasks: { kind: "not_configured" },
    rejectedHours: { kind: "not_configured" },
    hours: { kind: "unavailable" },
    materials: { kind: "available" },
    ...over,
  };
}

const actionIds = (m: { actions: PhilJobCommandAction[]; primaryAction: PhilJobCommandAction | null }) =>
  [m.primaryAction, ...m.actions].filter(Boolean).map((a) => a!.id);
const attentionIds = (m: { attention: { id: string }[] }) => m.attention.map((a) => a.id);
const limitationIds = (m: { limitations: { id: string }[] }) => m.limitations.map((l) => l.id);

describe("buildPhilJobCommandModel — identity & state", () => {
  it("preserves job context and surfaces a blocked notice on load error", () => {
    const m = buildPhilJobCommandModel(
      input({ job: { kind: "error", id: "job-9", message: "API returned 500" } }),
    );
    expect(m.state).toBe("error");
    expect(m.jobId).toBe("job-9");
    expect(m.primaryAction).toBeNull();
    expect(m.actions).toEqual([]);
    expect(m.attention[0]?.severity).toBe("blocked");
    expect(attentionIds(m)).toContain("job-load-error");
  });

  it("treats not-found / not-assigned as an error state, not a fake job", () => {
    const m = buildPhilJobCommandModel(input({ job: { kind: "not_found", id: "job-x" } }));
    expect(m.state).toBe("error");
    expect(m.jobId).toBe("job-x");
    expect(attentionIds(m)).toContain("job-not-found");
    expect(m.actions).toEqual([]);
  });

  it("marks a draft / archived job as office-only with nothing for the field", () => {
    const m = buildPhilJobCommandModel(
      input({ job: { kind: "ok", id: "j", name: "Draft job", visibleToField: false, onHold: false, inductionRequired: false } }),
    );
    expect(m.state).toBe("office_only");
    expect(m.primaryAction).toBeNull();
    expect(attentionIds(m)).toContain("office-only");
    expect(actionIds(m)).toEqual([]);
  });

  it("is empty (not ready) when a released job has no work and only ambient capabilities", () => {
    const m = buildPhilJobCommandModel(input({ hours: { kind: "elsewhere", href: "/phil/my-day" } }));
    expect(m.state).toBe("empty");
    expect(m.primaryAction).toBeNull();
    // ambient log-hours is still offered, it just doesn't make the job "ready"
    expect(actionIds(m)).toContain("log_hours");
  });

  it("flags an on-hold job as blocked and does not lead the worker into work", () => {
    const m = buildPhilJobCommandModel(
      input({
        job: { kind: "ok", id: "j", name: "Paused", visibleToField: true, onHold: true, inductionRequired: false },
        capture: { kind: "available" },
      }),
    );
    expect(m.state).toBe("blocked");
    expect(m.primaryAction).toBeNull();
    expect(m.attention[0]?.id).toBe("on-hold");
    expect(m.attention[0]?.severity).toBe("blocked");
  });
});

describe("buildPhilJobCommandModel — actions only from real data", () => {
  it("offers capture when capture is available", () => {
    const m = buildPhilJobCommandModel(input({ capture: { kind: "available" } }));
    expect(actionIds(m)).toContain("capture");
    expect(m.state).toBe("ready");
  });

  it("offers log_hours pointing at the Day tab when hours live elsewhere", () => {
    const m = buildPhilJobCommandModel(input({ hours: { kind: "elsewhere", href: "/phil/my-day" } }));
    const logHours = [m.primaryAction, ...m.actions].find((a) => a?.id === "log_hours");
    expect(logHours?.status).toBe("ready");
    expect(logHours?.href).toBe("/phil/my-day");
  });

  it("offers view_plans ONLY when there are documents", () => {
    expect(actionIds(buildPhilJobCommandModel(input({ plans: { kind: "count", value: 4 } })))).toContain("view_plans");
    expect(actionIds(buildPhilJobCommandModel(input({ plans: { kind: "count", value: 0 } })))).not.toContain("view_plans");
    expect(actionIds(buildPhilJobCommandModel(input({ plans: { kind: "not_configured" } })))).not.toContain("view_plans");
  });

  it("offers complete_checks ONLY when real ITP checks are outstanding", () => {
    const withChecks = buildPhilJobCommandModel(input({ itps: { kind: "count", value: 2 } }));
    expect(actionIds(withChecks)).toContain("complete_checks");
    expect(attentionIds(withChecks)).toContain("checks-outstanding");
    expect(actionIds(buildPhilJobCommandModel(input({ itps: { kind: "count", value: 0 } })))).not.toContain("complete_checks");
    expect(actionIds(buildPhilJobCommandModel(input({ itps: { kind: "not_configured" } })))).not.toContain("complete_checks");
  });

  it("offers continue_tasks ONLY when visible tasks exist", () => {
    expect(actionIds(buildPhilJobCommandModel(input({ tasks: { kind: "list_only", visible: 3 } })))).toContain("continue_tasks");
    expect(actionIds(buildPhilJobCommandModel(input({ tasks: { kind: "list_only", visible: 0 } })))).not.toContain("continue_tasks");
    expect(actionIds(buildPhilJobCommandModel(input({ tasks: { kind: "not_configured" } })))).not.toContain("continue_tasks");
  });

  it("lets the worker report an issue whenever snags are configured, regardless of count", () => {
    expect(actionIds(buildPhilJobCommandModel(input({ snags: { kind: "count", value: 0 } })))).toContain("report_issue");
    expect(actionIds(buildPhilJobCommandModel(input({ snags: { kind: "not_configured" } })))).not.toContain("report_issue");
  });
});

describe("buildPhilJobCommandModel — no fake state", () => {
  it("shows rejected-hours attention ONLY when there is real rejected-hours data", () => {
    const real = buildPhilJobCommandModel(input({ rejectedHours: { kind: "count", value: 2 } }));
    expect(actionIds(real)).toContain("fix_rejected_hours");
    expect(attentionIds(real)).toContain("rejected-hours");

    const zero = buildPhilJobCommandModel(input({ rejectedHours: { kind: "count", value: 0 } }));
    expect(actionIds(zero)).not.toContain("fix_rejected_hours");
    expect(attentionIds(zero)).not.toContain("rejected-hours");
  });

  it("turns unknown rejected hours into a limitation, never a faked action", () => {
    const m = buildPhilJobCommandModel(input({ rejectedHours: { kind: "unknown" } }));
    expect(actionIds(m)).not.toContain("fix_rejected_hours");
    expect(attentionIds(m)).not.toContain("rejected-hours");
    expect(limitationIds(m)).toContain("rejected-hours-unknown");
  });

  it("never invents a task completion count for list-only tasks", () => {
    const m = buildPhilJobCommandModel(input({ tasks: { kind: "list_only", visible: 5 } }));
    const task = [m.primaryAction, ...m.actions].find((a) => a?.id === "continue_tasks");
    expect(task?.label).toBe("View your tasks"); // no "N done", no "N left"
    expect(task?.label ?? "").not.toMatch(/\d/);
    expect(attentionIds(m)).not.toContain("tasks-remaining"); // no completion-derived attention
    expect(limitationIds(m)).toContain("tasks-read-only");
  });

  it("uses a real completion count only when tasks are genuinely tracked", () => {
    const m = buildPhilJobCommandModel(input({ tasks: { kind: "tracked", visible: 6, incomplete: 2 } }));
    const task = [m.primaryAction, ...m.actions].find((a) => a?.id === "continue_tasks");
    expect(task?.status).toBe("attention");
    expect(task?.label).toContain("2");
    expect(attentionIds(m)).toContain("tasks-remaining");
  });

  it("turns every unknown signal into an honest limitation", () => {
    const m = buildPhilJobCommandModel(
      input({
        capture: { kind: "unknown" },
        plans: { kind: "unknown" },
        snags: { kind: "unknown" },
        itps: { kind: "unknown" },
        tasks: { kind: "unknown" },
        materials: { kind: "unknown" },
      }),
    );
    expect(limitationIds(m)).toEqual(
      expect.arrayContaining([
        "capture-unknown",
        "plans-unknown",
        "snags-unknown",
        "checks-unknown",
        "tasks-unknown",
        "materials-unknown",
      ]),
    );
    // unknown snags still lets the worker raise a new one
    expect(actionIds(m)).toContain("report_issue");
  });
});

describe("buildPhilJobCommandModel — priority & primary action", () => {
  it("leads with the highest-priority actionable item (rejected hours over capture)", () => {
    const m = buildPhilJobCommandModel(
      input({ rejectedHours: { kind: "count", value: 1 }, capture: { kind: "available" } }),
    );
    expect(m.primaryAction?.id).toBe("fix_rejected_hours");
    expect(m.actions.map((a) => a.id)).not.toContain("fix_rejected_hours"); // not duplicated
  });

  it("ranks an attention action ahead of a plain ready action", () => {
    // capture is ready (rank 3), checks is attention (rank 1) → checks wins
    const m = buildPhilJobCommandModel(
      input({ capture: { kind: "available" }, itps: { kind: "count", value: 1 } }),
    );
    expect(m.primaryAction?.id).toBe("complete_checks");
  });

  it("orders attention items blocked → warning → info", () => {
    const m = buildPhilJobCommandModel(
      input({
        job: { kind: "ok", id: "j", name: "n", visibleToField: true, onHold: true, inductionRequired: true },
        snags: { kind: "count", value: 3 },
      }),
    );
    const severities = m.attention.map((a) => a.severity);
    expect(severities[0]).toBe("blocked");
    expect(severities).toEqual([...severities].sort(
      (a, b) => ({ blocked: 0, warning: 1, info: 2 }[a] - { blocked: 0, warning: 1, info: 2 }[b]),
    ));
  });
});

describe("rankPhilJobActions", () => {
  const mk = (id: PhilJobCommandAction["id"], status: PhilJobCommandAction["status"]): PhilJobCommandAction => ({
    id,
    label: id,
    status,
  });

  it("is stable and deterministic for the same input", () => {
    const actions = [
      mk("report_issue", "ready"),
      mk("capture", "ready"),
      mk("fix_rejected_hours", "attention"),
      mk("view_plans", "ready"),
      mk("complete_checks", "attention"),
    ];
    const a = rankPhilJobActions(actions).map((x) => x.id);
    const b = rankPhilJobActions(actions).map((x) => x.id);
    expect(a).toEqual(b);
    // attention first (by priority), then ready (by priority)
    expect(a).toEqual([
      "fix_rejected_hours",
      "complete_checks",
      "capture",
      "view_plans",
      "report_issue",
    ]);
  });

  it("orders disabled/not_configured after actionable ones without mutating the input", () => {
    const actions = [
      mk("view_plans", "not_configured"),
      mk("capture", "ready"),
      mk("complete_checks", "disabled"),
    ];
    const snapshot = actions.map((a) => `${a.id}:${a.status}`);
    const ranked = rankPhilJobActions(actions).map((a) => a.id);
    expect(ranked).toEqual(["capture", "complete_checks", "view_plans"]);
    expect(actions.map((a) => `${a.id}:${a.status}`)).toEqual(snapshot); // not mutated
  });
});

describe("buildPhilJobCommandModel — Phil voice (no admin / payroll / Xero language)", () => {
  it("never leaks office/payroll vocabulary into worker-facing copy", () => {
    // A kitchen-sink model that exercises every action, attention and limitation.
    const m = buildPhilJobCommandModel(
      input({
        job: { kind: "ok", id: "j", name: "n", visibleToField: true, onHold: false, inductionRequired: true },
        capture: { kind: "available" },
        plans: { kind: "count", value: 2 },
        snags: { kind: "count", value: 1 },
        itps: { kind: "count", value: 1 },
        tasks: { kind: "list_only", visible: 4 },
        rejectedHours: { kind: "count", value: 1 },
        hours: { kind: "elsewhere", href: "/phil/my-day" },
        materials: { kind: "unavailable", reason: "Call your PM to request materials." },
      }),
    );
    const text = [
      ...[m.primaryAction, ...m.actions].filter(Boolean).flatMap((a) => [a!.label, a!.reason ?? ""]),
      ...m.attention.flatMap((a) => [a.label, a.reason ?? ""]),
      ...m.limitations.flatMap((l) => [l.label, l.reason ?? ""]),
    ].join(" \n ");
    expect(text).not.toMatch(/payroll|xero|invoice|timesheet|approv|pay run|payrun|sign[- ]?off|witness|gross|net pay/i);
  });
});
