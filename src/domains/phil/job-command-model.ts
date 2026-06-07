/**
 * Phil Job Command Model — the field worker's decision layer.
 *
 * One question, answered from data: *"What does the field worker need to know
 * or do on THIS job, right now?"* The UI is meant to be generated from this
 * model, not from hardcoded assumptions about whichever features happen to
 * exist this week.
 *
 * Why this exists
 * ---------------
 * Phil can accrete feature-specific UI blocks — an action hub here,
 * a rejected-hours card there, a task panel, an evidence chip. Every time the
 * job model changed, those blocks went stale and the field UI had to be
 * re-stitched. This module replaces that pattern with a single, stable
 * decision layer: a pure function from a well-defined input contract
 * (`PhilJobCommandInput`) to a ranked, honest command model
 * (`PhilJobCommandModel`).
 *
 * Two hard design rules make it durable:
 *
 *   1. **It is pure.** No fetch, no React, no schema imports. It can be fully
 *      unit-tested without rendering anything or standing up a server. The
 *      schema-coupled bridge that turns the Phil job page's real data into a
 *      `PhilJobCommandInput` lives separately in `job-command-input.ts`, so a
 *      change to the job/evidence/snag/ITP shapes only touches the bridge —
 *      the decision layer below does not move.
 *
 *   2. **It never fakes confidence.** Every signal can be a real count, a
 *      genuine zero, *not-yet-knowable*, or *off for this job*. Unknown inputs
 *      become honest `limitations`, never invented actions or counts. This
 *      mirrors the discipline already in `deriveJobAttention`
 *      (src/domains/jobs/attention.ts): "no fabricated numbers; all-clear only
 *      when the real counts are genuinely zero."
 *
 * What this is NOT
 * ----------------
 * Not a dashboard, not a feature inventory, not a new workflow. It only
 * *organises existing real capabilities* into "what's next" for the worker.
 * The brief's suggested `sections` field is intentionally folded into
 * `actions[].status` + `limitations`: a separate capability inventory would
 * duplicate the same signals and re-introduce exactly the panel-list pattern
 * this layer is meant to retire.
 *
 * Cross-ref:
 *   src/domains/phil/job-command-input.ts — the real-data bridge (schema-coupled)
 *   src/domains/jobs/attention.ts — the office-side equivalent (admin tabs)
 *   src/domains/jobs/builder.ts — buildPhilPreview / isVisibleToField / moduleEnabled
 *   docs/phil-job-command-model.md — design, input matrix, intended UI integration
 */

/* ---------------------------------------------------------------------
 * Output — the command model
 * -------------------------------------------------------------------*/

/**
 * The job's overall posture for the field worker.
 *   - `ready`       there is assigned work or something needing attention
 *   - `blocked`     a hard blocker (e.g. job on hold) — don't direct to work
 *   - `office_only` draft/archived: not released to the field yet
 *   - `empty`       released, but nothing job-specific to do right now
 *   - `error`       the job couldn't be loaded / isn't available to this worker
 */
export type PhilJobState = "ready" | "blocked" | "office_only" | "empty" | "error";

/**
 * Bounded set of worker-facing actions. Deliberately small and stable — these
 * are field verbs, not modules. New capabilities should map onto an existing
 * verb where possible rather than growing this list unbounded.
 */
export type PhilJobActionId =
  | "fix_rejected_hours"
  | "complete_checks"
  | "continue_tasks"
  | "capture"
  | "log_hours"
  | "view_plans"
  | "report_issue";

/**
 *   - `ready`           available, nothing wrong
 *   - `attention`       available AND something needs the worker's action
 *   - `disabled`        understood but not actionable right now (rare; prefer a limitation)
 *   - `not_configured`  the underlying feature is off for this job (rare; prefer omission)
 *
 * In practice the builder routes "off"/"unknown" capabilities to `limitations`
 * rather than emitting `disabled`/`not_configured` actions, so unsupported
 * actions never render. The two statuses remain in the contract for callers
 * that want to surface them explicitly.
 */
export type PhilJobActionStatus = "ready" | "attention" | "disabled" | "not_configured";

