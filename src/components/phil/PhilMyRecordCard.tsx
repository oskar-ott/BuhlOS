import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { formatHoursLabel } from "@/domains/timesheets/format";
import type { MyRecordWindow } from "@/domains/workforce/my-record";

/**
 * "Your work record" on the Phil More tab (#340) — a quiet, self-only look
 * back at the worker's own recent contribution: hours logged over the last
 * few weeks and the jobs they've been on. Read-only; the office owns nothing
 * here and no other worker's data ever reaches this card.
 *
 * Serves worker transparency/ownership — the worker can finally see their own
 * recent work in one glance, built entirely from the hours they themselves
 * logged. It sits on the low-stakes profile/account area (P10), not the core
 * task flow.
 *
 * Honesty (P7): every number is a real recorded total from /api/my-stats. A
 * new starter with no hours sees an honest "No hours logged yet", never a
 * fabricated zero dressed up as a stat. Site language, not enterprise (P11):
 * "hours", "jobs you've been on" — no "utilisation", no "KPIs".
 */

interface PhilMyRecordCardProps {
  record: MyRecordWindow | null;
  fetchError: string | null;
}

/** "9 Jun" — day + short month for a YYYY-MM-DD (UTC parse, matches the API). */
function shortDay(dateISO: string): string {
  const d = new Date(dateISO + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return dateISO;
  return d.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

export function PhilMyRecordCard({ record, fetchError }: PhilMyRecordCardProps) {
  const weeks = record?.weeks ?? [];
  const jobs = record?.jobs ?? [];
  const total = record?.totalHours ?? 0;
  const weekCount = record?.weekCount ?? weeks.length;
  const hasWork = total > 0 || jobs.length > 0;

  return (
    <Card className="space-y-3">
      <div>
        <CardTitle>Your work record</CardTitle>
        <CardDescription>
          {weekCount > 0
            ? `Hours you've logged over the last ${weekCount} weeks, and the jobs you've been on. Just for you.`
            : "Hours you've logged, and the jobs you've been on. Just for you."}
        </CardDescription>
      </div>

      {fetchError ? (
        <p className="text-sm text-text-muted">
          Couldn&rsquo;t load your record right now ({fetchError}). Pull to
          refresh or try again later.
        </p>
      ) : !hasWork ? (
        <p className="text-sm text-text-muted">
          No hours logged yet. Once you start logging your hours, your recent
          weeks and the jobs you&rsquo;ve been on show up here.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm text-text-muted">Logged in this stretch</span>
            <span className="text-lg font-semibold text-text">
              {formatHoursLabel(total)}
            </span>
          </div>

          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-text-muted">
              By week
            </p>
            <ul className="divide-y divide-border">
              {weeks.map((w) => (
                <li
                  key={w.weekStart}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <span className="text-sm text-text">
                    Week of {shortDay(w.weekStart)}
                  </span>
                  <span className="text-sm text-text-muted">
                    {w.totalHours > 0 ? formatHoursLabel(w.totalHours) : "—"}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {jobs.length > 0 ? (
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-text-muted">
                Jobs you&rsquo;ve been on
              </p>
              <ul className="divide-y divide-border">
                {jobs.map((j) => (
                  <li
                    key={j.jobId}
                    className="flex items-center justify-between gap-2 py-2"
                  >
                    <span className="min-w-0 truncate text-sm font-medium text-text">
                      {j.jobName}
                    </span>
                    <Pill tone="neutral">{formatHoursLabel(j.hours)}</Pill>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}
