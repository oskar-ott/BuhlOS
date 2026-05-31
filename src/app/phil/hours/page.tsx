import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { PhilShell } from "@/components/phil/PhilShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusChip, type StatusTone } from "@/components/ui/StatusChip";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { TimeEntryListResponseSchema } from "@/domains/timesheets/schema";
import type { TimeEntry } from "@/domains/timesheets/types";
import {
  formatDateLabel,
  formatHoursLabel,
  formatTimestamp,
  statusLabel,
  statusTone,
} from "@/domains/timesheets/format";

// Bridge the timesheets-domain tone vocabulary into the shared StatusChip
// palette. statusTone() returns a narrower union (neutral/info/success/
// danger) for hours; the explicit record keeps both sides honest if
// either side widens.
const HOURS_CHIP_TONE: Record<ReturnType<typeof statusTone>, StatusTone> = {
  neutral: "neutral",
  info: "info",
  success: "success",
  danger: "danger",
};

export const dynamic = "force-dynamic";

/**
 * /phil/hours — the worker's own history of submissions.
 *
 * History is read-only here; editing/resubmitting a rejected entry happens in
 * place on /phil/my-day (the LogHoursSheet now PATCHes and resubmits). Each
 * rejected row deep-links to /phil/my-day?fix=YYYY-MM-DD, which opens the sheet
 * straight onto that day in edit mode — no bounce to the legacy app.
 *
 * Cross-ref: docs/rebuild-audit/19-phase-b-hours-implementation-brief.md
 *            §"/phil/hours (history)"
 */
export default async function PhilHoursPage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/phil/hours");
  }
  if (!canAccessSurface(session.role, "phil")) {
    redirect("/v2/login");
  }

  const { entries, fetchError } = await loadHistory(raw);

  return (
    <PhilShell title="Hours history">
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <Link
            href="/phil/my-day"
            className="text-sm text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
          >
            ← My day
          </Link>
        </div>

        {fetchError ? (
          <Card className="border-amber-200 bg-amber-50" role="alert">
            <CardTitle>Couldn&rsquo;t load history</CardTitle>
            <CardDescription className="text-amber-900">{fetchError}</CardDescription>
          </Card>
        ) : null}

        {entries.length === 0 ? (
          <EmptyState
            title="No entries yet"
            description="Once you submit hours on /phil/my-day they'll show up here with status updates."
          />
        ) : (
          <ul className="space-y-3">
            {entries.map((entry) => (
              <li key={entry.id}>
                <EntryCard entry={entry} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </PhilShell>
  );
}

function EntryCard({ entry }: { entry: TimeEntry }) {
  return (
    <Card className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <CardTitle>{formatHoursLabel(entry.totalHours)}</CardTitle>
          <CardDescription>{formatDateLabel(entry.date)}</CardDescription>
        </div>
        <StatusChip tone={HOURS_CHIP_TONE[statusTone(entry.status)]}>
          {statusLabel(entry.status)}
        </StatusChip>
      </div>

      {entry.notes ? (
        <p className="text-sm text-text-muted">
          <span className="font-medium text-text">Note:</span> {entry.notes}
        </p>
      ) : null}

      {entry.status === "rejected" && entry.rejectedReason ? (
        <div className="rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          <p className="font-display text-[11px] font-semibold uppercase tracking-wider text-rose-700">
            Why
          </p>
          <p className="mt-0.5 whitespace-pre-line">{entry.rejectedReason}</p>
          <Link
            href={{ pathname: "/phil/my-day", query: { fix: entry.date } }}
            className="mt-2 inline-block font-medium underline decoration-rose-400 decoration-2 underline-offset-2 hover:text-rose-950"
          >
            Fix &amp; resubmit →
          </Link>
        </div>
      ) : null}

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-text-muted">
        <dt>Submitted</dt>
        <dd>{formatTimestamp(entry.submittedAt) ?? "—"}</dd>
        {entry.status === "approved" ? (
          <>
            <dt>Approved</dt>
            <dd>{formatTimestamp(entry.approvedAt) ?? "—"}</dd>
          </>
        ) : null}
        {entry.status === "rejected" ? (
          <>
            <dt>Rejected</dt>
            <dd>{formatTimestamp(entry.rejectedAt) ?? "—"}</dd>
          </>
        ) : null}
      </dl>
    </Card>
  );
}

async function loadHistory(cookieValue: string | undefined): Promise<{
  entries: ReadonlyArray<TimeEntry>;
  fetchError: string | null;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(`${base}/api/time-entries`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (!res.ok) {
      return { entries: [], fetchError: `API returned ${res.status}` };
    }
    const body = await res.json();
    const parsed = TimeEntryListResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { entries: [], fetchError: "Unexpected response shape" };
    }
    return { entries: parsed.data.entries, fetchError: null };
  } catch (err) {
    return {
      entries: [],
      fetchError: err instanceof Error ? err.message : "Network error",
    };
  }
}
