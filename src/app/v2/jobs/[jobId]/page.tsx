import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { Eye, KeyRound, Lock, MapPin, PencilRuler, Phone, ShieldAlert, Squircle, User } from "lucide-react";
import type { Route } from "next";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { JobInterfaceSectionNav } from "@/components/admin/JobInterfaceSectionNav";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { JobDetailResponseSchema } from "@/domains/jobs/schema";
import { hasSiteContext, statusLabel, statusTone } from "@/domains/jobs/format";
import { isVisibleToField, summariseStructure } from "@/domains/jobs/builder";
import type { Job } from "@/domains/jobs/types";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string }>;
}

/**
 * /v2/jobs/[jobId] &mdash; Admin Job Interface hub.
 *
 * The job-level landing for admins. Replaces "click an evidence chip"
 * as the only way to land on a per-job admin surface; lets admins see
 * every section in one place and tap into the live ones.
 *
 * Sections rendered here:
 *   - Overview header: job name, ref, type, status pill, archived badge
 *   - Site context: address / contact / access / parking / safety / induction
 *   - Section nav: Evidence (live) / Snags (live) / ITP (UC) / Documents (UC)
 *     / Materials (UC) / History (UC)
 *
 * Live counts on the section nav come from /api/jobs?withStats=1
 * (statsEvidenceV2Pending, statsSnagsV2Active &mdash; statsItpsActive is
 * already on the API post-E1a but the ITP section row stays UC until
 * E1b/E1c ship the matching UI).
 *
 * This page does NOT replace the /v2/jobs/[jobId]/evidence and /snags
 * routes &mdash; it adds a parent hub. JobsList row chips still deep-link
 * past the hub into evidence/snags so power users keep their one-tap path.
 *
 * Cross-ref:
 *   src/app/v2/jobs/[jobId]/snags/page.tsx &mdash; per-section page precedent
 *   src/app/v2/jobs/[jobId]/evidence/page.tsx &mdash; same
 *   src/components/phil/PhilJobDetail.tsx &mdash; Phil-side mirror of the
 *       same sections (with UC stubs)
 *   docs/rebuild-audit/35-current-product-state-audit.md §7.2 + §13
 */
export default async function AdminJobInterfacePage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/v2/jobs/${jobId}`)}`);
  }
  // Defence-in-depth &mdash; middleware also gates /v2/jobs/* to the
  // admin-or-LH surface.
  if (!canAccessSurface(session.role, "lh")) {
    redirect("/v2/login");
  }
  const canBuild = canAccessSurface(session.role, "admin");

  const result = await loadJob(raw, jobId);

  if (result.kind === "not_found" || result.kind === "forbidden") {
    return (
      <AdminShell
        title="Job"
        breadcrumb={
          <Link
            href="/v2/jobs"
            className="underline decoration-accent-yellow decoration-2 underline-offset-2"
          >
            ← Jobs
          </Link>
        }
      >
        <div className="mx-auto max-w-4xl space-y-4">
          <Card>
            <CardTitle>This job isn&rsquo;t available</CardTitle>
            <CardDescription className="mt-2">
              {result.kind === "forbidden"
                ? "You don't have access to this job. If you should, ask Karen or Daniel to add you."
                : "We couldn't find that job. It may have been archived or the link is stale."}
            </CardDescription>
          </Card>
        </div>
      </AdminShell>
    );
  }

  if (result.kind === "error") {
    return (
      <AdminShell
        title="Job"
        breadcrumb={
          <Link
            href="/v2/jobs"
            className="underline decoration-accent-yellow decoration-2 underline-offset-2"
          >
            ← Jobs
          </Link>
        }
      >
        <div className="mx-auto max-w-4xl space-y-4">
          <Card className="border-amber-200 bg-amber-50" role="alert">
            <CardTitle>Couldn&rsquo;t load this job</CardTitle>
            <CardDescription className="text-amber-900">
              {result.message}. Try again in a moment.
            </CardDescription>
          </Card>
        </div>
      </AdminShell>
    );
  }

  const job = result.job;

  return (
    <AdminShell
      title={job.name}
      breadcrumb={
        <Link
          href="/v2/jobs"
          className="underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          ← Jobs
        </Link>
      }
    >
      <div className="mx-auto max-w-4xl space-y-4">
        <JobHeaderCard job={job} />
        <JobBuildCard job={job} canBuild={canBuild} />
        {hasSiteContext(job) ? <SiteContextCard job={job} /> : null}
        <JobInterfaceSectionNav job={job} />
      </div>
    </AdminShell>
  );
}

function JobHeaderCard({ job }: { job: Job }) {
  const subline = [job.ref && `Ref ${job.ref}`, job.typeName].filter(Boolean).join(" · ");
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="break-words">{job.name}</CardTitle>
          {subline ? (
            <CardDescription className="mt-1">{subline}</CardDescription>
          ) : null}
          {job.siteAddress ? (
            <p className="mt-2 text-sm text-text-muted">{job.siteAddress}</p>
          ) : null}
        </div>
        <Pill tone={statusTone(job.status)}>{statusLabel(job.status)}</Pill>
      </div>
    </Card>
  );
}

