import { headers } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { SnagListResponseSchema } from "@/domains/snags/schema";
import { TagsExpiringCalibrationsResponseSchema } from "@/domains/gear/schema";
import type { ExpiringCalibration } from "@/domains/gear/types";
import { buildPhilNeedsYou, type JobSnags } from "@/domains/phil/needs-you";
import type { TimeEntry } from "@/domains/timesheets/types";
import { PhilNeedsYouFeed } from "./PhilNeedsYouFeed";
import { PhilSkeleton } from "./ui/PhilSkeleton";

/**
 * Streamed "Needs you" section for /phil/my-day.
 *
 * The My Day hero, week strip and log-hours sheet all render from the page's
 * first data wave (entries + jobs + profile). The "Needs you" feed, however,
 * needs a SECOND wave — snags are job-scoped (GET /api/snags?jobId= per
 * assigned job) so they can only be fetched once the jobs are known, plus the
 * held-gear calibration lapses (GET /api/tags-expiring). Each /api/* call is a
 * serverless + Blob round-trip (~1.3–2.1s warm; #670), so awaiting this second
 * wave before the page returns added a full extra hop to every My Day open.
 *
 * Rendering this section as an async server component INSIDE a <Suspense>
 * boundary lets the page flush the actionable shell immediately (one wave) and
 * stream the feed in when its data lands — the constitution's "app shell first,
 * then progressively load" / "never a blank screen". The hero's top-priority
 * "fix-rejected" state is unaffected: rejected hours come from `entries` (wave
 * one), which the page already has, so the page computes the hero itself.
 *
 * Honesty (P7): every item is real (buildPhilNeedsYou); the fallback is a plain
 * loading shimmer, never a fabricated row, and an empty result still renders the
 * feed's honest "nothing needs you" state.
 */
export async function PhilNeedsYouSection({
  cookieValue,
  viewerId,
  entries,
  jobs,
}: {
  cookieValue: string | undefined;
  viewerId: string | null;
  entries: ReadonlyArray<TimeEntry>;
  jobs: ReadonlyArray<{ id: string; name: string }>;
}) {
  const [jobSnags, calibrations] = await Promise.all([
    loadAssignedSnags(jobs, cookieValue),
    loadHeldCalibrations(cookieValue),
  ]);
  const items = buildPhilNeedsYou({ viewerId, entries, jobSnags, calibrations });
  return <PhilNeedsYouFeed items={items} />;
}

/** Honest loading shimmer for the streamed feed — a heading bar + two faint
 *  rows. Never implies specific items; resolves to the real feed (or its honest
 *  empty state) when the second data wave lands. */
export function PhilNeedsYouSectionFallback() {
  return (
    <section aria-label="Needs you" aria-busy="true" aria-live="polite">
      <span className="sr-only">Checking what needs you…</span>
      <PhilSkeleton className="mb-3 h-4 w-24" />
      <div className="space-y-2">
        <PhilSkeleton className="h-12 w-full rounded-card" />
        <PhilSkeleton className="h-12 w-full rounded-card" />
      </div>
    </section>
  );
}

/**
 * Load snagsV2 for each assigned job and aggregate into the "Needs you" feed
 * input. snagsV2 is job-scoped (GET /api/snags?jobId=), so this fetches per
 * assigned job in parallel and FAILS SOFT per job — a job whose snags can't be
 * read is skipped, never an error that blanks the feed. The pure selector
 * (buildPhilNeedsYou) then keeps only snags assigned to THIS worker that are
 * still open / in progress. Workers have a handful of assigned jobs, so this is
 * a small, bounded fan-out.
 */
export async function loadAssignedSnags(
  jobs: ReadonlyArray<{ id: string; name: string }>,
  cookieValue: string | undefined,
): Promise<JobSnags[]> {
  if (jobs.length === 0) return [];
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";

  const results = await Promise.all(
    jobs.map(async (job): Promise<JobSnags | null> => {
      try {
        const res = await fetch(`${base}/api/snags?jobId=${encodeURIComponent(job.id)}`, {
          cache: "no-store",
          headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
        });
        if (!res.ok) return null;
        const parsed = SnagListResponseSchema.safeParse(await res.json());
        if (!parsed.success) return null;
        return { jobId: job.id, jobName: job.name, snags: parsed.data.snags };
      } catch {
        return null;
      }
    }),
  );
  return results.filter((r): r is JobSnags => r !== null);
}

/**
 * Expiring/expired calibrations on gear THIS worker holds (#305), from
 * GET /api/tags-expiring (the shared compliance computation). The endpoint
 * already filters calibrations to the caller's held gear for non-admin viewers.
 * FAILS SOFT: any error → empty list, never a blanked feed.
 */
export async function loadHeldCalibrations(
  cookieValue: string | undefined,
): Promise<ExpiringCalibration[]> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";

  try {
    const res = await fetch(`${base}/api/tags-expiring`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (!res.ok) return [];
    const parsed = TagsExpiringCalibrationsResponseSchema.safeParse(await res.json());
    if (!parsed.success) return [];
    return parsed.data.calibrations ?? [];
  } catch {
    return [];
  }
}
