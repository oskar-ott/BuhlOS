import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { ClaimsRegister } from "@/components/admin/ClaimsRegister";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { ClaimsViewWireSchema, type ClaimsViewWire } from "@/domains/progress-claims/client";
import { isFlagEnabled } from "../../../../../../api/_lib/feature-flags.js";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string }>;
}

/**
 * /v2/jobs/[jobId]/claims — the per-job progress-claims register (#372).
 *
 * Claims built from what's actually done: lines seeded from the linked
 * quote's priced lines (where imported BOQ workbook lines land, #365/#828) or
 * from compiled work packages (#367); evidence linked per line from the job's
 * real records; submit freezes the claim; export matches Payapps keying.
 *
 * ADMIN-tier only (claims are billing — the variations-register precedent)
 * and gated DARK behind `progress_claims` (404s when off).
 */
export default async function AdminClaimsPage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/v2/jobs/${jobId}/claims`)}`);
  }
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }
  if (!(await isFlagEnabled("progress_claims", session))) {
    notFound();
  }

  const view = await loadView(raw, jobId);

  if (view.kind === "not_found") {
    notFound();
  }

  const jobName = view.kind === "ok" ? view.view.jobName ?? "Job" : "Job";

  return (
    <AdminShell title={`Progress claims · ${jobName}`} breadcrumb={<BackToJob jobId={jobId} />}>
      <div className="mx-auto max-w-5xl">
        <ClaimsRegister
          jobId={jobId}
          initialView={view.kind === "ok" ? view.view : null}
          fetchError={view.kind === "error" ? view.message : null}
        />
      </div>
    </AdminShell>
  );
}

function BackToJob({ jobId }: { jobId: string }) {
  return (
    <Link
      href={`/v2/jobs/${encodeURIComponent(jobId)}`}
      className="underline decoration-accent-yellow decoration-2 underline-offset-2"
    >
      ← Back to job
    </Link>
  );
}

type ViewLoad =
  | { kind: "ok"; view: ClaimsViewWire }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

async function loadView(cookieValue: string | undefined, jobId: string): Promise<ViewLoad> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(`${base}/api/job-claims?jobId=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (res.status === 404) return { kind: "not_found" };
    if (!res.ok) return { kind: "error", message: `Claims API ${res.status}` };
    const parsed = ClaimsViewWireSchema.safeParse(await res.json());
    if (!parsed.success) return { kind: "error", message: "Unexpected claims response" };
    return { kind: "ok", view: parsed.data };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : "Network error" };
  }
}
