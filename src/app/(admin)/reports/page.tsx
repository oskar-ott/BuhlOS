import Link from "next/link";
import type { Route } from "next";
import type { z } from "zod";
import { notFound, redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { OwnerNumbersBoard } from "@/components/admin/OwnerNumbersBoard";
import { UtilisationPanel } from "@/components/admin/UtilisationPanel";
import { InsightsDigestCard, type StoredDigest } from "@/components/admin/InsightsDigestCard";
import {
  OfficeDailySummaryCard,
  type StoredOfficeSummary,
} from "@/components/admin/OfficeDailySummaryCard";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { isFlagEnabled } from "../../../../api/_lib/feature-flags.js";
import { canAccessSurface } from "@/lib/auth/permissions";
import {
  BUSINESS_TIMEZONE,
  localDateString,
} from "@/domains/timesheets/service";
import { TimeEntryListResponseSchema, TodayPulseResponseSchema } from "@/domains/timesheets/schema";
import { DefectsRegisterResponseSchema } from "@/domains/snags/register";
import {
  approvalsWaitingTile,
  crewOnClockTile,
  defectsAttentionTile,
  hoursThisWeekTile,
  overContractTile,
  quotePipelineTile,
  sourceErrorTile,
  CompareWeeksResponseSchema,
  OwnerJobsResponseSchema,
  QuoteStatsResponseSchema,
  type OwnerNumberTile,
} from "@/domains/analytics/owner-numbers";

export const dynamic = "force-dynamic";

/**
 * /reports (#316) — the six numbers the owner checks daily, on one
 * v2 screen. Doc 13's IA names this section "Reports".
 *
 * BOUNDARY (#185 vs #316): /command-centre is the attention surface —
 * today strip + needs-you queues, THE landing. /reports is the numbers
 * surface — values, week-over-week trends, drill-downs. They link to
 * each other and never duplicate: no queue cards here, no analytics
 * tiles there. Where a number appears on both (approvals waiting, crew
 * on the clock) it comes from the SAME endpoint with zero client-side
 * re-math, so the surfaces cannot disagree.
 *
 * The ratified six (ratified by default — owner can edit the set; see
 * docs/owner-dashboard.md) and their single sources are DEFINED in
 * src/domains/analytics/owner-numbers.ts (the #329 seed). This page
 * fan-ins the six sources server-side in parallel and renders exactly
 * what the module returns — a failed source degrades to that tile's
 * explicit error state while the other five still paint (the
 * command-centre loadSnapshot pattern).
 *
 * Tile 6 deliberately reads the PERSISTED job.cashWatch off /api/jobs
 * instead of cash-watch's ?dryRun=1 recompute — the dryRun walks every
 * user time-entry blob in the request path (#316 enrichment req 1); the
 * tile carries the cron's lastAlertedAt as its asOf instead.
 */
export default async function ReportsPage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/reports");
  }
  // Admin tier via the normalised-role surface check (same pattern as
  // /command-centre) — never a literal 'admin' comparison.
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }
  // #760: reports kill-switch — when the owner turns reports off, the surface 404s.
  if (!(await isFlagEnabled("reports", session))) {
    notFound();
  }

  const tiles = await loadOwnerNumbers(raw);

  // #347 — flag-dark (default OFF) AI insights digest. Loaded server-side so
  // the card renders with the stored digest; the client button only triggers
  // regeneration. Invisible until the flag is on for this admin.
  const digestEnabled = await isFlagEnabled("ai_insights_digest", session);
  const digestData = digestEnabled ? await loadDigest(raw) : null;

  // #171 — flag-dark (default OFF) office daily summary of yesterday across
  // jobs. Same pattern: loaded server-side, the client button only triggers
  // regeneration. Invisible until the flag is on for this admin.
  const officeSummaryEnabled = await isFlagEnabled("ai_office_daily_summary", session);
  const officeSummaryData = officeSummaryEnabled ? await loadOfficeSummary(raw) : null;

  return (
    <AdminShell title="Reports">
      <div className="mx-auto max-w-5xl space-y-6">
        <Card>
          <CardTitle>The six numbers</CardTitle>
          <CardDescription className="mt-1">
            How the business is trending — values with week-over-week
            direction where the source provides it, each one click from the
            records behind it. Queues that need a decision live in the{" "}
            <Link
              href="/command-centre"
              className="font-medium text-brand-navy underline underline-offset-2"
            >
              Command centre
            </Link>
            ; this page is the numbers. For an end-of-day, what-happened-across-every-job
            review, see the{" "}
            <Link
              href={"/activity" as Route}
              className="font-medium text-brand-navy underline underline-offset-2"
            >
              activity feed
            </Link>
            .
          </CardDescription>
        </Card>

        <section aria-label="Owner numbers">
          <OwnerNumbersBoard tiles={tiles} />
        </section>

        {officeSummaryData ? (
          <section aria-label="Office daily summary">
            <OfficeDailySummaryCard
              date={officeSummaryData.date}
              summary={officeSummaryData.summary}
            />
          </section>
        ) : null}

        {digestData ? (
          <section aria-label="AI insights digest">
            <InsightsDigestCard weekStart={digestData.weekStart} digest={digestData.digest} />
          </section>
        ) : null}

        {/* #342: crew utilisation — multi-week vs real expected hours + crew
            capacity. Client-fetched (admin-only endpoint); degrades on its own. */}
        <section aria-label="Crew utilisation">
          <UtilisationPanel />
        </section>
      </div>
    </AdminShell>
  );
}

