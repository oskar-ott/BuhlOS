import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { PhotosGallery, type SourceLoadError } from "@/components/admin/PhotosGallery";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { JobDetailResponseSchema } from "@/domains/jobs/schema";
import { EvidenceListResponseSchema } from "@/domains/evidence/schema";
import {
  PhotoCatalogResponseSchema,
  type PhotoCatalogEntry,
} from "@/domains/evidence/photo-gallery";
import type { Job } from "@/domains/jobs/types";
import type { EvidenceItem } from "@/domains/evidence/types";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string }>;
}

/**
 * /v2/jobs/[jobId]/photos — read-only job photo gallery (#242, "Job Bible").
 *
 * Server component (clones the /evidence scaffold):
 *   1. Gates auth + admin/LH surface access (middleware also gates).
 *   2. Fetches /api/jobs?id=<jobId> (the job header + area names) +
 *      /api/evidence?jobId=<jobId> + GET /api/photos-catalog?jobId=<jobId> in
 *      one cookie-forwarded Promise.all.
 *   3. Renders AdminShell + <PhotosGallery />, a PURE READ projection over the
 *      already-shipped photo pipelines (evidence + snag + ITP/dwelling).
 *
 * Per-source degradation: a failed evidence or catalog fetch becomes an honest
 * "couldn't load … photos" banner inside the gallery (AC2) — never a silent
 * gap. The page still renders the sources that loaded.
 *
 * This surface is BROWSE-only: no capture, no tagging, no review actions (those
 * live on /evidence + /snags; Epic 10 owns tagging). EvidenceDrawer is reused
 * read-only for evidence photos; catalog-only photos link to their source.
 *
 * Cross-ref:
 *   src/app/v2/jobs/[jobId]/evidence/page.tsx — the cloned scaffold
 *   api/photos-catalog.js — the snag + dwelling/ITP catalog (read-only, gated)
 *   docs/route-ownership.md §5 — /v2/jobs/[jobId]/* transitional routes
 */
export default async function AdminJobPhotosPage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/v2/jobs/${jobId}/photos`)}`);
  }
  if (!canAccessSurface(session.role, "lh")) {
    // Middleware also gates; defence-in-depth if the matcher ever misses.
    redirect("/v2/login");
  }

  const [jobResult, evidenceResult, catalogResult] = await Promise.all([
    loadJob(raw, jobId),
    loadEvidence(raw, jobId),
    loadCatalog(raw, jobId),
  ]);

  if (jobResult.kind === "not_found" || jobResult.kind === "forbidden") {
    return (
      <AdminShell title="Photos">
        <div className="mx-auto max-w-4xl space-y-4">
          <Link
            href="/command-centre"
            className="inline-flex items-center gap-1 text-sm text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
          >
            ← Command Centre
          </Link>
          <Card>
            <CardTitle>This job isn&rsquo;t available</CardTitle>
            <CardDescription className="mt-2">
              {jobResult.kind === "forbidden"
                ? "You don't have access to this job."
                : "We couldn't find that job. It may have been archived or the link is stale."}
            </CardDescription>
          </Card>
        </div>
      </AdminShell>
    );
  }

  if (jobResult.kind === "error") {
    return (
      <AdminShell title="Photos">
        <div className="mx-auto max-w-4xl space-y-4">
          <Card className="border-amber-200 bg-amber-50" role="alert">
            <CardTitle>Couldn&rsquo;t load this job</CardTitle>
            <CardDescription className="text-amber-900">
              {jobResult.message}. Try again in a moment.
            </CardDescription>
          </Card>
        </div>
      </AdminShell>
    );
  }

  const areaNameById = buildAreaNameMap(jobResult.job);

  const sourceErrors: SourceLoadError[] = [];
  if (evidenceResult.error) {
    sourceErrors.push({ label: "evidence", message: evidenceResult.error });
  }
  if (catalogResult.error) {
    sourceErrors.push({
      label: "snag & ITP / dwelling",
      message: catalogResult.error,
    });
  }

  return (
    <AdminShell
      title={`Photos · ${jobResult.job.name}`}
      breadcrumb={
        <Link
          href={`/v2/jobs/${encodeURIComponent(jobId)}`}
          className="underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          ← Job
        </Link>
      }
    >
      <div className="mx-auto max-w-6xl">
        <PhotosGallery
          job={jobResult.job}
          evidence={evidenceResult.evidence}
          catalog={catalogResult.photos}
          sourceErrors={sourceErrors}
          areaNameById={areaNameById}
        />
      </div>
    </AdminShell>
  );
}

/** id→name for every area across the job's area groups, for the evidence
 *  provenance line. */
function buildAreaNameMap(job: Job): Record<string, string> {
  const map: Record<string, string> = {};
  const groups =
    (job as { areaGroups?: ReadonlyArray<{ areas?: ReadonlyArray<{ id: string; name: string }> }> })
      .areaGroups ?? [];
  for (const g of groups) {
    for (const a of g.areas ?? []) {
      if (a?.id) map[a.id] = a.name ?? a.id;
    }
  }
  return map;
}

async function apiBase(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  return host ? `${proto}://${host}` : "http://localhost:3000";
}

function cookieHeader(value: string | undefined): HeadersInit | undefined {
  return value ? { cookie: `${SESSION_COOKIE}=${value}` } : undefined;
}

type JobResult =
  | { kind: "ok"; job: Job }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

async function loadJob(
  cookieValue: string | undefined,
  jobId: string,
): Promise<JobResult> {
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

/**
 * Evidence photos + notes for this job. A failure surfaces as `error` (an
 * honest per-source banner) rather than blocking the gallery — the catalog
 * photos still render.
 */
async function loadEvidence(
  cookieValue: string | undefined,
  jobId: string,
): Promise<{ evidence: EvidenceItem[]; error: string | null }> {
  const base = await apiBase();
  try {
    const res = await fetch(`${base}/api/evidence?jobId=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
      headers: cookieHeader(cookieValue),
    });
    if (!res.ok) {
      return { evidence: [], error: `Evidence API returned ${res.status}` };
    }
    const parsed = EvidenceListResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      return { evidence: [], error: "Unexpected evidence response shape" };
    }
    return { evidence: parsed.data.evidence, error: null };
  } catch (err) {
    return { evidence: [], error: err instanceof Error ? err.message : "Network error" };
  }
}

/**
 * Snag + dwelling/ITP photos from the read-only catalog (api/photos-catalog.js).
 * Same per-source degradation as evidence.
 */
async function loadCatalog(
  cookieValue: string | undefined,
  jobId: string,
): Promise<{ photos: PhotoCatalogEntry[]; error: string | null }> {
  const base = await apiBase();
  try {
    const res = await fetch(
      `${base}/api/photos-catalog?jobId=${encodeURIComponent(jobId)}`,
      {
        cache: "no-store",
        headers: cookieHeader(cookieValue),
      },
    );
    if (!res.ok) {
      return { photos: [], error: `Catalog API returned ${res.status}` };
    }
    const parsed = PhotoCatalogResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      return { photos: [], error: "Unexpected catalog response shape" };
    }
    return { photos: parsed.data.photos, error: null };
  } catch (err) {
    return { photos: [], error: err instanceof Error ? err.message : "Network error" };
  }
}
