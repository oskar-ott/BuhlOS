import { notFound, redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { PhilShell } from "@/components/phil/PhilShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { PhilPageIntro } from "@/components/phil/ui/PhilPageIntro";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { PhilBackLink } from "@/components/phil/ui/PhilBackLink";
import { PhilSafetyDocs } from "@/components/phil/PhilSafetyDocs";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { JobDetailResponseSchema } from "@/domains/jobs/schema";
import { SafetyDocsResponseSchema, type SafetyDoc } from "@/domains/safety-docs/schema";
import type { Job } from "@/domains/jobs/types";
import { isFlagEnabled } from "../../../../../../api/_lib/feature-flags.js";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string }>;
}

/**
 * /phil/jobs/[jobId]/safety — field side of safety documents (#219).
 *
 * The worker reads each SWMS / SDS and taps "I've read this". SERVER component
 * (the doc rule) — the interactive acknowledge UI is <PhilSafetyDocs/>. Gated
 * DARK behind `safety_docs`: 404s when off so the route is invisible.
 */
export default async function PhilSafetyPage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/phil/jobs/${jobId}/safety`)}`);
  }
  if (!canAccessSurface(session.role, "phil")) {
    redirect("/v2/login");
  }
  if (!(await isFlagEnabled("safety_docs", session))) {
    notFound();
  }

  const [jobResult, safetyResult] = await Promise.all([
    loadJob(raw, jobId),
    loadSafety(raw, jobId),
  ]);

  if (jobResult.kind === "not_found" || jobResult.kind === "forbidden") {
    return (
      <PhilShell title="Safety">
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
      <PhilShell title="Safety">
        <div className="space-y-4">
          <PhilBackLink href={`/phil/jobs/${encodeURIComponent(jobId)}`}>Back to job</PhilBackLink>
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
    <PhilShell title={`Safety · ${jobResult.job.name}`}>
      <div className="space-y-4">
        <PhilBackLink href={`/phil/jobs/${encodeURIComponent(jobId)}`}>Back to job</PhilBackLink>
        <PhilPageIntro
          title="Safety"
          description="Read each document, then tap “I’ve read this”. The office keeps the record."
        />
        <PhilSafetyDocs
          jobId={jobId}
          initialDocuments={safetyResult.kind === "ok" ? safetyResult.documents : []}
          initialAckedIds={safetyResult.kind === "ok" ? safetyResult.acknowledgedDocIds : []}
          fetchError={safetyResult.kind === "error" ? safetyResult.message : null}
        />
      </div>
    </PhilShell>
  );
}

function apiBase(host: string | null, proto: string): string {
  return host ? `${proto}://${host}` : "http://localhost:3000";
}

type JobLoad =
  | { kind: "ok"; job: Job }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

async function loadJob(cookieValue: string | undefined, jobId: string): Promise<JobLoad> {
  const h = await headers();
  const base = apiBase(
    h.get("x-forwarded-host") ?? h.get("host"),
    h.get("x-forwarded-proto") ?? "http"
  );
  try {
    const res = await fetch(`${base}/api/jobs?id=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (res.status === 404) return { kind: "not_found" };
    if (res.status === 403) return { kind: "forbidden" };
    if (!res.ok) return { kind: "error", message: `API returned ${res.status}` };
    const parsed = JobDetailResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { kind: "error", message: "Unexpected response shape" };
    return { kind: "ok", job: parsed.data.job };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : "Network error" };
  }
}

type SafetyLoad =
  | { kind: "ok"; documents: SafetyDoc[]; acknowledgedDocIds: string[] }
  | { kind: "error"; message: string };

async function loadSafety(cookieValue: string | undefined, jobId: string): Promise<SafetyLoad> {
  const h = await headers();
  const base = apiBase(
    h.get("x-forwarded-host") ?? h.get("host"),
    h.get("x-forwarded-proto") ?? "http"
  );
  try {
    const res = await fetch(`${base}/api/safety-docs?jobId=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (!res.ok) {
      return res.status === 403
        ? { kind: "ok", documents: [], acknowledgedDocIds: [] }
        : { kind: "error", message: `Safety API ${res.status}` };
    }
    const parsed = SafetyDocsResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { kind: "error", message: "Unexpected safety response" };
    return {
      kind: "ok",
      documents: parsed.data.documents,
      acknowledgedDocIds: parsed.data.acknowledgedDocIds ?? [],
    };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : "Network error" };
  }
}
