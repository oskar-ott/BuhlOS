import { notFound, redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { isFlagEnabled } from "../../../../../../../api/_lib/feature-flags.js";
import { PhilShell } from "@/components/phil/PhilShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { ITPRecording } from "@/components/phil/ITPRecording";
import { PhilItpSharpened } from "@/components/phil/PhilItpSharpened";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { PhilBackLink } from "@/components/phil/ui/PhilBackLink";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { philInitials, philSharpenedFlags } from "@/lib/phil/sharpened";
import { JobDetailResponseSchema } from "@/domains/jobs/schema";
import { ITPListResponseSchema } from "@/domains/itp/schema";
import { SnagListResponseSchema } from "@/domains/snags/schema";
import type { Job } from "@/domains/jobs/types";
import type { ITPInstance } from "@/domains/itp/types";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string; instanceId: string }>;
}

/**
 * /phil/jobs/[jobId]/itps/[instanceId] — Phil per-instance ITP recording
 * surface (Phase E1b).
 *
 * Server component:
 *   1. Gates auth + Phil-surface access (middleware also gates the
 *      /phil/jobs/* prefix).
 *   2. Fetches /api/jobs?id=<jobId> and /api/job-itps?jobId=<jobId> in
 *      parallel, forwarding the session cookie. Both must succeed +
 *      the requested instance must exist on that job.
 *   3. Branches on the response:
 *        - 200 + instance found → render <ITPRecording />
 *        - 403 / 404 → "not yours" card with a link back to /phil/jobs
 *        - other → non-blocking error card
 *
 * Cross-ref:
 *   src/app/phil/jobs/[jobId]/page.tsx — D1 precedent
 *   src/components/phil/ITPRecording.tsx — client orchestrator
 *   docs/rebuild-audit/33-phase-e-build-prompts.md §E1b
 *
 * Architecture rule (doc 24 D-26): this page is a SERVER component. No
 * `"use client"` here — client components live under
 * `src/components/phil/`.
 */
export default async function PhilItpRecordingPage({ params }: PageParams) {
  const { jobId, instanceId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(
      `/v2/login?next=${encodeURIComponent(`/phil/jobs/${jobId}/itps/${instanceId}`)}`,
    );
  }
  if (!canAccessSurface(session.role, "phil")) {
    redirect("/v2/login");
  }
  // #760: ITP kill-switch — the field recording route 404s when ITPs are off.
  if (!(await isFlagEnabled("itp", session))) {
    notFound();
  }

  const [jobResult, itpsResult, sharpenedFlags] = await Promise.all([
    loadJob(raw, jobId),
    loadItps(raw, jobId),
    // Sharpened-chrome flag (cached flags.json read) — server-resolved boolean.
    philSharpenedFlags(session),
  ]);
  const accountInitials = philInitials(session.name ?? session.username);

  if (jobResult.kind === "not_found" || jobResult.kind === "forbidden") {
    return (
      <PhilShell
        title="ITP"
        sharpened={sharpenedFlags.sharpened}
        rfiRegister={sharpenedFlags.rfiRegister}
        jobRoomsEnabled={sharpenedFlags.jobRooms}
        accountInitials={accountInitials}
      >
        <div className="space-y-4">
          <PhilBackLink href="/phil/jobs">All jobs</PhilBackLink>
          <Card>
            <CardTitle>This job isn&rsquo;t assigned to you</CardTitle>
            <CardDescription className="mt-2">
              {jobResult.kind === "forbidden"
                ? "You don't have access to this job. If you should, ask your PM."
                : "We couldn't find that job. It may have been archived."}
            </CardDescription>
          </Card>
        </div>
      </PhilShell>
    );
  }

  if (jobResult.kind === "error" || itpsResult.kind === "error") {
    const message =
      jobResult.kind === "error"
        ? jobResult.message
        : itpsResult.kind === "error"
          ? itpsResult.message
          : "Network error";
    return (
      <PhilShell
        title="ITP"
        sharpened={sharpenedFlags.sharpened}
        rfiRegister={sharpenedFlags.rfiRegister}
        jobRoomsEnabled={sharpenedFlags.jobRooms}
        accountInitials={accountInitials}
      >
        <div className="space-y-4">
          <PhilBackLink href={`/phil/jobs/${encodeURIComponent(jobId)}`}>
            Back to job
          </PhilBackLink>
          <PhilNotice tone="warning" title="Couldn’t load this ITP" role="alert">
            {message}. Try again in a moment.
          </PhilNotice>
        </div>
      </PhilShell>
    );
  }

  const instance = itpsResult.instances.find((i) => i.id === instanceId);
  if (!instance) {
    return (
      <PhilShell
        title="ITP"
        sharpened={sharpenedFlags.sharpened}
        rfiRegister={sharpenedFlags.rfiRegister}
        jobRoomsEnabled={sharpenedFlags.jobRooms}
        accountInitials={accountInitials}
      >
        <div className="space-y-4">
          <PhilBackLink href={`/phil/jobs/${encodeURIComponent(jobId)}`}>
            Back to job
          </PhilBackLink>
          <Card>
            <CardTitle>ITP not found</CardTitle>
            <CardDescription className="mt-2">
              This ITP isn&rsquo;t on this job anymore. It may have been
              archived. Head back to the job to see what&rsquo;s active.
            </CardDescription>
          </Card>
        </div>
      </PhilShell>
    );
  }

  const viewer = {
    id: session.userId ?? session.sub ?? "",
    role: String(session.role ?? ""),
  };

  // ── Sharpened Checks/ITP detail (phil_sharpened, dark — Wave 4a) ─────────
  // Same instance + same writers, re-skinned per §2.8: title block, the real
  // sign-off chain, required-proof projection, the existing point cards, and
  // a sticky submit-for-review primary. The snags read feeds the honest
  // "Snag raised" tag (#520 origin links); when it fails, the tag simply
  // doesn't render (never fabricated). Flag off falls through below,
  // byte-identical.
  if (sharpenedFlags.sharpened) {
    const snagPointIds = await loadItpSnagPointIds(raw, jobId, instanceId);
    return (
      <PhilShell
        title={instance.templateSnapshot?.name?.trim() || "ITP"}
        sharpened
        rfiRegister={sharpenedFlags.rfiRegister}
        jobRoomsEnabled={sharpenedFlags.jobRooms}
        accountInitials={accountInitials}
      >
        <PhilItpSharpened
          job={jobResult.job}
          instance={instance}
          viewer={viewer}
          initialSnagPointIds={snagPointIds}
        />
      </PhilShell>
    );
  }

  return (
    <PhilShell
      title={instance.templateSnapshot?.name?.trim() || "ITP"}
      // This branch renders only while phil_sharpened is OFF — pass the
      // resolved (false) flags explicitly so the chrome memory is refreshed
      // rather than consulted (philChromeMemory.ts: flag-off pages write
      // false; render is unchanged).
      sharpened={sharpenedFlags.sharpened}
      rfiRegister={sharpenedFlags.rfiRegister}
      jobRoomsEnabled={sharpenedFlags.jobRooms}
      accountInitials={accountInitials}
    >
      <ITPRecording job={jobResult.job} instance={instance} viewer={viewer} />
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
    const res = await fetch(
      `${base}/api/jobs?id=${encodeURIComponent(jobId)}`,
      {
        cache: "no-store",
        headers: cookieValue
          ? { cookie: `${SESSION_COOKIE}=${cookieValue}` }
          : undefined,
      },
    );
    if (res.status === 404) return { kind: "not_found" };
    if (res.status === 403) return { kind: "forbidden" };
    if (!res.ok) return { kind: "error", message: `Jobs API ${res.status}` };
    const body = await res.json();
    const parsed = JobDetailResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { kind: "error", message: "Unexpected jobs response" };
    }
    return { kind: "ok", job: parsed.data.job };
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Network error",
    };
  }
}

