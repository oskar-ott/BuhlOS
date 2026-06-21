import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardTitle, CardDescription } from "@/components/ui/Card";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { loadJobsReadStatus, summariseJobsRead, summarisePhilRead } from "@/server/jobs-read-status";

// Runs a live, read-only probe at request time.
export const dynamic = "force-dynamic";

function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-slate-100 py-1.5 last:border-0">
      <span className="text-sm text-slate-600">{label}</span>
      <span className="text-right text-sm font-medium text-slate-900">{value}</span>
    </div>
  );
}

export default async function JobsReadStatusPage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session) redirect("/v2/login?next=/jobs-read-status");
  if (!canAccessSurface(session.role, "admin")) redirect("/v2/login");

  const status = await loadJobsReadStatus();
  const s = summariseJobsRead(status);
  const phil = summarisePhilRead(status);

  const sourceLabel = s.readSource === "postgres" ? "Postgres" : "Blob";

  return (
    <AdminShell title="Jobs read cutover (J6/J7)">
      <p className="mb-4 max-w-prose text-sm text-slate-600">
        The admin jobs read can be served from the Supabase Postgres mirror behind
        the <code>supabase_read_jobs</code> flag (<strong>DARK by default</strong>).
        Vercel Blob stays the source of truth: a job&rsquo;s structure is served
        from Postgres only when it is byte-identical to Blob, so what the office
        sees never changes. This page runs a live, read-only probe.
      </p>

      {s.state === "not_wired" && (
        <Card className="border-slate-200 bg-slate-50" role="status" data-testid="jobs-read-status">
          <CardTitle className="text-slate-700">Supabase not wired here</CardTitle>
          <CardDescription>
            This environment has no Supabase connection, so the admin read is
            served entirely from Blob. The flag has no effect here.
          </CardDescription>
        </Card>
      )}

      {s.state === "error" && (
        <Card className="border-amber-200 bg-amber-50" role="status" data-testid="jobs-read-status">
          <CardTitle className="text-amber-900">Couldn&rsquo;t probe the read path</CardTitle>
          <CardDescription className="text-amber-900">
            Supabase is wired but the read-only probe failed:{" "}
            <span className="font-mono text-xs">{s.error}</span>. Admin still reads
            Blob — this only affects diagnostics.
          </CardDescription>
        </Card>
      )}

      {s.state === "flag_off" && (
        <Card className="border-slate-200 bg-slate-50" role="status" data-testid="jobs-read-status">
          <CardTitle className="text-slate-700">Flag OFF — reading Blob</CardTitle>
          <CardDescription>
            <code>supabase_read_jobs</code> is off, so admin reads come entirely
            from Blob. The probe still reconstructed Postgres to report parity
            below — turning the flag on would serve{" "}
            <strong>{s.pgFaithfulCount}</strong> of {s.matchedCount} matched jobs
            from Postgres.
          </CardDescription>
        </Card>
      )}

      {s.state === "fallback" && (
        <Card className="border-amber-200 bg-amber-50" role="status" data-testid="jobs-read-status">
          <CardTitle className="text-amber-900">Flag ON — automatic Blob fallback</CardTitle>
          <CardDescription className="text-amber-900">
            The flag is on but the Postgres reconstruction failed, so admin is
            served entirely from Blob (no outage).{" "}
            {s.error && <span className="font-mono text-xs">{s.error}</span>}
          </CardDescription>
        </Card>
      )}

      {s.state === "active" && (
        <Card
          className={
            s.parityMatch
              ? "border-emerald-200 bg-emerald-50"
              : "border-amber-200 bg-amber-50"
          }
          role="status"
          data-testid="jobs-read-status"
        >
          <CardTitle className={s.parityMatch ? "text-emerald-900" : "text-amber-900"}>
            {s.parityMatch
              ? "Flag ON — serving from Postgres ✓"
              : "Flag ON — Postgres + Blob (some jobs drifted)"}
          </CardTitle>
          <CardDescription className={s.parityMatch ? "text-emerald-900" : "text-amber-900"}>
            Serving <strong>{s.pgFaithfulCount}</strong> of {s.matchedCount} matched
            jobs from Postgres; {s.driftedCount} drifted and {s.onlyInBlobCount}{" "}
            new/Blob-only jobs stay on Blob. Output is byte-identical to Blob.
          </CardDescription>
        </Card>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Card>
          <CardTitle className="mb-2 text-slate-800">Read path</CardTitle>
          <Row label="Current source" value={sourceLabel} />
          <Row label="Feature flag" value={s.flagOn ? "ON" : "OFF"} />
          <Row
            label="Projection"
            value={s.reconstructed ? "PASS" : s.state === "not_wired" ? "—" : "FAIL"}
          />
          <Row label="Probe latency" value={s.latencyMs == null ? "—" : `${s.latencyMs} ms`} />
        </Card>

        <Card>
          <CardTitle className="mb-2 text-slate-800">Parity (live)</CardTitle>
          <Row
            label="Migrated hash"
            value={s.hashMatch == null ? "—" : s.hashMatch ? "match ✓" : "drift"}
          />
          <Row label="Faithful (PG-served)" value={s.pgFaithfulCount} />
          <Row label="Drifted (Blob-served)" value={s.driftedCount} />
          <Row label="New / Blob-only" value={s.onlyInBlobCount} />
          <Row label="Stale / Postgres-only" value={s.onlyInPgCount} />
        </Card>
      </div>

      <Card className="mt-4">
        <CardTitle className="mb-2 text-slate-800">
          Served reads (this server instance)
        </CardTitle>
        <CardDescription className="mb-2">
          In-memory counters — no parity result is written to Blob or Postgres, so
          these reset on cold start and are not aggregated across instances.
        </CardDescription>
        <Row label="Admin reads served" value={s.totalReads} />
        <Row label="Blob fallbacks (PG errored)" value={s.fallbackReads} />
        <Row label="Last served read" value={fmtWhen(s.lastAt)} />
      </Card>

      <Card className="mt-4" data-testid="phil-read-status">
        <CardTitle className="mb-2 text-slate-800">
          Phil (field) read cutover (J7)
        </CardTitle>
        <CardDescription className="mb-2">
          Field workers&rsquo; jobs read behind <code>supabase_read_phil_jobs</code>{" "}
          (<strong>{phil.flagOn ? "ON" : "OFF"}</strong>), scoped per worker to
          their assigned jobs. No live probe here (it needs a worker context) —
          these are process-local counters of field reads served by this instance.
        </CardDescription>
        <Row label="Feature flag" value={phil.flagOn ? "ON" : "OFF"} />
        <Row label="Field reads served" value={phil.totalReads} />
        <Row label="… from Postgres" value={phil.pgServedReads} />
        <Row label="… from Blob" value={phil.blobServedReads} />
        <Row label="Blob fallbacks (PG errored)" value={phil.fallbackReads} />
        <Row
          label="Last field read (visible PG-served)"
          value={phil.lastMatched == null ? "—" : `${phil.lastPgFaithful}/${phil.lastMatched}`}
        />
        <Row label="Last field read at" value={fmtWhen(phil.lastAt)} />
      </Card>
    </AdminShell>
  );
}
