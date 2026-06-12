import type { PhilNeedsYouItem } from "./needs-you";

/**
 * My Day hero state machine (#422) — the ONE answer to "what do I do now?".
 *
 * The master audit (F2 / Big Call 1) found My Day shows everything and
 * decides nothing. This pure model resolves the seven cards into a single
 * prioritised hero so a worker acts in three seconds, not after reading the
 * whole stack.
 *
 * Priority (highest first): a rejected day the office bounced back >
 * today not logged yet > today's draft not submitted > the active job's
 * next move > all clear. Pure and total — every input maps to exactly one
 * hero; no fetch, no React, fully unit-testable.
 */

export type MyDayHeroKind =
  | "fix-rejected"
  | "log-today"
  | "submit-draft"
  | "next-job"
  | "all-clear";

export type MyDayHeroTone = "danger" | "action" | "info" | "success";

export interface MyDayHero {
  kind: MyDayHeroKind;
  /** The one-line answer. Status-bearing → rendered ≥14px. */
  title: string;
  /** One sentence of why / what. */
  detail: string;
  /** Verb-phrase for the action chip, or null when the action is the log
   *  sheet rendered directly below the hero (kind "log-today"/"submit-draft"). */
  actionLabel: string | null;
  /** In-app deep link for the action, or null when the action is inline. */
  href: string | null;
  tone: MyDayHeroTone;
}

export interface MyDayHeroInput {
  /** Today's time entry status, or null when nothing is logged for today. */
  todayStatus: "draft" | "submitted" | "approved" | "rejected" | null;
  /** The worker's "Needs you" items — the rejected-hours ones drive the
   *  top-priority fix state (same list the feed renders). */
  needsYouItems: ReadonlyArray<PhilNeedsYouItem>;
  /** The single assigned active job, when there's exactly one (no active-job
   *  signal otherwise — we never guess). Drives the "next move" state. */
  soleJob: { id: string; name: string } | null;
}

export function buildMyDayHero(input: MyDayHeroInput): MyDayHero {
  const rejected = input.needsYouItems.filter((i) => i.kind === "rejected-hours");

  // 1. A rejected day the office bounced — the worker must act before payroll
  //    can close. Highest priority; deep-links to the first one's fix flow.
  if (rejected.length > 0) {
    const first = rejected[0]!;
    const many = rejected.length > 1;
    return {
      kind: "fix-rejected",
      title: many ? `${rejected.length} days need fixing` : "A day was sent back",
      detail: many
        ? "The office bounced these hours back. Open each, fix the reason, resubmit."
        : `${first.title} — ${first.detail ?? "the office sent it back"}. Fix and resubmit.`,
      actionLabel: many ? "Fix hours" : "Fix it now",
      href: first.href,
      tone: "danger",
    };
  }

  // 2. Today not logged — the core daily job. The action is the log sheet
  //    rendered directly below, so no href.
  if (input.todayStatus === null) {
    return {
      kind: "log-today",
      title: "Log today's hours",
      detail: "Two taps for a standard day — it's right below.",
      actionLabel: null,
      href: null,
      tone: "action",
    };
  }

  // 3. Today logged but still a draft — it never reached the approval queue.
  //    The silent gap; nudge to submit (the sheet below handles it).
  if (input.todayStatus === "draft") {
    return {
      kind: "submit-draft",
      title: "Today's hours aren't submitted",
      detail: "You saved a draft but haven't sent it. Submit it below so it counts.",
      actionLabel: null,
      href: null,
      tone: "info",
    };
  }

  // 4. Today's in (submitted/approved) and there's a single active job — point
  //    at it for the next on-site move.
  if (input.soleJob) {
    return {
      kind: "next-job",
      title: `You're on ${input.soleJob.name}`,
      detail: "Today's hours are in. Open the job for what's next on site.",
      actionLabel: "Open the job",
      href: `/phil/jobs/${input.soleJob.id}`,
      tone: "info",
    };
  }

  // 5. Nothing pending.
  return {
    kind: "all-clear",
    title: "All clear",
    detail: "Today's hours are in and nothing needs you. Have a good one.",
    actionLabel: null,
    href: null,
    tone: "success",
  };
}
