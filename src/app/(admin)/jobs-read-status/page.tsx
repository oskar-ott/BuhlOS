import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardTitle, CardDescription } from "@/components/ui/Card";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { loadJobsReadStatus, summariseJobsRead, summarisePhilRead, loadTaskReadStatus, summariseTaskRead, loadAdminTaskReadStatus, summariseAdminTaskRead, loadTaskReadProbe, summariseTaskReadProbe, loadEvidenceReadProbe, summariseEvidenceReadProbe } from "@/server/jobs-read-status";

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
  const taskRead = summariseTaskRead(await loadTaskReadStatus());
  const adminTaskRead = summariseAdminTaskRead(await loadAdminTaskReadStatus());
  const taskProbe = summariseTaskReadProbe(await loadTaskReadProbe());
  const evidenceProbe = summariseEvidenceReadProbe(await loadEvidenceReadProbe());

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

      <Card className="mt-4" data-testid="phil-task-read-status">
        <CardTitle className="mb-2 text-slate-800">
          Phil (field) task-status read cutover (J10)
        </CardTitle>
        <CardDescription className="mb-2">
          Field task statuses (<code>/api/data</code>) behind{" "}
          <code>supabase_read_phil_tasks</code> (<strong>{taskRead.flagOn ? "ON" : "OFF"}</strong>),
          parity-gated per job (served from Postgres only when byte-faithful to
          Blob, else Blob fallback — a not-yet-mirrored toggle can never show
          stale). Process-local counters of field task reads served by this
          instance.
        </CardDescription>
        <Row label="Feature flag" value={taskRead.flagOn ? "ON" : "OFF"} />
        <Row label="Task reads served" value={taskRead.totalReads} />
        <Row label="… from Postgres (parity PASS)" value={taskRead.pgServedReads} />
        <Row label="… from Blob" value={taskRead.blobServedReads} />
        <Row label="Blob fallbacks (PG error)" value={taskRead.fallbackReads} />
        <Row label="Parity mismatches → Blob" value={taskRead.parityMismatches} />
        <Row label="Last read source" value={taskRead.lastSource ?? "—"} />
        <Row label="Last read at" value={fmtWhen(taskRead.lastAt)} />
      </Card>

      <Card className="mt-4" data-testid="admin-task-read-status">
        <CardTitle className="mb-2 text-slate-800">
          Admin (office) task-status read cutover (J11)
        </CardTitle>
        <CardDescription className="mb-2">
          Admin-tier task statuses (<code>/api/data</code>) behind{" "}
          <code>supabase_read_admin_tasks</code> (<strong>{adminTaskRead.flagOn ? "ON" : "OFF"}</strong>),
          the same per-job parity gate as the field read (served from Postgres only
          when byte-faithful to Blob, else Blob fallback). Independent of the field
          flag; clients always read pure Blob. Process-local counters of admin task
          reads served by this instance.
        </CardDescription>
        <Row label="Feature flag" value={adminTaskRead.flagOn ? "ON" : "OFF"} />
        <Row label="Task reads served" value={adminTaskRead.totalReads} />
        <Row label="… from Postgres (parity PASS)" value={adminTaskRead.pgServedReads} />
        <Row label="… from Blob" value={adminTaskRead.blobServedReads} />
        <Row label="Blob fallbacks (PG error)" value={adminTaskRead.fallbackReads} />
        <Row label="Parity mismatches → Blob" value={adminTaskRead.parityMismatches} />
        <Row label="Last read source" value={adminTaskRead.lastSource ?? "—"} />
        <Row label="Last read at" value={fmtWhen(adminTaskRead.lastAt)} />
      </Card>

      <Card
        className={
          "mt-4 " +
          (taskProbe.state === "all_faithful"
            ? "border-emerald-200 bg-emerald-50"
            : taskProbe.state === "drift" || taskProbe.state === "error"
              ? "border-amber-200 bg-amber-50"
              : "")
        }
        data-testid="task-read-probe-status"
        role="status"
      >
        <CardTitle className="mb-2 text-slate-800">
          Task-status parity — live readiness probe (J12)
        </CardTitle>
        <CardDescription className="mb-2">
          A live, read-only sample (no serving, no writes) of how byte-faithful the
          Postgres task mirror is to Blob across jobs — the evidence a served-source
          promotion (J13) is gated on. <strong>Blob stays authoritative; Postgres is
          not the source of truth yet.</strong> Parity is the same data for field and
          office, so this one probe covers both tiers.
        </CardDescription>

        {taskProbe.state === "not_wired" && (
          <CardDescription>
            Supabase is not wired here, so there is nothing to probe — task reads are
            served entirely from Blob.
          </CardDescription>
        )}
        {taskProbe.state === "error" && (
          <CardDescription className="text-amber-900">
            The read-only probe failed:{" "}
            <span className="font-mono text-xs">{taskProbe.error}</span>. Reads are
            unaffected (Blob authoritative) — this only affects diagnostics.
          </CardDescription>
        )}
        {taskProbe.state === "empty" && (
          <CardDescription>
            No jobs were available to sample.
          </CardDescription>
        )}
        {(taskProbe.state === "all_faithful" || taskProbe.state === "drift") && (
          <>
            <CardDescription
              className={taskProbe.state === "all_faithful" ? "mb-2 text-emerald-900" : "mb-2 text-amber-900"}
            >
              {taskProbe.state === "all_faithful"
                ? `All ${taskProbe.jobsSampled} sampled job(s) are byte-faithful to Blob — a served-source flip would be byte-safe for this sample.`
                : `${taskProbe.pgFaithful} of ${taskProbe.jobsSampled} sampled job(s) byte-faithful; the rest are not yet promotable.`}
            </CardDescription>
            <Row
              label="Jobs sampled"
              value={`${taskProbe.jobsSampled} of ${taskProbe.jobsTotal}`}
            />
            <Row label="Byte-faithful (PG == Blob)" value={taskProbe.pgFaithful} />
            <Row label="Drifted (real divergence)" value={taskProbe.drifted} />
            <Row label="Errored (PG unreachable)" value={taskProbe.errored} />
            <Row label="Unavailable (not yet in PG)" value={taskProbe.unavailable} />
            <Row label="Drifted tasks — status mismatch" value={taskProbe.totalMismatched} />
            <Row label="Drifted tasks — unresolved" value={taskProbe.totalUnresolved} />
            <Row label="Drifted tasks — orphan in PG" value={taskProbe.totalOrphans} />
            <Row label="Jobs with status-hash drift" value={taskProbe.hashDriftJobs} />
            <Row label="Probe latency" value={taskProbe.latencyMs == null ? "—" : `${taskProbe.latencyMs} ms`} />
            <Row
              label="Ready for served-source promotion (this sample)"
              value={taskProbe.readyForPromotion ? "YES" : "no"}
            />
          </>
        )}
      </Card>

      <Card
        className={
          "mt-4 " +
          (evidenceProbe.state === "all_faithful"
            ? "border-emerald-200 bg-emerald-50"
            : evidenceProbe.state === "drift" || evidenceProbe.state === "error"
              ? "border-amber-200 bg-amber-50"
              : "")
        }
        data-testid="evidence-read-probe-status"
        role="status"
      >
        <CardTitle className="mb-2 text-slate-800">
          Evidence metadata parity — live readiness probe
        </CardTitle>
        <CardDescription className="mb-2">
          A live, read-only sample (no serving, no writes, no flag) of how faithful
          the Postgres <code>evidence_files</code> mirror is to the Blob{" "}
          <code>data.json.evidence[]</code> across jobs — the evidence a future dark
          evidence read overlay would be gated on.{" "}
          <strong>Evidence metadata only — not proof-status.</strong> Parity is
          normalised (identity/kind/area/stage/task/status/source); photo bytes,
          Blob URLs, note bodies, labels and timestamps are deliberately excluded.{" "}
          <strong>Blob stays authoritative.</strong>
        </CardDescription>
        <CardDescription className="mb-2 text-xs text-slate-500">
          Proof-status (<code>job-control.json</code> required-evidence / links /
          reviews) is Blob-only — it has no Postgres table, so its read cutover is
          blocked behind a schema + dual-write + the admin approve/reject decision
          (#503). It is not probed or served here.
        </CardDescription>

        {evidenceProbe.state === "not_wired" && (
          <CardDescription>
            Supabase is not wired here, so there is nothing to probe — evidence is
            read entirely from Blob.
          </CardDescription>
        )}
        {evidenceProbe.state === "error" && (
          <CardDescription className="text-amber-900">
            The read-only probe failed:{" "}
            <span className="font-mono text-xs">{evidenceProbe.error}</span>. Reads
            are unaffected (Blob authoritative) — this only affects diagnostics.
          </CardDescription>
        )}
        {evidenceProbe.state === "empty" && (
          <CardDescription>No jobs were available to sample.</CardDescription>
        )}
        {(evidenceProbe.state === "all_faithful" || evidenceProbe.state === "drift") && (
          <>
            <CardDescription
              className={evidenceProbe.state === "all_faithful" ? "mb-2 text-emerald-900" : "mb-2 text-amber-900"}
            >
              {evidenceProbe.state === "all_faithful"
                ? `All ${evidenceProbe.jobsSampled} sampled job(s) are evidence-faithful to Blob — a dark evidence overlay would be byte-safe for this sample.`
                : `${evidenceProbe.faithful} of ${evidenceProbe.jobsSampled} sampled job(s) evidence-faithful; the rest have drift or aren't mirrored yet.`}
            </CardDescription>
            <Row
              label="Jobs sampled"
              value={`${evidenceProbe.jobsSampled} of ${evidenceProbe.jobsTotal}`}
            />
            <Row label="Evidence-faithful (PG == Blob)" value={evidenceProbe.faithful} />
            <Row label="Drifted (real divergence)" value={evidenceProbe.drifted} />
            <Row label="Unavailable (job not yet in PG)" value={evidenceProbe.unavailable} />
            <Row label="Evidence items matched" value={evidenceProbe.matchedEvidence} />
            <Row label="Evidence — field mismatch" value={evidenceProbe.mismatchedEvidence} />
            <Row label="Evidence — missing in PG" value={evidenceProbe.missingInPg} />
            <Row label="Evidence — orphan in PG (missing in Blob)" value={evidenceProbe.missingInBlob} />
            <Row label="Probe latency" value={evidenceProbe.latencyMs == null ? "—" : `${evidenceProbe.latencyMs} ms`} />
            <Row
              label="Ready for a dark evidence overlay (this sample)"
              value={evidenceProbe.readyForOverlay ? "YES" : "no"}
            />
          </>
        )}
      </Card>
    </AdminShell>
  );
}
