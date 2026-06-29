import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { DayworkRollup } from "@/components/admin/DayworkRollup";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { isAdminRole } from "@/lib/auth/roles";
import { readJsonBlob } from "@/server/job-control/blob";
import { blobDayworkDeps, loadDayworkRollup } from "@/server/dayworks/register";

export const dynamic = "force-dynamic";

interface JobRow {
  id: string;
  name?: string | null;
  archived?: boolean;
}

/**
 * /v2/dayworks — the cross-job daywork rollup (#370). The office payment-risk
 * view across every job: which jobs carry unsigned-aging dockets, each linking
 * into its own register. Admin-tier (commercial); read-only. Reads jobs.json
 * server-side (this path is already admin-gated) and aggregates via the shared
 * loader. The per-job register at /v2/jobs/[jobId]/dayworks is the drill-in.
 */
export default async function AdminDayworksRollupPage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent("/v2/dayworks")}`);
  }
  if (!isAdminRole(session.role)) {
    redirect("/v2/login");
  }

  let jobs: JobRow[] = [];
  let loadError = false;
  try {
    const blob = await readJsonBlob<{ jobs?: JobRow[] }>("jobs.json", { jobs: [] });
    jobs = Array.isArray(blob?.jobs) ? blob!.jobs : [];
  } catch {
    loadError = true;
  }

  if (loadError) {
    return (
      <AdminShell title="Dayworks" breadcrumb={<BackToCommandCentre />}>
        <div className="mx-auto max-w-3xl">
          <Card className="border-amber-200 bg-amber-50" role="alert">
            <CardTitle>Couldn&rsquo;t load dayworks</CardTitle>
            <CardDescription className="text-amber-900">
              The jobs list was unavailable. Try again in a moment.
            </CardDescription>
          </Card>
        </div>
      </AdminShell>
    );
  }

  const nowMs = Date.now();
  const rollup = await loadDayworkRollup(blobDayworkDeps(), jobs, nowMs);

  return (
    <AdminShell title="Dayworks" breadcrumb={<BackToCommandCentre />}>
      <div className="mx-auto max-w-4xl space-y-4">
        <p className="text-sm text-text-muted">
          Day-labour dockets across every job. Unsigned dockets older than 24h are payment risk —
          chase the builder&rsquo;s signature before they age into a disputed invoice.
        </p>
        <DayworkRollup
          byJob={rollup.byJob}
          dockets={rollup.dockets}
          summary={rollup.summary}
          nowMs={nowMs}
        />
      </div>
    </AdminShell>
  );
}

function BackToCommandCentre() {
  return (
    <Link
      href="/command-centre"
      className="underline decoration-accent-yellow decoration-2 underline-offset-2"
    >
      ← Command centre
    </Link>
  );
}
