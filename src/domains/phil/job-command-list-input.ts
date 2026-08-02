/**
 * Phil Job Command Model — the LIST-row bridge (#146).
 *
 * `job-command-input.ts` builds a `PhilJobCommandInput` from everything the full
 * job PAGE fetches (snags, ITPs, plans, tags, task state…). The jobs LIST row
 * does not have those loads — it has only the opt-in `?withStats=1` summary
 * fields on the job. This bridge turns THAT thinner signal set into a command
 * input, marking every list-absent capability `unknown` so the decision layer
 * never renders an action it can't truthfully back (P7).
 *
 * It exists so a long-press of a job row can offer the SAME ranked top actions
 * the job page would — `rankPhilJobActions` over a real model, not a hardcoded
 * list — without fetching the whole job page. When the worker taps a shortcut we
 * deep-link to the job page section it belongs to (`philJobActionHref`), where
 * the real, page-loaded model takes over.
 *
 * What is real on a list row:
 *   - snags  → `statsSnagsV2Active` (the same active set the row's chips show)
 *   - hours  → `elsewhere` (/phil/my-day), a real cross-surface capability
 *   (ITPs + tags are permanently `not_configured` — deleted registers.)
 *
 * What stays honestly `unknown` (not on the list summary):
 *   - plans, tasks, rejected hours
 *   - capture/materials availability (module flags aren't on the summary)
 *
 * Because the action builder routes `unknown` capture/materials to limitations
 * rather than actions, an unsupported action never appears in the ranked list —
 * so a row shortcut only ever offers a launchable action.
 *
 * Cross-ref:
 *   src/domains/phil/job-command-model.ts — the pure decision layer + ranking
 *   src/domains/phil/job-command-input.ts — the full-page bridge (sibling)
 *   src/components/phil/PhilJobCommandPanel.tsx — IN_PAGE_ANCHOR (mirrored here)
 */

import type { Job } from "@/domains/jobs/types";
import type {
  PhilJobActionId,
  PhilJobCommandAction,
  PhilJobCommandInput,
} from "./job-command-model";

/** Non-negative integer or 0 — mirrors philJobsListSignals' positiveInteger. */
function statCount(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Build the command-model input from only the fields a jobs-LIST row carries.
 *
 * The job is assumed already visible-to-field (the Phil list filters draft +
 * archived before rendering — see app/phil/jobs/page.tsx), so `visibleToField`
 * is true and `onHold` reflects the status. Everything the list doesn't fetch is
 * `unknown` — never a fabricated 0.
 */
export function philJobCommandInputFromListSignals(
  job: Pick<
    Job,
    "id" | "name" | "status" | "inductionRequired" | "statsSnagsV2Active"
  >,
): PhilJobCommandInput {
  const status = job.status ?? "active";
  return {
    job: {
      kind: "ok",
      id: job.id,
      name: job.name,
      // The list only renders field-visible jobs; draft/archived never reach a row.
      visibleToField: status !== "draft" && status !== "archived",
      onHold: status === "on_hold",
      inductionRequired: Boolean(job.inductionRequired),
      // Per-worker induction completion isn't on the list summary — leave it
      // "not done" so the safe compliance nudge stands rather than being faked
      // away. The job page (with the real register) is the source of truth.
      inductionDone: false,
    },
    // Real, opt-in list stats — the same active sets the row chips show.
    snags: { kind: "count", value: statCount(job.statsSnagsV2Active) },
    // Deleted registers (the job-page rebuild): permanently not_configured.
    itps: { kind: "not_configured" },
    tags: { kind: "not_configured" },
    // Hours live on the Day tab — a real capability on another surface.
    hours: { kind: "elsewhere", href: "/phil/my-day" },
    // Everything else the list doesn't fetch: honestly unknown, never a fake 0.
    plans: { kind: "unknown" },
    tasks: { kind: "unknown" },
    rejectedHours: { kind: "unknown" },
    // Module flags (photos/materials) aren't on the summary — unknown, so the
    // builder files them as limitations and no capture/materials action renders.
    capture: { kind: "unknown" },
    materials: { kind: "unknown" },
  };
}

/**
 * In-page section anchors for actions the model leaves href-less — the SAME map
 * PhilJobCommandPanel uses (IN_PAGE_ANCHOR), kept in lock-step so a row shortcut
 * lands on exactly the section the on-page panel would. Keyed by action id.
 */
const IN_PAGE_ANCHOR: Partial<Record<PhilJobActionId, string>> = {
  capture: "#phil-job-capture",
  complete_checks: "#phil-job-itps",
  continue_tasks: "#phil-job-work",
  view_plans: "#phil-job-plans",
  view_tags: "#phil-job-tags",
  report_issue: "#phil-job-snags",
};

/**
 * The full href a job-row shortcut should navigate to for a ranked action:
 *   - a cross-surface action (hours / rejected hours) → its own absolute href;
 *   - an in-page action → the job page + the section anchor;
 *   - otherwise → the job page itself (never a dead link).
 *
 * Pure: the job page, once opened, rebuilds the real page-loaded model — this
 * only gets the worker to the right place in one tap.
 */
export function philJobActionHref(jobId: string, action: PhilJobCommandAction): string {
  if (action.href) return action.href;
  const base = `/phil/jobs/${encodeURIComponent(jobId)}`;
  const anchor = IN_PAGE_ANCHOR[action.id];
  return anchor ? `${base}${anchor}` : base;
}