export interface PhilJobCommandAction {
  id: PhilJobActionId;
  label: string;
  /** Set only for actions that live on another surface (hours, rejected hours).
   *  In-page actions (capture, checks, tasks, plans, snags) leave this unset —
   *  the UI maps them to the relevant section on the job page itself. */
  href?: string;
  status: PhilJobActionStatus;
  reason?: string;
}

export type PhilJobAttentionSeverity = "info" | "warning" | "blocked";

export interface PhilJobAttentionItem {
  id: string;
  severity: PhilJobAttentionSeverity;
  label: string;
  reason?: string;
  /** Links the attention item to an action the worker can take, when one exists. */
  actionId?: PhilJobActionId;
}

/**
 * An honest statement of something the worker should know we CANNOT show or do
 * here yet — the antidote to false confidence. A limitation is never a count
 * and never implies completion.
 */
export interface PhilJobLimitation {
  id: string;
  label: string;
  reason?: string;
}

export interface PhilJobCommandModel {
  jobId: string;
  jobName: string;
  state: PhilJobState;
  /** The single highest-priority thing to do, or null when there's nothing to
   *  lead with (blocked / office-only / empty / error). */
  primaryAction: PhilJobCommandAction | null;
  /** Remaining actions, ranked. Excludes `primaryAction`. */
  actions: PhilJobCommandAction[];
  /** Things needing awareness/action, ranked by severity. */
  attention: PhilJobAttentionItem[];
  /** Honest "can't show / not available yet" notes. */
  limitations: PhilJobLimitation[];
}

/* ---------------------------------------------------------------------
 * Input — the contract the UI assembles from real data
 *
 * Each signal is a small discriminated union so the *absence* of confidence is
 * a first-class value. The bridge in job-command-input.ts is responsible for
 * setting these honestly from whatever the Phil job page actually has.
 * -------------------------------------------------------------------*/

/** A count that is either real, not-yet-knowable, or off for this job. */
export type PhilCountSignal =
  | { kind: "count"; value: number }
  | { kind: "unknown" }
  | { kind: "not_configured" };

/** A capability that is here, lives on another surface, off, or unknown. */
export type PhilAvailability =
  | { kind: "available"; href?: string }
  | { kind: "elsewhere"; href: string }
  | { kind: "unavailable"; reason?: string }
  | { kind: "unknown" };

/**
 * Worker-visible tasks. `tracked` carries real per-task completion; `list_only`
 * means the task plan is real, but this caller has not supplied real task state,
 * so the model must never claim a completion count.
 */
export type PhilTaskSignal =
  | { kind: "tracked"; visible: number; incomplete: number }
  | { kind: "list_only"; visible: number }
  | { kind: "unknown" }
  | { kind: "not_configured" };

/** Job identity + the few job-level facts the decision needs. Always carries
 *  the id when known, so job context is preserved even on the error path. */
export type PhilJobIdentity =
  | {
      kind: "ok";
      id: string;
      name: string;
      /** false for draft/archived (mirrors builder.isVisibleToField). */
      visibleToField: boolean;
      /** status === "on_hold" — a real, worker-relevant blocker. */
      onHold: boolean;
      inductionRequired: boolean;
    }
  | { kind: "not_found"; id?: string }
  | { kind: "error"; id?: string; message?: string };

export interface PhilJobCommandInput {
  job: PhilJobIdentity;
  /** Photo/note capture for this job. */
  capture: PhilAvailability;
  /** Current plans/documents the worker can view. */
  plans: PhilCountSignal;
  /** Open snags on this job (open / in_progress / resolved). */
  snags: PhilCountSignal;
  /** ITP points the worker still needs to record (pending / in-progress). */
  itps: PhilCountSignal;
  /** Worker-visible tasks. */
  tasks: PhilTaskSignal;
  /** Rejected hour entries on this job the worker can fix + resubmit. */
  rejectedHours: PhilCountSignal;
  /** Logging hours (today: lives on the Day tab → `elsewhere`). */
  hours: PhilAvailability;
  /** Requesting materials (today: not in-app → `unavailable`). */
  materials: PhilAvailability;
}

/* ---------------------------------------------------------------------
 * Ranking
 * -------------------------------------------------------------------*/

