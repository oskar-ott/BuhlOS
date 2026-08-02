import { describe, expect, it } from "vitest";
import {
  philJobActionHref,
  philJobCommandInputFromListSignals,
} from "./job-command-list-input";
import {
  buildPhilJobCommandModel,
  rankPhilJobActions,
  type PhilJobActionId,
  type PhilJobCommandAction,
} from "./job-command-model";
import type { Job } from "@/domains/jobs/types";

/**
 * The jobs-LIST bridge (#146): build a real command input from only the thin
 * `?withStats=1` row fields, then prove the long-press sheet's actions come from
 * the ranked MODEL — not hardcoded literals — and that list-absent signals stay
 * honestly `unknown` so unsupported actions never render.
 */

const job = (over: Partial<Job> = {}): Job =>
  ({ id: "job-1", name: "Birdwood IV3232", status: "active", ...over }) as unknown as Job;

/** The top ≤3 ranked actions exactly as the list row computes them. */
function topActions(j: Job, max = 3): PhilJobCommandAction[] {
  const model = buildPhilJobCommandModel(philJobCommandInputFromListSignals(j));
  const ranked = model.primaryAction ? [model.primaryAction, ...model.actions] : model.actions;
  return ranked.slice(0, max);
}
const ids = (actions: PhilJobCommandAction[]): PhilJobActionId[] => actions.map((a) => a.id);

describe("philJobCommandInputFromListSignals — honest list signals", () => {
  it("uses the real list stat for snags (the same active set the chips show)", () => {
    const inp = philJobCommandInputFromListSignals(job({ statsSnagsV2Active: 3 }));
    expect(inp.snags).toEqual({ kind: "count", value: 3 });
  });

  it("treats a missing/invalid snag stat as a genuine 0 (the list summary is authoritative)", () => {
    const inp = philJobCommandInputFromListSignals(job());
    expect(inp.snags).toEqual({ kind: "count", value: 0 });
  });

  it("deleted registers (ITPs / tags) are permanently not_configured — never an action", () => {
    const inp = philJobCommandInputFromListSignals(job());
    expect(inp.itps).toEqual({ kind: "not_configured" });
    expect(inp.tags).toEqual({ kind: "not_configured" });
  });

  it("marks everything NOT on the list as unknown — never a fabricated 0 (P7)", () => {
    const inp = philJobCommandInputFromListSignals(job());
    expect(inp.plans.kind).toBe("unknown");
    expect(inp.tasks.kind).toBe("unknown");
    expect(inp.rejectedHours.kind).toBe("unknown");
    expect(inp.capture.kind).toBe("unknown");
    expect(inp.materials.kind).toBe("unknown");
  });

  it("hours stay a real cross-surface capability (the Day tab)", () => {
    const inp = philJobCommandInputFromListSignals(job());
    expect(inp.hours).toEqual({ kind: "elsewhere", href: "/phil/my-day" });
  });

  it("reflects on-hold status as a blocker the model can act on", () => {
    const inp = philJobCommandInputFromListSignals(job({ status: "on_hold" }));
    expect(inp.job.kind).toBe("ok");
    if (inp.job.kind === "ok") expect(inp.job.onHold).toBe(true);
  });
});

describe("topActions — built from the ranked model, not literals", () => {
  it("ranks report-issue (snags present) and log-hours, capped at 3", () => {
    const actions = topActions(job({ statsSnagsV2Active: 2 }));
    expect(actions.length).toBeLessThanOrEqual(3);
    // report_issue is offered whenever the snags signal is a real count.
    expect(ids(actions)).toContain("report_issue");
    expect(ids(actions)).toContain("log_hours");
    // Capture/plans/tasks are UNKNOWN on a list row → they must NOT appear as
    // actions (the builder files unknown capabilities as limitations).
    expect(ids(actions)).not.toContain("capture");
    expect(ids(actions)).not.toContain("view_plans");
    expect(ids(actions)).not.toContain("continue_tasks");
  });

  it("never offers complete_checks — the ITP register is deleted", () => {
    const actions = topActions(job({ statsSnagsV2Active: 1 }));
    expect(ids(actions)).not.toContain("complete_checks");
  });

  it("the action ordering matches rankPhilJobActions exactly (no bespoke sort)", () => {
    const model = buildPhilJobCommandModel(
      philJobCommandInputFromListSignals(job({ statsSnagsV2Active: 1 })),
    );
    const all = model.primaryAction ? [model.primaryAction, ...model.actions] : model.actions;
    expect(all).toEqual(rankPhilJobActions(all));
  });

  it("an on-hold job leads with no work action (blocked → don't push into work)", () => {
    const model = buildPhilJobCommandModel(
      philJobCommandInputFromListSignals(job({ status: "on_hold", statsSnagsV2Active: 3 })),
    );
    expect(model.state).toBe("blocked");
    expect(model.primaryAction).toBeNull();
  });
});

describe("philJobActionHref — maps a ranked action to its job-page href", () => {
  const a = (id: PhilJobActionId, href?: string): PhilJobCommandAction =>
    ({ id, label: id, status: "ready", ...(href ? { href } : {}) }) as PhilJobCommandAction;

  it("uses the action's own href for cross-surface actions (hours)", () => {
    expect(philJobActionHref("job-1", a("log_hours", "/phil/my-day"))).toBe("/phil/my-day");
  });

  it("deep-links an in-page action to the job page + section anchor", () => {
    expect(philJobActionHref("job-1", a("report_issue"))).toBe("/phil/jobs/job-1#phil-job-snags");
    expect(philJobActionHref("job-1", a("complete_checks"))).toBe("/phil/jobs/job-1#phil-job-itps");
    expect(philJobActionHref("job-1", a("capture"))).toBe("/phil/jobs/job-1#phil-job-capture");
  });

  it("encodes the job id in the path", () => {
    expect(philJobActionHref("a/b", a("report_issue"))).toBe("/phil/jobs/a%2Fb#phil-job-snags");
  });

  it("falls back to the job page itself when there is no anchor (never a dead link)", () => {
    // An action id with no in-page anchor + no href → the job home.
    expect(philJobActionHref("job-1", a("log_hours"))).toBe("/phil/jobs/job-1");
  });
});