// #347 — read the stored digest for the current week (never generates).
async function loadDigest(
  cookieValue: string | undefined,
): Promise<{ weekStart: string; digest: StoredDigest | null } | null> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  const result = await fetchJson(
    base,
    "/api/insights-digest",
    cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    "Insights digest",
  );
  if (result.error || !result.body || typeof result.body !== "object") return null;
  const body = result.body as { weekStart?: string; digest?: StoredDigest | null };
  if (!body.weekStart) return null;
  return { weekStart: body.weekStart, digest: body.digest ?? null };
}

// #171 — read the stored summary for yesterday (never generates).
async function loadOfficeSummary(
  cookieValue: string | undefined,
): Promise<{ date: string; summary: StoredOfficeSummary | null } | null> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  const result = await fetchJson(
    base,
    "/api/office-daily-summary",
    cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    "Office daily summary",
  );
  if (result.error || !result.body || typeof result.body !== "object") return null;
  const body = result.body as { date?: string; summary?: StoredOfficeSummary | null };
  if (!body.date) return null;
  return { date: body.date, summary: body.summary ?? null };
}

// ── Server-side fan-in (loadSnapshot pattern) ──────────────────────────

interface FetchResult {
  body: unknown | null;
  error: string | null;
}

async function fetchJson(
  base: string,
  path: string,
  headersInit: { cookie: string } | undefined,
  sourceName: string,
): Promise<FetchResult> {
  try {
    const res = await fetch(`${base}${path}`, {
      cache: "no-store",
      headers: headersInit,
    });
    if (!res.ok) {
      return { body: null, error: `${sourceName} API returned ${res.status}` };
    }
    return { body: await res.json(), error: null };
  } catch (err) {
    return {
      body: null,
      error: err instanceof Error ? err.message : `${sourceName} network error`,
    };
  }
}

async function loadOwnerNumbers(
  cookieValue: string | undefined,
): Promise<OwnerNumberTile[]> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  const headersInit = cookieValue
    ? { cookie: `${SESSION_COOKIE}=${cookieValue}` }
    : undefined;

  // The same business-timezone day the hours surfaces use — for the
  // tile-1 "week in progress" honesty note, never for recomputing data.
  const todayISO = localDateString(new Date(), BUSINESS_TIMEZONE);
  const nowMs = Date.now();

  const [compareWeeks, approverQueue, todayPulse, openSnags, quoteStats, jobs] =
    await Promise.all([
      fetchJson(base, "/api/compare-weeks", headersInit, "Compare-weeks"),
      fetchJson(
        base,
        "/api/time-entries?scope=approver&status=submitted",
        headersInit,
        "Hours",
      ),
      fetchJson(base, "/api/today-pulse", headersInit, "Today pulse"),
      fetchJson(base, "/api/snags-all?status=open", headersInit, "Defects"),
      fetchJson(base, "/api/quote-stats", headersInit, "Quote stats"),
      fetchJson(base, "/api/jobs", headersInit, "Jobs"),
    ]);

  // Each source maps through ITS tile definition in the owner-numbers
  // module; a failed fetch or unexpected shape becomes that tile's
  // explicit error state without touching the other five.

  const tiles: OwnerNumberTile[] = [];

  tiles.push(
    buildTile("hours_week", compareWeeks, CompareWeeksResponseSchema, (p) =>
      hoursThisWeekTile(p, todayISO),
    ),
  );
  tiles.push(
    buildTile("approvals_waiting", approverQueue, TimeEntryListResponseSchema, (p) =>
      approvalsWaitingTile(p),
    ),
  );
  tiles.push(
    buildTile("crew_on_clock", todayPulse, TodayPulseResponseSchema, (p) =>
      crewOnClockTile(p),
    ),
  );
  tiles.push(
    buildTile("defects_attention", openSnags, DefectsRegisterResponseSchema, (p) =>
      defectsAttentionTile(p, nowMs),
    ),
  );
  tiles.push(
    buildTile("quotes_pipeline", quoteStats, QuoteStatsResponseSchema, (p) =>
      quotePipelineTile(p),
    ),
  );
  tiles.push(
    buildTile("over_contract", jobs, OwnerJobsResponseSchema, (p) =>
      overContractTile(p),
    ),
  );

  return tiles;
}

function buildTile<T extends z.ZodTypeAny>(
  id: OwnerNumberTile["id"],
  result: FetchResult,
  schema: T,
  build: (payload: z.infer<T>) => OwnerNumberTile,
): OwnerNumberTile {
  if (result.error) return sourceErrorTile(id, result.error);
  const parsed = schema.safeParse(result.body);
  if (!parsed.success) {
    return sourceErrorTile(id, "Unexpected response shape");
  }
  return build(parsed.data);
}
