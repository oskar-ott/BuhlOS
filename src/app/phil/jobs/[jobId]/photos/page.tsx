import { notFound, redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { PhilShell } from "@/components/phil/PhilShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { PhilPageIntro } from "@/components/phil/ui/PhilPageIntro";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { PhilBackLink } from "@/components/phil/ui/PhilBackLink";
import { PhilPhotosGallery } from "@/components/phil/PhilPhotosGallery";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { isFlagEnabled } from "../../../../../../api/_lib/feature-flags.js";
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
 * /phil/jobs/[jobId]/photos — the field's read-only photo gallery (#242, AC4).
 *
 * Phil constitution note:
 *   - Principle served: the field can FIND a job's photos (reference, the "Job
 *     Bible") — capture stays on the job home, this is browse-only.
 *   - UI slot: a read-only gallery in the job's reference zone, linked from the
 *     job home (P10 — an existing reference slot like Plans / Circuit schedule,
 *     no new navigation paradigm).
 *   - P7: counts are real; gaps are honest — a tradie is TOLD snag / ITP photos
 *     are office-side (the catalog is leading-hand+), never shown a fake empty.
 *   - Hidden-until-real: the job home only links here when there are photos to
 *     show, per the repo's hidden-unfinished rule.
 *
 * Reuses the SAME gated endpoints (/api/evidence, /api/photos-catalog) and the
 * same gallery model as BuhlOS — no role redaction is bypassed. The
 * photos-catalog is staff-only (admin / LH), so for a tradie it 403s and the
 * gallery shows an honest "office-side" note rather than treating it as an error.
 *
 * Mirrors the Plans / Circuit schedule Phil sub-route scaffold.
 */
export default async function PhilJobPhotosPage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/phil/jobs/${jobId}/photos`)}`);
  }
  if (!canAccessSurface(session.role, "phil")) {
    redirect("/v2/login");
  }
  // #760: job-photos kill-switch — when the owner turns job photos off, the surface 404s.
  if (!(await isFlagEnabled("job_photos", session))) {
    notFound();
  }

  const [jobResult, evidenceResult, catalogResult] = await Promise.all([
    loadJob(raw, jobId),
    loadEvidence(raw, jobId),
    loadCatalog(raw, jobId),
  ]);

  if (jobResult.kind === "not_found" || jobResult.kind === "forbidden") {
    return (
      <PhilShell title="Photos">
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
      <PhilShell title="Photos">
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

  const areaNameById = buildAreaNameMap(jobResult.job);

  return (
    <PhilShell title={`Photos · ${jobResult.job.name}`}>
      <div className="space-y-4">
        <PhilBackLink href={`/phil/jobs/${encodeURIComponent(jobId)}`}>Back to job</PhilBackLink>
        <PhilPageIntro
          title="Photos"
          description="Every photo on this job in one place — browse, don’t capture."
        />
        <PhilPhotosGallery
          evidence={evidenceResult.evidence}
          catalog={catalogResult.photos}
          areaNameById={areaNameById}
          catalogAvailable={catalogResult.available}
          catalogError={catalogResult.error}
          evidenceError={evidenceResult.error}
        />
      </div>
    </PhilShell>
  );
}

/** id→name for every area across the job's area groups. */
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

type JobLoad =
  | { kind: "ok"; job: Job }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

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

/** The worker's own evidence (server filters to capturedById === me for tradie). */
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
    if (!res.ok) return { evidence: [], error: `Evidence API returned ${res.status}` };
    const parsed = EvidenceListResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { evidence: [], error: "Unexpected evidence response shape" };
    return { evidence: parsed.data.evidence, error: null };
  } catch (err) {
    return { evidence: [], error: err instanceof Error ? err.message : "Network error" };
  }
}

/**
 * Snag + dwelling/ITP catalog. The endpoint is staff-only (admin / LH), so a
 * tradie 403s — that's the role GATE, not a failure: `available: false`,
 * `error: null`. A non-403 non-ok is a genuine failure (`error` set).
 */
async function loadCatalog(
  cookieValue: string | undefined,
  jobId: string,
): Promise<{ photos: PhotoCatalogEntry[]; available: boolean; error: string | null }> {
  const base = await apiBase();
  try {
    const res = await fetch(
      `${base}/api/photos-catalog?jobId=${encodeURIComponent(jobId)}`,
      {
        cache: "no-store",
        headers: cookieHeader(cookieValue),
      },
    );
    if (res.status === 403) {
      // Role gate (tradie) — not a failure. The gallery tells the worker the
      // snag / ITP photos are office-side.
      return { photos: [], available: false, error: null };
    }
    if (!res.ok) {
      return { photos: [], available: true, error: `Catalog API returned ${res.status}` };
    }
    const parsed = PhotoCatalogResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      return { photos: [], available: true, error: "Unexpected catalog response shape" };
    }
    return { photos: parsed.data.photos, available: true, error: null };
  } catch (err) {
    return {
      photos: [],
      available: true,
      error: err instanceof Error ? err.message : "Network error",
    };
  }
}
