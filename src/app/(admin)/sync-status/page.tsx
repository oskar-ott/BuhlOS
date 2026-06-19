import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardTitle, CardDescription } from "@/components/ui/Card";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { loadHoursSyncStatus, summariseHoursSync } from "@/server/sync-status";

// Reads live sync_checks at request time.
export const dynamic = "force-dynamic";

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export default async function SyncStatusPage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session) redirect("/v2/login?next=/sync-status");
  if (!canAccessSurface(session.role, "admin")) redirect("/v2/login");

  const summary = summariseHoursSync(await loadHoursSyncStatus());

  return (
    <AdminShell title="Migration sync status">
      <p className="mb-4 max-w-prose text-sm text-slate-600">
        Whether the hours data in Vercel Blob (the source of truth) still matches
        the Supabase Postgres mirror — entries <strong>and</strong> per-job
        allocations. Recorded by the operator drift-check (
        <code>hours-sync-check.js</code>).
      </p>

      {summary.state === "not_wired" && (
        <Card className="border-slate-200 bg-slate-50" role="status" data-testid="hours-sync-status">
          <CardTitle className="text-slate-700">Supabase not wired here</CardTitle>
          <CardDescription>
            This environment has no Supabase connection, so there is nothing to
            compare. The Blob remains the source of truth.
          </CardDescription>
        </Card>
      )}

      {summary.state === "none" && (
        <Card className="border-slate-200 bg-slate-50" role="status" data-testid="hours-sync-status">
          <CardTitle className="text-slate-700">No sync check recorded yet</CardTitle>
          <CardDescription>
            Run <code>node scripts/importers/hours-sync-check.js --write</code> to
            record the first check.
          </CardDescription>
        </Card>
      )}

      {summary.state === "pass" && (
        <Card className="border-emerald-200 bg-emerald-50" role="status" data-testid="hours-sync-status">
          <CardTitle className="text-emerald-900">Hours sync: IN SYNC ✓</CardTitle>
          <CardDescription className="text-emerald-900">
            Blob {summary.blobCount} entries ({summary.blobTotal}h) match Postgres{" "}
            {summary.pgCount} ({summary.pgTotal}h)
            {summary.allocationsChecked ? ", allocations included" : ""}
            {summary.hashMatch ? " · content hashes match" : ""}. Last checked{" "}
            {fmtWhen(summary.checkedAt)}.
          </CardDescription>
        </Card>
      )}

      {summary.state === "fail" && (
        <Card className="border-rose-300 bg-rose-50" role="status" data-testid="hours-sync-status">
          <CardTitle className="text-rose-900">Hours sync: DRIFT DETECTED</CardTitle>
          <CardDescription className="text-rose-900">
            Blob {summary.blobCount} ({summary.blobTotal}h) vs Postgres{" "}
            {summary.pgCount} ({summary.pgTotal}h). Drift — only in Blob:{" "}
            {summary.onlyInBlob}, only in Postgres: {summary.onlyInPg}, mismatched:{" "}
            {summary.mismatched}. Last checked {fmtWhen(summary.checkedAt)}.
            <br />
            <span className="mt-1 block font-mono text-xs">
              {JSON.stringify(summary.details)}
            </span>
          </CardDescription>
        </Card>
      )}
    </AdminShell>
  );
}
