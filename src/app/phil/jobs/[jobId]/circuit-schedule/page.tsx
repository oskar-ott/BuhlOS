import { notFound, redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { PhilShell } from "@/components/phil/PhilShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { PhilPageIntro } from "@/components/phil/ui/PhilPageIntro";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { PhilBackLink } from "@/components/phil/ui/PhilBackLink";
import { PhilCircuitSchedule } from "@/components/phil/PhilCircuitSchedule";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { isFlagEnabled } from "../../../../../../api/_lib/feature-flags.js";
import { JobDetailResponseSchema } from "@/domains/jobs/schema";
import { CircuitBoardsResponseSchema, type Board } from "@/domains/circuit-schedule/schema";
import type { Job } from "@/domains/jobs/types";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string }>;
}

/**
 * /phil/jobs/[jobId]/circuit-schedule — the field circuit schedule (Phil).
 *
 * The on-site electrician owns the same schedule the office builds: see the
 * boards and ways, mark each way to-do → installed → tested, and add / edit /
 * delete boards and ways. One shared store (the `boards` facet of
 * /api/job-circuits); the server gates writes to an assigned, non-client worker.
 *
 * Server component (doc 24 D-26): gates access, fetches job + boards forwarding
 * the cookie, renders PhilShell + the interactive client. Mirrors the Plans
 * sub-route precedent.
 */
export default async function PhilCircuitSchedulePage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/phil/jobs/${jobId}/circuit-schedule`)}`);
  }
  if (!canAccessSurface(session.role, "phil")) {
    redirect("/v2/login");
  }
  // #760: circuit-schedule kill-switch — when the owner turns it off, 404.
  if (!(await isFlagEnabled("circuit_schedule", session))) {
    notFound();
  }

  const [jobResult, boardsResult] = await Promise.all([
    loadJob(raw, jobId),
    loadBoards(raw, jobId),
  ]);

  if (jobResult.kind === "not_found" || jobResult.kind === "forbidden") {
    return (
      <PhilShell title="Circuit schedule">
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
      <PhilShell title="Circuit schedule">
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
    <PhilShell title={`Circuit schedule · ${jobResult.job.name}`}>
      <div className="space-y-4">
        <PhilBackLink href={`/phil/jobs/${encodeURIComponent(jobId)}`}>Back to job</PhilBackLink>
        <PhilPageIntro
          title="Circuit schedule"
          description="The boards and ways for this job. Mark each way as you go — to do, installed, tested."
        />
        <PhilCircuitSchedule
          jobId={jobId}
          jobName={jobResult.job.name}
          initialBoards={boardsResult.boards}
          loadError={boardsResult.error}
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

async function apiBase(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  return host ? `${proto}://${host}` : "http://localhost:3000";
}

function cookieHeader(value: string | undefined): HeadersInit | undefined {
  return value ? { cookie: `${SESSION_COOKIE}=${value}` } : undefined;
}

async function loadJob(cookieValue: string | undefined, jobId: string): Promise<JobLoad> {
  const base = await apiBase();
  try {
    const res = await fetch(`${base}/api/jobs?id=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
      headers: cookieHeader(cookieValue),
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

async function loadBoards(
  cookieValue: string | undefined,
  jobId: string,
): Promise<{ boards: Board[]; error: string | null }> {
  const base = await apiBase();
  try {
    const res = await fetch(`${base}/api/job-circuits?jobId=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
      headers: cookieHeader(cookieValue),
    });
    if (!res.ok) {
      return { boards: [], error: res.status === 403 ? null : `Schedule API returned ${res.status}` };
    }
    const parsed = CircuitBoardsResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { boards: [], error: "Couldn’t read the circuit schedule." };
    return { boards: parsed.data.boards, error: null };
  } catch (err) {
    return { boards: [], error: err instanceof Error ? err.message : "Schedule network error" };
  }
}
