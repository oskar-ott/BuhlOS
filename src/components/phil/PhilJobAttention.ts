import type { Job } from "@/domains/jobs/types";

/**
 * Needs-attention derivation for the Phil job interface.
 *
 * Per the Phil Job Interface Bible §07 ("Needs Attention doctrine"):
 *   - Strict: only high-confidence, current, actionable items.
 *   - Maximum three visible.
 *   - Every item must carry a one-sentence `reasonShown` string.
 *   - Counts and weak rollups are forbidden — every row links to a
 *     specific thing the worker can act on.
 *
 * We derive the strip from real data the page already loads:
 *
 *   1. Site induction required  — info. Lifts the induction notice from
 *      the (collapsible) Site card to the top of the page so a first
 *      visit to a site doesn't miss it.
 *
 * Ordering above is the priority; the top three after filtering survive.
 *
 * We deliberately do NOT derive items for:
 *   - "X new captures" — counts of captures aren't attention items.
 *   - "Job is active" — the steady state isn't an alert.
 *   - "Z documents available" — read-only library, not actionable.
 *
 * Cross-ref:
 *   /tmp/phil-bible/buhlos-phil/project/Phil Job Interface Bible.html §07
 *   src/components/phil/PhilJobAttentionStrip.tsx — renders these
 */

export type AttentionTone = "danger" | "warning" | "info";

export interface AttentionItem {
  /** Stable id — `${kind}:${detailId?}`. Used as the React key + for
   *  the optional "see all" target's deep link in future. */
  id: string;
  /** Visual severity. Drives the left border + label colour. */
  tone: AttentionTone;
  /** Short uppercase mono label rendered above the title. */
  kind: string;
  /** Plain-language headline. */
  title: string;
  /** One-sentence reason this row exists. Mandatory per bible §07. */
  reasonShown: string;
  /** Verb-phrase label for the action chip. */
  actionLabel: string;
  /** In-page anchor (e.g. "#phil-job-snags") OR a href if the item
   *  links somewhere else. We default to anchors because Phil renders
   *  every section on the same page; an external href is honoured if
   *  set. */
  anchor: string;
}

export interface DeriveAttentionInput {
  job: Job;
  /** True when THIS worker has a recorded induction on this job (#332).
   *  Undefined/false keeps the reminder — safe direction for compliance. */
  inductionDone?: boolean;
}

const MAX_VISIBLE = 3;

/**
 * Compose the Phil attention strip from real signals on the page.
 *
 * Pure function of its inputs so it tests cleanly. Returns up to
 * MAX_VISIBLE items; the strip caller appends an "n more" link if the
 * unfiltered list exceeded the cap.
 */
export function deriveAttention(
  input: DeriveAttentionInput,
): { items: AttentionItem[]; total: number } {
  const items: AttentionItem[] = [];

  // 1. Site induction required — first-visit reminder. Cleared once THIS
  // worker has a record in the induction register (#332).
  if (input.job.inductionRequired && !input.inductionDone) {
    items.push({
      id: `induction`,
      tone: "info",
      kind: "Site induction",
      title: "Site induction required",
      reasonShown:
        "Confirm with your leading hand before starting work on this site.",
      actionLabel: "Open Site",
      anchor: "#phil-job-site",
    });
  }

  return { items: items.slice(0, MAX_VISIBLE), total: items.length };
}