/**
 * Priority order for actions. Easy to adjust — this single list is the policy.
 * Mirrors the brief's intended order (blockers are handled as state, not an
 * action, so they don't appear here):
 *   fix rejected hours → required checks → continue tasks → capture →
 *   log hours → view plans → report issue.
 */
export const PHIL_JOB_ACTION_PRIORITY: readonly PhilJobActionId[] = [
  "fix_rejected_hours",
  "complete_checks",
  "continue_tasks",
  "capture",
  "log_hours",
  "view_plans",
  "report_issue",
];

/** Actions that represent job-specific work (vs. "ambient" capabilities like
 *  logging hours on the Day tab or reporting an issue, which are always
 *  available and so don't, by themselves, make a job "ready"). */
const WORK_ACTION_IDS: ReadonlySet<PhilJobActionId> = new Set<PhilJobActionId>([
  "fix_rejected_hours",
  "complete_checks",
  "continue_tasks",
  "capture",
  "view_plans",
]);

const STATUS_WEIGHT: Record<PhilJobActionStatus, number> = {
  attention: 0,
  ready: 1,
  disabled: 2,
  not_configured: 3,
};

/**
 * Deterministic, stable ordering: needs-attention first, then ready, then
 * unavailable; within a status, by `PHIL_JOB_ACTION_PRIORITY`. Because every
 * action id appears at most once, the comparator is a total order and the
 * result does not depend on the engine's sort stability. Pure — no clock, no
 * randomness — so the same input always yields the same order.
 */
export function rankPhilJobActions(
  actions: readonly PhilJobCommandAction[],
): PhilJobCommandAction[] {
  return [...actions].sort((a, b) => {
    const byStatus = STATUS_WEIGHT[a.status] - STATUS_WEIGHT[b.status];
    if (byStatus !== 0) return byStatus;
    return priorityIndex(a.id) - priorityIndex(b.id);
  });
}

function priorityIndex(id: PhilJobActionId): number {
  const i = PHIL_JOB_ACTION_PRIORITY.indexOf(id);
  return i === -1 ? PHIL_JOB_ACTION_PRIORITY.length : i;
}

const SEVERITY_WEIGHT: Record<PhilJobAttentionSeverity, number> = {
  blocked: 0,
  warning: 1,
  info: 2,
};

function rankAttention(items: readonly PhilJobAttentionItem[]): PhilJobAttentionItem[] {
  // Decorate-sort-undecorate with the original index so equal-severity items
  // keep their insertion order regardless of Array.sort stability.
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const bySeverity = SEVERITY_WEIGHT[a.item.severity] - SEVERITY_WEIGHT[b.item.severity];
      return bySeverity !== 0 ? bySeverity : a.index - b.index;
    })
    .map((d) => d.item);
}

/* ---------------------------------------------------------------------
 * The model
 * -------------------------------------------------------------------*/