type ItpsLoad =
  | { kind: "ok"; instances: ITPInstance[] }
  | { kind: "error"; message: string };

async function loadItps(
  cookieValue: string | undefined,
  jobId: string,
): Promise<ItpsLoad> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(
      `${base}/api/job-itps?jobId=${encodeURIComponent(jobId)}`,
      {
        cache: "no-store",
        headers: cookieValue
          ? { cookie: `${SESSION_COOKIE}=${cookieValue}` }
          : undefined,
      },
    );
    if (!res.ok) return { kind: "error", message: `ITPs API ${res.status}` };
    const body = await res.json();
    const parsed = ITPListResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { kind: "error", message: "Unexpected ITPs response" };
    }
    return { kind: "ok", instances: [...parsed.data.instances] };
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Network error",
    };
  }
}

/**
 * Point ids on this instance that already have a snag raised from them —
 * the real #520 origin links (snag.itpInstanceId / snag.itpPointId), read
 * from the same /api/snags list the job snag panel uses. Sharpened-only
 * (one extra read, flag-gated) and NON-FATAL: any failure returns [] so
 * the screen renders without the tag rather than erroring or inventing one.
 */
async function loadItpSnagPointIds(
  cookieValue: string | undefined,
  jobId: string,
  instanceId: string,
): Promise<string[]> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(
      `${base}/api/snags?jobId=${encodeURIComponent(jobId)}`,
      {
        cache: "no-store",
        headers: cookieValue
          ? { cookie: `${SESSION_COOKIE}=${cookieValue}` }
          : undefined,
      },
    );
    if (!res.ok) return [];
    const body = await res.json();
    const parsed = SnagListResponseSchema.safeParse(body);
    if (!parsed.success) return [];
    const ids = new Set<string>();
    for (const snag of parsed.data.snags) {
      if (snag.itpInstanceId === instanceId && snag.itpPointId) {
        ids.add(snag.itpPointId);
      }
    }
    return [...ids];
  } catch {
    return [];
  }
}
