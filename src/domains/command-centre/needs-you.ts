/**
 * Lean-reset desktop Command Centre view-model (design: BuhlOS replica,
 * command-centre frame). Three pure builders, one per section:
 *
 *   summaryHeadline   — the one-line summary sentence under the page head
 *   buildNeedsYouQueue — the "Needs you — what blocks pay, first" row list
 *   buildRightNow     — the "Right now" big-number strip
 *
 * Pure + deterministic (unit-tested in isolation); the page does the
 * permission-gated loading and renders these VMs. Honest-data rules
 * (P7) are baked in:
 *   - a FAILED source is passed as null and its clause/value is OMITTED or
 *     rendered "—" — never a fabricated 0;
 *   - zero-count rows drop from the queue (the list shows only what's open).
 */

export type NeedsYouTone = "block" | "wait" | "calm";

export interface NeedsYouRow {
  key: string;
  count: number;
  /** block = holding up pay (red) · wait = waiting on you (amber) · calm = no one blocked (neutral). */
  tone: NeedsYouTone;
  title: string;
  sub: string;
  /** Right-aligned mono destination label ("Approve", "Hours", "Jobs", "Review"). */
  cta: string;
  href: string;
}

export interface NeedsYouCounts {
  /** Rejected days the worker hasn't re-submitted (/api/time-entries rejected). */
  rejected: number;
  /** Weekday worker-days never logged in the last COMPLETE Mon–Sun week
   *  (overview missing rollup — the crew logs weekly, so the current week's
   *  gaps are expected and never counted here; owner directive 2026-08-08). */
  missingDays: number;
  /** Monday of the week `missingDays` was computed over — the chase link
   *  lands the weekly board on THAT week, not the current one. Optional so
   *  existing callers/tests keep working; without it the link falls back to
   *  the board's default (current) week. */
  missingWeekStart?: string;
  /** Active jobs with no field crew assigned (jobs stats). */
  noCrewJobs: number;
  /** Submitted days awaiting approver action. */
  pending: number;
  /** Photos/tags pending review across live jobs (statsEvidenceV2Pending rollup). */
  evidence: number;
}

/** Build the queue rows in "what blocks pay, first" order; zero counts drop. */
export function buildNeedsYouQueue(c: NeedsYouCounts): NeedsYouRow[] {
  const rows: NeedsYouRow[] = [
    {
      key: "rejected",
      count: c.rejected,
      tone: "block",
      title:
        c.rejected === 1
          ? "Rejected day to re-submit"
          : "Rejected days to re-submit",
      sub: "Sent back to the worker — these hours can’t be paid until they fix and resubmit.",
      cta: "Approve",
      href: "/hours/approvals",
    },
    {
      key: "missing",
      count: c.missingDays,
      tone: "block",
      title:
        c.missingDays === 1
          ? "Day never logged last week"
          : "Days never logged last week",
      sub: "The week's closed and these hours never came in — chase them before payroll runs.",
      cta: "Hours",
      href: c.missingWeekStart
        ? `/hours/weekly?week=${c.missingWeekStart}`
        : "/hours/weekly",
    },
    {
      key: "no-crew",
      count: c.noCrewJobs,
      tone: "block",
      title:
        c.noCrewJobs === 1
          ? "Active job with no crew assigned"
          : "Active jobs with no crew assigned",
      sub: "The field can’t see these jobs — assign workers so hours can be logged.",
      cta: "Jobs",
      href: "/v2/jobs",
    },
    {
      key: "pending",
      count: c.pending,
      tone: "wait",
      title:
        c.pending === 1
          ? "Day waiting on your approval"
          : "Days waiting on your approval",
      sub: "Approve or send back so they land in this pay period.",
      cta: "Approve",
      href: "/hours/approvals",
    },
    {
      key: "evidence",
      count: c.evidence,
      tone: "calm",
      title:
        c.evidence === 1
          ? "Photo or tag to review"
          : "Photos and tags to review",
      sub: "Site evidence uploaded against live jobs — no one is blocked on it.",
      cta: "Jobs",
      href: "/v2/jobs",
    },
  ];
  return rows.filter((r) => r.count > 0);
}

