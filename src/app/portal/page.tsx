import { redirect } from "next/navigation";
import type { Route } from "next";
import { cookies } from "next/headers";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { landingFor } from "@/lib/auth/landing";
import { originFromRequest } from "@/lib/auth/current-user";
import { PortalShell } from "@/components/portal/PortalShell";
import { PortalJobsResponseSchema, type PortalJob } from "@/domains/client-portal/schema";
import { PortalJobCard } from "./PortalJobCard";

export const dynamic = "force-dynamic";

/**
 * Client portal home (#271 / Epic 16).
 *
 * A signed-in client lands here (by navigation for now — landingFor still sends
 * clients to the kept static /client until the cutover PR) and sees ONLY their
 * own active jobs, each a tappable card with an overall progress bar.
 *
 * Server-gated: a non-client role is bounced to their own landing; an
 * unauthenticated visitor is sent to /v2/login?next=/portal (matching the
 * middleware, which also gates this route). Every byte rendered comes from the
 * sanitised /api/portal-jobs endpoint — never the raw job payload.
 */
export default async function PortalHomePage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/portal" as Route);
  }
  if (!canAccessSurface(session.role, "portal")) {
    // Wrong surface — send them to their own landing (admin → command centre,
    // field → Phil). Never leak the portal to a non-client.
    redirect(landingFor(session.role) as Route);
  }

  const { jobs, error } = await loadJobs(raw);

  return (
    <PortalShell title="Your projects">
      {error ? (
        <div className="rounded-card border border-border bg-surface-raised p-5 text-sm text-text-muted">
          We couldn&rsquo;t load your projects just now. Please try again shortly.
        </div>
      ) : jobs.length === 0 ? (
        <div className="rounded-card border border-border bg-surface-raised p-6 text-center">
          <p className="text-sm font-semibold text-text">No active projects yet</p>
          <p className="mt-1 text-sm text-text-muted">
            When your builder starts a project for you, it&rsquo;ll appear here.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {jobs.map((job) => (
            <li key={job.id}>
              <PortalJobCard job={job} />
            </li>
          ))}
        </ul>
      )}
    </PortalShell>
  );
}

async function loadJobs(
  cookieValue: string | undefined,
): Promise<{ jobs: PortalJob[]; error: string | null }> {
  try {
    const base = await originFromRequest();
    const res = await fetch(`${base}/api/portal-jobs`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (!res.ok) {
      return { jobs: [], error: `portal-jobs returned ${res.status}` };
    }
    const parsed = PortalJobsResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      return { jobs: [], error: "unexpected portal-jobs shape" };
    }
    return { jobs: parsed.data.jobs, error: null };
  } catch (err) {
    return { jobs: [], error: err instanceof Error ? err.message : "network error" };
  }
}
