import type { ITPInstance } from "@/domains/itp/types";
import type { Job } from "@/domains/jobs/types";
import type { SnagItem } from "@/domains/snags/types";

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
 *   1. Rejected snags  — danger. Admin pushed back with a reason; the
 *      worker has to see it and fix or accept.
 *   2. Open snags assigned to me  — warning. The worker has unclaimed
 *      or in-progress work hanging over them.
 *   3. ITPs needing first record  — warning. Pending instances haven't
 *      had a single point captured yet.
 *   4. Site induction required  — info. Lifts the induction notice from
 *      the (collapsible) Site card to the top of the page so a first
 *      visit to a site doesn't miss it.
 *
 * Ordering above is the priority; the top three after filtering survive.
 *
 * We deliberately do NOT derive items for:
 *   - "X new captures" — counts of captures aren't attention items.
 *   - "Y verified snags" — terminal-good states are noise.
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
  snags: ReadonlyArray<SnagItem>;
  itps: ReadonlyArray<ITPInstance>;
  /** Current viewer id — used to scope "assigned to me" rows. Pass
   *  null/empty if unknown (the "assigned" item is then suppressed). */
  viewerId: string | null;
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

  // 1. Rejected snags — admin pushback. Highest priority because the
  // worker has to act before the loop unblocks. We list each rejected
  // snag separately so the worker can see how many and tap to scroll.
  const rejected = input.snags.filter((s) => s.status === "rejected");
  if (rejected.length > 0) {
    const first = rejected[0];
    if (rejected.length === 1 && first) {
      items.push({
        id: `rejected:${first.id}`,
        tone: "danger",
        kind: "Snag rejected",
        title: first.title || "A snag was rejected",
        reasonShown:
          "Admin pushed back with a reason. Read it on the Snags list and fix or re-raise.",
        actionLabel: "Open Snags",
        anchor: "#phil-job-snags",
      });
    } else if (rejected.length > 1) {
      items.push({
        id: `rejected:multi`,
        tone: "danger",
        kind: "Snags rejected",
        title: `${rejected.length} snags rejected`,
        reasonShown:
          "Admin pushed back with a reason on more than one snag. Open the Snags list to read each.",
        actionLabel: "Open Snags",
        anchor: "#phil-job-snags",
      });
    }
  }

  // 2. Open / in-progress snags assigned to me — own work hanging.
  if (input.viewerId) {
    const mine = input.snags.filter(
      (s) =>
        s.assignedToId === input.viewerId &&
        (s.status === "open" || s.status === "in_progress"),
    );
    if (mine.length > 0) {
      items.push({
        id: `assigned:me`,
        tone: "warning",
        kind: "Assigned to you",
        title:
          mine.length === 1
            ? `1 snag assigned to you`
            : `${mine.length} snags assigned to you`,
        reasonShown:
          "Pick them up and mark progress as you fix them. Admin can see your status.",
        actionLabel: "Open Snags",
        anchor: "#phil-job-snags",
      });
    }
  }

  // 3. ITPs pending — no first record yet. Witnessed/in-progress are
  // already mid-flow so they don't need an alert.
  const pendingItps = input.itps.filter(
    (i) => i.status === "pending" && !i.archived,
  );
  if (pendingItps.length > 0) {
    items.push({
      id: `itp:pending`,
      tone: "warning",
      kind: "ITPs to start",
      title:
        pendingItps.length === 1
          ? `1 ITP to start`
          : `${pendingItps.length} ITPs to start`,
      reasonShown:
        "These inspection plans haven't had a single point captured yet.",
      actionLabel: "Open ITPs",
      anchor: "#phil-job-itps",
    });
  }

  // 4. Site induction required — first-visit reminder.
  if (input.job.inductionRequired) {
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