function pluralCount(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * Build the command model from the input contract. Pure and total: every input
 * shape produces a well-formed model. Unknown signals become limitations;
 * unavailable features are omitted or explained — never faked.
 */
export function buildPhilJobCommandModel(input: PhilJobCommandInput): PhilJobCommandModel {
  const { job } = input;

  // 1. Couldn't load / not assigned → preserve context, surface honestly.
  if (job.kind === "not_found" || job.kind === "error") {
    const notFound = job.kind === "not_found";
    return {
      jobId: job.id ?? "",
      jobName: "",
      state: "error",
      primaryAction: null,
      actions: [],
      attention: [
        {
          id: notFound ? "job-not-found" : "job-load-error",
          severity: "blocked",
          label: notFound ? "This job isn’t available to you" : "We couldn’t load this job",
          reason: notFound
            ? "It may have been unassigned or archived. Tap back to your job list."
            : job.message ?? "Check your connection and pull to refresh.",
        },
      ],
      limitations: [],
    };
  }

  // 2. Draft/archived → office-only; nothing for the field here.
  if (!job.visibleToField) {
    return {
      jobId: job.id,
      jobName: job.name,
      state: "office_only",
      primaryAction: null,
      actions: [],
      attention: [
        {
          id: "office-only",
          severity: "warning",
          label: "This job isn’t released to the field yet",
          reason: "Your office still has it in draft. There’s nothing to do here yet.",
        },
      ],
      limitations: [],
    };
  }

  // 3. Released job — derive actions, attention, and honest limitations.
  const actions: PhilJobCommandAction[] = [];
  const attention: PhilJobAttentionItem[] = [];
  const limitations: PhilJobLimitation[] = [];

  // -- Hard blocker: on hold --
  if (job.onHold) {
    attention.push({
      id: "on-hold",
      severity: "blocked",
      label: "This job is on hold",
      reason: "Check with your supervisor before doing any work here.",
    });
  }

  // -- Induction (we know it's REQUIRED; we can't know if THIS worker has done
  //    it, so we flag, never assert non-completion) --
  if (job.inductionRequired) {
    attention.push({
      id: "induction-required",
      severity: "warning",
      label: "Site induction required",
      reason: "Make sure your induction is sorted before you start on site.",
    });
  }

  // -- Rejected hours (highest-priority action) --
  switch (input.rejectedHours.kind) {
    case "count":
      if (input.rejectedHours.value > 0) {
        const n = input.rejectedHours.value;
        actions.push({
          id: "fix_rejected_hours",
          label: `Fix ${pluralCount(n, "rejected hour entry", "rejected hour entries")}`,
          href: "/phil/hours",
          status: "attention",
          reason: "Your office sent these back — fix and resubmit.",
        });
        attention.push({
          id: "rejected-hours",
          severity: "warning",
          label: `${pluralCount(n, "hour entry", "hour entries")} need fixing`,
          reason: "Rejected by the office — fix and resubmit.",
          actionId: "fix_rejected_hours",
        });
      }
      break;
    case "unknown":
      limitations.push({
        id: "rejected-hours-unknown",
        label: "Rejected hours aren’t shown on the job screen",
        reason: "Check your Hours tab for anything sent back.",
      });
      break;
    case "not_configured":
      break;
  }

  // -- ITP checks the worker still needs to record --
  switch (input.itps.kind) {
    case "count":
      if (input.itps.value > 0) {
        const n = input.itps.value;
        actions.push({
          id: "complete_checks",
          label: `Complete ${pluralCount(n, "check")}`,
          status: "attention",
          reason: "ITP points still need recording on this job.",
        });
        attention.push({
          id: "checks-outstanding",
          severity: "warning",
          label: `${pluralCount(n, "check")} to record`,
          actionId: "complete_checks",
        });
      }
      break;
    case "unknown":
      limitations.push({
        id: "checks-unknown",
        label: "Couldn’t load checks (ITPs)",
        reason: "The count may be out of date — pull to refresh.",
      });
      break;
    case "not_configured":
      break;
  }

  // -- Worker-visible tasks --
  switch (input.tasks.kind) {
    case "tracked":
      if (input.tasks.incomplete > 0) {
        const n = input.tasks.incomplete;
        actions.push({
          id: "continue_tasks",
          label: `Continue work — ${pluralCount(n, "task")} left`,
          status: "attention",
          reason: "Pick up where the job is up to.",
        });
        attention.push({
          id: "tasks-remaining",
          severity: "info",
          label: `${pluralCount(n, "task")} still to do`,
          actionId: "continue_tasks",
        });
      }
      break;
    case "list_only":
      if (input.tasks.visible > 0) {
        // Tasks are visible but real task state was not supplied — offer "view",
        // never a completion count, and state the limitation plainly.
        actions.push({
          id: "continue_tasks",
          label: "View your tasks",
          status: "ready",
          reason: "Your rough-in and fit-off checklist for this job.",
        });
        limitations.push({
          id: "tasks-read-only",
          label: "Task progress isn’t loaded in this section yet",
          reason: "Open the task list for the latest done / to-do state.",
        });
      }
      break;
    case "unknown":
      limitations.push({
        id: "tasks-unknown",
        label: "Couldn’t load tasks",
        reason: "The task list may be out of date — pull to refresh.",
      });
      break;
    case "not_configured":
      break;
  }

  // -- Capture (the field workhorse) --
  switch (input.capture.kind) {
    case "available":
      actions.push({
        id: "capture",
        label: "Take a photo or add a note",
        href: input.capture.href,
        status: "ready",
        reason: "Capture evidence against this job.",
      });
      break;
    case "elsewhere":
      actions.push({
        id: "capture",
        label: "Take a photo or add a note",
        href: input.capture.href,
        status: "ready",
      });
      break;
    case "unavailable":
      limitations.push({
        id: "capture-off",
        label: "Photo capture is turned off for this job",
        reason: input.capture.reason,
      });
      break;
    case "unknown":
      limitations.push({
        id: "capture-unknown",
        label: "Couldn’t tell if photo capture is available",
      });
      break;
  }

  // -- Log hours (today: lives on the Day tab) --
  switch (input.hours.kind) {
    case "available":
      actions.push({
        id: "log_hours",
        label: "Log hours",
        href: input.hours.href,
        status: "ready",
      });
      break;
    case "elsewhere":
      actions.push({
        id: "log_hours",
        label: "Log hours",
        href: input.hours.href,
        status: "ready",
        reason: "Opens your Day tab — hours aren’t logged per job.",
      });
      break;
    case "unavailable":
      // Quietly omit — logging hours simply isn't offered from here.
      break;
    case "unknown":
      break;
  }

  // -- View plans / documents --
  switch (input.plans.kind) {
    case "count":
      if (input.plans.value > 0) {
        actions.push({
          id: "view_plans",
          label: `View plans & docs (${input.plans.value})`,
          status: "ready",
          reason: "The current drawings and documents for this job.",
        });
      }
      break;
    case "unknown":
      limitations.push({
        id: "plans-unknown",
        label: "Couldn’t load plans & documents",
        reason: "Pull to refresh to try again.",
      });
      break;
    case "not_configured":
      break;
  }

  // -- Report an issue (raise a snag). Always available when the feature is on;
  //    existing open snags become a separate awareness item. --
  switch (input.snags.kind) {
    case "count":
      actions.push({
        id: "report_issue",
        label: "Report an issue",
        status: "ready",
        reason: "Raise a snag the office can pick up.",
      });
      if (input.snags.value > 0) {
        const n = input.snags.value;
        attention.push({
          id: "open-snags",
          severity: "info",
          label: `${pluralCount(n, "open snag")} on this job`,
          actionId: "report_issue",
        });
      }
      break;
    case "unknown":
      // Raising still works even if we couldn't count existing ones.
      actions.push({
        id: "report_issue",
        label: "Report an issue",
        status: "ready",
        reason: "Raise a snag the office can pick up.",
      });
      limitations.push({
        id: "snags-unknown",
        label: "Couldn’t load existing snags",
        reason: "You can still report a new one.",
      });
      break;
    case "not_configured":
      break;
  }

  // -- Materials (today: no in-app flow) --
  if (input.materials.kind === "unavailable") {
    limitations.push({
      id: "materials-off-app",
      label: "Material requests aren’t in the app yet",
      reason: input.materials.reason ?? "Call your PM to request materials.",
    });
  } else if (input.materials.kind === "unknown") {
    limitations.push({
      id: "materials-unknown",
      label: "Couldn’t tell if material requests are available",
    });
  }

  // 4. Rank, classify, and split primary vs. secondary.
  const ranked = rankPhilJobActions(actions);
  const rankedAttention = rankAttention(attention);
  const isBlocked = rankedAttention.some((a) => a.severity === "blocked");

  const actionable = ranked.filter(
    (a) => a.status === "attention" || a.status === "ready",
  );
  const hasWork = actionable.some((a) => WORK_ACTION_IDS.has(a.id));
  const hasAttention = rankedAttention.length > 0;

  let state: PhilJobState;
  let primaryAction: PhilJobCommandAction | null;
  let secondary: PhilJobCommandAction[];

  if (isBlocked) {
    // Don't lead the worker into job work while it's blocked.
    state = "blocked";
    primaryAction = null;
    secondary = ranked;
  } else if (hasWork || hasAttention) {
    state = "ready";
    primaryAction = actionable[0] ?? null;
    secondary = ranked.filter((a) => a !== primaryAction);
  } else {
    // Released, but no assigned work — ambient actions (log hours, report
    // issue) may still be present; we just don't pretend there's work.
    state = "empty";
    primaryAction = null;
    secondary = ranked;
  }

  return {
    jobId: job.id,
    jobName: job.name,
    state,
    primaryAction,
    actions: secondary,
    attention: rankedAttention,
    limitations,
  };
}
