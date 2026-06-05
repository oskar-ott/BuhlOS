import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { PhilShell } from "@/components/phil/PhilShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusChip, type StatusTone } from "@/components/ui/StatusChip";
import { UnderConstructionPanel } from "@/components/ui/UnderConstructionPanel";
import { PhilPageIntro } from "@/components/phil/ui/PhilPageIntro";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { PhilBackLink } from "@/components/phil/ui/PhilBackLink";
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
 * Read-only by design for Phase B: editing a rejected entry happens on the
 * legacy /my-day surface until Phase C ships the in-place edit flow. Putting
 * an edit form here would duplicate the legacy capture sheet without a
 * complete UX (LogHoursSheet is "create"-only).
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
        <PhilBackLink href="/phil/my-day">My day</PhilBackLink>

        <PhilPageIntro
          title="Hours history"
          description="Your recent submissions and where they’re up to. Read-only."
        />

        {fetchError ? (
          <PhilNotice tone="warning" title="Couldn’t load history" role="alert">
            {fetchError}
          </PhilNotice>
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

        <UnderConstructionPanel
          feature="Edit rejected entry"
          description="Tapping a rejected entry to edit and resubmit isn't wired here yet. For now, use the legacy My day — fix the entry, resubmit, and it'll come back through approval with the new submission timestamp."
          legacyHref="/my-day"
          legacyLabel="Open legacy My day"
        />
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
        <PhilNotice tone="danger" title="Why it bounced back">
          <p className="whitespace-pre-line">{entry.rejectedReason}</p>
        </PhilNotice>
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