export interface SummarySignals {
  /** null = that source FAILED to load (its clause is omitted, never counted as 0). */
  rejected: number | null;
  missingDays: number | null;
  pending: number | null;
}

/**
 * The one-line summary sentence. Clause rules:
 *   - "N thing(s) are holding up pay this week" — rejected + missing (only the
 *     sources that loaded; a partial sum is still an honest at-least figure);
 *   - "M day(s) are waiting on your approval" — pending, when it loaded and >0;
 *   - "Nothing is blocked" is only claimed when BOTH blocking sources loaded;
 *   - the full all-clear sentence needs EVERY source loaded;
 *   - null when nothing can be said honestly (all clause sources failed) — the
 *     page renders no sentence and the degradation card discloses the failure.
 */
export function summaryHeadline(s: SummarySignals): string | null {
  const blockingKnown = s.rejected != null && s.missingDays != null;
  const blocking = (s.rejected ?? 0) + (s.missingDays ?? 0);
  const blockingClause =
    blocking > 0
      ? `${blocking} ${blocking === 1 ? "thing is" : "things are"} holding up pay this week`
      : null;
  const pendingClause =
    s.pending != null && s.pending > 0
      ? `${s.pending} ${s.pending === 1 ? "day is" : "days are"} waiting on your approval`
      : null;

  // Clauses lead with a numeral, so sentence-joining needs no re-casing.
  if (blockingClause && pendingClause) return `${blockingClause}, and ${pendingClause}.`;
  if (blockingClause) return `${blockingClause}.`;
  if (pendingClause) {
    return blockingKnown ? `Nothing is blocked — ${pendingClause}.` : `${pendingClause}.`;
  }
  if (blockingKnown && s.pending != null) {
    return "Nothing needs you. Every day this week is approved and no crew is waiting.";
  }
  // Every clause source is zero-or-failed with at least one failure — say
  // nothing rather than implying an all-clear the data can't support.
  return null;
}

export interface RightNowTile {
  key: string;
  /** Pre-formatted display value; "—" when the signal didn't load — never a fake 0. */
  value: string;
  /** Small trailing unit, e.g. "/5" on the on-the-clock roster ratio. */
  suffix?: string;
  label: string;
}

export interface RightNowSignals {
  /** Distinct crew with hours logged THIS Mon–Sun week (overview byUser).
   *  null = not loaded. The crew logs weekly — often the whole week at its
   *  end (owner directive 2026-08-08) — so the strip counts the week, never
   *  a today figure that reads 0 four days out of five. */
  crewLoggedThisWeek: number | null;
  /** Field-staff roster denominator (admin-stats). null = no honest denominator. */
  rosterTotal: number | null;
  /** Pre-formatted hours-this-week label ("38h 30m"). null = not loaded. */
  weekHoursLabel: string | null;
  /** Distinct jobs with logged hours this week (overview byJob). null = not loaded. */
  jobsThisWeek: number | null;
}

/** The "This week" strip: three big-number tiles, "—" for unloaded signals. */
export function buildRightNow(s: RightNowSignals): RightNowTile[] {
  return [
    {
      key: "crew-week",
      value: s.crewLoggedThisWeek == null ? "—" : String(s.crewLoggedThisWeek),
      ...(s.crewLoggedThisWeek != null && s.rosterTotal != null && s.rosterTotal > 0
        ? { suffix: `/${s.rosterTotal}` }
        : {}),
      label: "workers logged this week",
    },
    {
      key: "logged-week",
      value: s.weekHoursLabel ?? "—",
      label: "hours this week",
    },
    {
      key: "jobs-week",
      value: s.jobsThisWeek == null ? "—" : String(s.jobsThisWeek),
      label: "jobs worked this week",
    },
  ];
}