function JobBuildCard({ job, canBuild }: { job: Job; canBuild: boolean }) {
  const s = summariseStructure(job);
  const fieldVisible = isVisibleToField(job);
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>Build &amp; publish</CardTitle>
          <CardDescription className="mt-1">
            {fieldVisible ? (
              <span className="inline-flex items-center gap-1 text-emerald-700">
                <Eye aria-hidden="true" className="h-3.5 w-3.5" /> Published — visible
                to assigned field workers.
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <Lock aria-hidden="true" className="h-3.5 w-3.5" /> Office-only — not
                yet published to the field.
              </span>
            )}
          </CardDescription>
        </div>
        {canBuild ? (
          <a
            href={`/v2/jobs/${encodeURIComponent(job.id)}/builder` as Route}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-card bg-brand-navy px-3 py-2 text-sm font-medium text-text-inverse transition-colors hover:bg-accent-ink focus:outline-none focus:ring-2 focus:ring-brand-navy"
          >
            <PencilRuler aria-hidden="true" className="h-4 w-4" /> Open builder
          </a>
        ) : null}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <StructureStat label="Area groups" value={s.areaGroupCount} />
        <StructureStat label="Areas" value={s.areaCount} />
        <StructureStat label="Rough-in tasks" value={s.roughInTaskCount} />
        <StructureStat label="Fit-off tasks" value={s.fitOffTaskCount} />
      </dl>
    </Card>
  );
}

function StructureStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-card border border-border bg-surface px-3 py-2">
      <div className="font-display text-lg text-text">{value}</div>
      <div className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
        {label}
      </div>
    </div>
  );
}

function SiteContextCard({ job }: { job: Job }) {
  return (
    <Card>
      <CardTitle>Site</CardTitle>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
        {job.siteAddress ? (
          <SiteField icon={<MapPin className="h-4 w-4" />} label="Address">
            {job.siteAddress}
          </SiteField>
        ) : null}
        {(job.siteContactName?.trim() || job.siteContactPhone?.trim()) ? (
          <SiteField icon={<User className="h-4 w-4" />} label="Contact">
            <span className="block">{job.siteContactName?.trim() || "—"}</span>
            {job.siteContactPhone?.trim() ? (
              <span className="mt-0.5 inline-flex items-center gap-1 text-text-muted">
                <Phone aria-hidden="true" className="h-3.5 w-3.5" />
                <a
                  href={`tel:${job.siteContactPhone.replace(/\s+/g, "")}`}
                  className="underline decoration-accent-yellow decoration-2 underline-offset-2"
                >
                  {job.siteContactPhone.trim()}
                </a>
              </span>
            ) : null}
          </SiteField>
        ) : null}
        {job.accessNotes ? (
          <SiteField icon={<KeyRound className="h-4 w-4" />} label="Access">
            {job.accessNotes}
          </SiteField>
        ) : null}
        {job.parkingNotes ? (
          <SiteField icon={<Squircle className="h-4 w-4" />} label="Parking">
            {job.parkingNotes}
          </SiteField>
        ) : null}
        {job.safetyNotes ? (
          <SiteField icon={<ShieldAlert className="h-4 w-4" />} label="Safety">
            {job.safetyNotes}
          </SiteField>
        ) : null}
      </dl>
      {job.inductionRequired ? (
        <div className="mt-3 rounded-card border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-display font-semibold">Site induction required</p>
          <p className="mt-0.5 text-xs">
            Confirm with the leading hand before sending the crew on site.
          </p>
        </div>
      ) : null}
    </Card>
  );
}

function SiteField({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <span aria-hidden="true" className="mt-0.5 shrink-0 text-text-muted">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <dt className="font-display text-[11px] uppercase tracking-wider text-text-muted">
          {label}
        </dt>
        <dd className="mt-0.5 whitespace-pre-line break-words text-text">
          {children}
        </dd>
      </div>
    </div>
  );
}

type LoadResult =
  | { kind: "ok"; job: Job }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

async function loadJob(
  cookieValue: string | undefined,
  jobId: string
): Promise<LoadResult> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    // withStats=1 so the section nav can show evidence + snag counts on
    // the live rows. statsItpsActive is also enriched by the API
    // post-E1a (PR #34) but the ITP row stays UC until E1b/E1c.
    const res = await fetch(
      `${base}/api/jobs?id=${encodeURIComponent(jobId)}&withStats=1`,
      {
        cache: "no-store",
        headers: cookieValue
          ? { cookie: `${SESSION_COOKIE}=${cookieValue}` }
          : undefined,
      }
    );
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
