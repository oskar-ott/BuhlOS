import { redirect, notFound } from "next/navigation";
import type { Route } from "next";
import { cookies } from "next/headers";
import { MapPin } from "lucide-react";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { landingFor } from "@/lib/auth/landing";
import { originFromRequest } from "@/lib/auth/current-user";
import { PortalShell } from "@/components/portal/PortalShell";
import { PortalProgress } from "../../PortalProgress";
import { PortalJobResponseSchema, type PortalJob } from "@/domains/client-portal/schema";

export const dynamic = "force-dynamic";

/**
 * A single sanitised job overview in the client portal (#271 / Epic 16).
 *
 * Isolation is the point: the sanitised /api/portal-job endpoint 404s for any
 * job this client doesn't own (another client's job, a guessed id, a
 * draft/archived job) — so a 404 from the API becomes notFound() here. The page
 * never sees, and so can never leak, a job outside the client's own.
 *
 * Read-only, conservative overview: name, site address, overall progress and a
 * coarse stage word. Photos, milestones, documents and variations are
 * DEFERRED to the named follow-on children (#274 / #277 / #287 / #279).
 */
export default async function PortalJobPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=/portal/jobs/${jobId}` as Route);
  }
  if (!canAccessSurface(session.role, "portal")) {
    redirect(landingFor(session.role) as Route);
  }

  const job = await loadJob(raw, jobId);
  // A missing / other-client / draft job comes back null (the API 404s) — render
  // the standard not-found, never a "you don't own this" that confirms the id.
  if (!job) notFound();

  return (
    <PortalShell title={job.name} backHref="/portal" backLabel="All projects">
      <section className="rounded-card border border-border bg-surface-raised p-5 shadow-card">
        <h2 className="font-display text-xl text-text">{job.name}</h2>
        {job.siteAddress ? (
          <p className="mt-1 flex items-center gap-1.5 text-sm text-text-muted">
            <MapPin aria-hidden="true" className="h-4 w-4 shrink-0" />
            {job.siteAddress}
          </p>
        ) : null}
        <div className="mt-5">
          <PortalProgress progressPct={job.progressPct} stageLabel={job.stageLabel} />
        </div>
      </section>

      <p className="px-1 text-xs text-text-muted">
        This is a high-level view. Your builder will share photos and more detail
        here as your project progresses.
      </p>
    </PortalShell>
  );
}

async function loadJob(
  cookieValue: string | undefined,
  jobId: string,
): Promise<PortalJob | null> {
  try {
    const base = await originFromRequest();
    const res = await fetch(`${base}/api/portal-job?jobId=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    // 404 (not owned / not found / draft) → null → notFound(). Any other
    // non-OK is treated the same conservative way: no job, no leak.
    if (!res.ok) return null;
    const parsed = PortalJobResponseSchema.safeParse(await res.json());
    if (!parsed.success) return null;
    return parsed.data.job;
  } catch {
    return null;
  }
}
