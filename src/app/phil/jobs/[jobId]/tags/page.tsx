import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { isFlagEnabled } from "../../../../../../api/_lib/feature-flags.js";
import { PhilShell } from "@/components/phil/PhilShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { TagRegisterClient } from "@/components/phil/TagRegisterClient";
import { PhilPageIntro } from "@/components/phil/ui/PhilPageIntro";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { PhilBackLink } from "@/components/phil/ui/PhilBackLink";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { JobDetailResponseSchema } from "@/domains/jobs/schema";
import { TagListResponseSchema, type TagItem } from "@/domains/tags/schema";
import type { Job } from "@/domains/jobs/types";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string }>;
}

/**
 * /phil/jobs/[jobId]/tags — the per-job Test & Tag register (#388).
 *
 * Rebuilds the surface the legacy cutover deleted, over the untouched
 * api/tags.js. Server component mirrors the plans sub-route precedent:
 *   1. Gates auth + Phil-surface access (middleware also gates /phil/jobs/*).
 *   2. Fetches /api/jobs?id= + /api/tags?jobId= in parallel with the
 *      session cookie; the tags API re-checks job visibility per caller.
 *   3. Hands the register to <TagRegisterClient /> (photo → OCR → confirm,
 *      manual entry, edit/delete — server-side canWrite is the write gate).
 *
 * Cross-ref:
 *   src/app/phil/jobs/[jobId]/plans/page.tsx — sub-route precedent
 *   api/tags.js — register storage + OCR
 */
export default async function PhilTagsPage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/phil/jobs/${jobId}/tags`)}`);
  }
  if (!canAccessSurface(session.role, "phil")) {
    redirect("/v2/login");
  }

  // observations_inbox gates the Capture launcher's observation options
  // (server-resolved boolean for the shell's FAB sheet).
  const [jobResult, tagsResult, observationsEnabled] = await Promise.all([
    loadJob(raw, jobId),
    loadTags(raw, jobId),
    isFlagEnabled("observations_inbox", session),
  ]);

  if (jobResult.kind === "not_found" || jobResult.kind === "forbidden") {
    return (
      <PhilShell title="Test & tag" observationsEnabled={observationsEnabled}>
        <div className="space-y-4">
          <PhilBackLink href="/phil/jobs">All jobs</PhilBackLink>
          <Card>
            <CardTitle>This job isn&rsquo;t assigned to you</CardTitle>
            <CardDescription className="mt-2">
              {jobResult.kind === "forbidden"
                ? "You don't have access to this job. If you should, ask your PM to add you."
                : "We couldn't find that job. It may have been archived or the link is out of date."}
            </CardDescription>
          </Card>
        </div>
      </PhilShell>
    );
  }

  if (jobResult.kind === "error") {
    return (
      <PhilShell title="Test & tag" observationsEnabled={observationsEnabled}>
        <div className="space-y-4">
          <PhilBackLink href={`/phil/jobs/${encodeURIComponent(jobId)}`}>
            Back to job
          </PhilBackLink>
          <PhilNotice tone="warning" title="Couldn’t load this job" role="alert">
            <p>{jobResult.message}.</p>
            <div className="mt-3">
              <RefreshButton />
            </div>
          </PhilNotice>
        </div>
      </PhilShell>
    );
  }

  return (
    <PhilShell
      title={`Test & tag · ${jobResult.job.name}`}
      observationsEnabled={observationsEnabled}
    >
      <div className="space-y-4">
        <PhilBackLink href={`/phil/jobs/${encodeURIComponent(jobId)}`}>
          Back to job
        </PhilBackLink>
        <PhilPageIntro
          title="Test & tag register"
          description="Every tagged tool and lead on this job. Photograph a sticker to add one — you check the details before they're saved."
        />
        <TagRegisterClient
          jobId={jobId}
          initialTags={tagsResult.tags}
          fetchError={tagsResult.error}
        />
      </div>
    </PhilShell>
  );
}

type JobLoad =
  | { kind: "ok"; job: Job }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

async function loadJob(
  cookieValue: string | undefined,
  jobId: string,
): Promise<JobLoad> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(`${base}/api/jobs?id=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
      headers: cookieValue
        ? { cookie: `${SESSION_COOKIE}=${cookieValue}` }
        : undefined,
    });
    if (res.status === 404) return { kind: "not_found" };
    if (res.status === 403) return { kind: "forbidden" };
    if (!res.ok) return { kind: "error", message: `API returned ${res.status}` };
    const body = await res.json();
    const parsed = JobDetailResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { kind: "error", message: "Unexpected response shape" };
    }
    return { kind: "ok", job: parsed.data.job };
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Network error",
    };
  }
}

/** Fail-soft: a register that can't load renders an error banner, never a blank page. */
async function loadTags(
  cookieValue: string | undefined,
  jobId: string,
): Promise<{ tags: TagItem[]; error: string | null }> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(`${base}/api/tags?jobId=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
      headers: cookieValue
        ? { cookie: `${SESSION_COOKIE}=${cookieValue}` }
        : undefined,
    });
    if (!res.ok) {
      return { tags: [], error: `Tags API returned ${res.status}` };
    }
    const body = await res.json();
    const parsed = TagListResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { tags: [], error: "Unexpected tags response shape" };
    }
    return { tags: [...parsed.data.tags], error: null };
  } catch (err) {
    return {
      tags: [],
      error: err instanceof Error ? err.message : "Tags network error",
    };
  }
}
