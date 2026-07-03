import Link from "next/link";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { isFlagEnabled } from "../../../../../../../api/_lib/feature-flags.js";
import { JobDetailResponseSchema } from "@/domains/jobs/schema";
import { ITPListResponseSchema } from "@/domains/itp/schema";
import {
  buildCompliancePack,
  type OverrideByInstanceId,
} from "@/domains/itp/compliance-pack";
import { CompliancePackView } from "@/components/admin/CompliancePackView";
import { PackPrintButton } from "@/components/admin/PackPrintButton";
import { TestRecordStoreSchema, type TestRecord } from "@/domains/test-records/schema";
import type { Job } from "@/domains/jobs/types";
import type { ITPInstance } from "@/domains/itp/types";

export const dynamic = "force-dynamic";

const OVERRIDES_WINDOW_MONTHS = 12;

/**
 * /v2/jobs/[jobId]/itps/pack — the printable compliance pack (#286).
 *
 * Deliberately NOT wrapped in AdminShell: this is the document the office
 * prints (browser print → Save as PDF) and sends to the builder. A no-print
 * toolbar carries the print button + the way back.
 *
 * Permission mirrors the ITP queue: admin tier any job, LH their assigned
 * jobs — the underlying /api/jobs + /api/job-itps loads enforce job access
 * server-side; clients never reach this surface. Read-only end to end.
 *
 * Override sourcing (#289): independence override justifications are now
 * PERSISTED on the instance (schema `signOffOverride`) at sign-off time, so
 * the pack reads them straight from the instance and they can never age out.
 * The 12-month audit read below is retained ONLY as a legacy fallback for
 * instances signed off before that field existed; the pack prefers the
 * instance value and the note explains the split.
 */
export default async function CompliancePackPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/v2/jobs/${jobId}/itps/pack`)}`);
  }
  if (!canAccessSurface(session.role, "lh")) {
    redirect("/v2/login");
  }
  // #760: ITP kill-switch — the compliance pack is part of the ITP feature.
  if (!(await isFlagEnabled("itp", session))) {
    notFound();
  }

  const [job, instances, overrides, testRecords] = await Promise.all([
    loadJob(raw, jobId),
    loadInstances(raw, jobId),
    loadOverrides(raw, jobId),
    loadTestRecords(raw, jobId),
  ]);

  if (!job) {
    return (
      <main className="mx-auto max-w-xl px-6 py-16 text-sm">
        <p>
          This job isn&rsquo;t available — it may be archived, or you may not
          have access.
        </p>
        <p className="mt-4">
          <Link className="underline" href="/v2/jobs">
            ← Jobs
          </Link>
        </p>
      </main>
    );
  }

  const pack = buildCompliancePack({
    job,
    instances,
    overrides,
    overridesWindowMonths: OVERRIDES_WINDOW_MONTHS,
    generatedAt: new Date().toISOString(),
    testRecords,
  });

  return (
    <main className="min-h-screen bg-white">
      {/* No-print toolbar */}
      <div className="flex items-center justify-between gap-3 border-b border-neutral-200 px-6 py-3 print:hidden">
        <Link
          href={`/v2/jobs/${encodeURIComponent(jobId)}/itps`}
          className="text-sm underline"
        >
          ← Back to ITPs
        </Link>
        <PackPrintButton />
      </div>
      <CompliancePackView pack={pack} />
    </main>
  );
}

async function baseUrl(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  return host ? `${proto}://${host}` : "http://localhost:3000";
}

function cookieHeader(raw: string | undefined): { cookie: string } | undefined {
  return raw ? { cookie: `${SESSION_COOKIE}=${raw}` } : undefined;
}

async function loadJob(raw: string | undefined, jobId: string): Promise<Job | null> {
  try {
    const res = await fetch(`${await baseUrl()}/api/jobs?id=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
      headers: cookieHeader(raw),
    });
    if (!res.ok) return null;
    const parsed = JobDetailResponseSchema.safeParse(await res.json());
    return parsed.success ? parsed.data.job : null;
  } catch {
    return null;
  }
}

async function loadInstances(raw: string | undefined, jobId: string): Promise<ITPInstance[]> {
  try {
    const res = await fetch(
      `${await baseUrl()}/api/job-itps?jobId=${encodeURIComponent(jobId)}`,
      { cache: "no-store", headers: cookieHeader(raw) }
    );
    if (!res.ok) return [];
    const parsed = ITPListResponseSchema.safeParse(await res.json());
    return parsed.success ? [...parsed.data.instances] : [];
  } catch {
    return [];
  }
}

/** #519 — the job's structured TestRecords for the pack's electrical
 *  test-results section. Server-derived statuses arrive stored; the pack
 *  reproduces them. Failure → [] → the section is honestly omitted. */
async function loadTestRecords(
  raw: string | undefined,
  jobId: string
): Promise<TestRecord[]> {
  try {
    const res = await fetch(
      `${await baseUrl()}/api/job-control/test-records?jobId=${encodeURIComponent(jobId)}`,
      { cache: "no-store", headers: cookieHeader(raw) }
    );
    if (!res.ok) return [];
    const body = (await res.json()) as { records?: unknown };
    const parsed = TestRecordStoreSchema.safeParse({ records: body?.records ?? [] });
    return parsed.success ? parsed.data.records : [];
  } catch {
    return [];
  }
}

/** #289 legacy fallback — itp.signed_off audit entries →
 *  { instanceId: overrideJustification }, for instances signed off before
 *  the override was persisted on the instance. The pack prefers the
 *  instance's own signOffOverride and only reaches this for older rows.
 *  Latest entry per instance wins (a reopen + re-signoff supersedes). */
async function loadOverrides(
  raw: string | undefined,
  jobId: string
): Promise<OverrideByInstanceId> {
  try {
    const res = await fetch(
      `${await baseUrl()}/api/audit-log?jobId=${encodeURIComponent(jobId)}&scope=job&months=${OVERRIDES_WINDOW_MONTHS}`,
      { cache: "no-store", headers: cookieHeader(raw) }
    );
    if (!res.ok) return {};
    const body = (await res.json()) as {
      entries?: Array<{
        action?: string;
        targetId?: string;
        at?: string;
        metadata?: { overrideJustification?: unknown };
      }>;
    };
    const out: Record<string, string> = {};
    // Entries arrive newest-first; keep the first (= latest) per instance.
    for (const e of body.entries ?? []) {
      if (e.action !== "itp.signed_off") continue;
      const j = e.metadata?.overrideJustification;
      if (!e.targetId || typeof j !== "string" || !j.trim()) continue;
      if (!(e.targetId in out)) out[e.targetId] = j;
    }
    return out;
  } catch {
    return {};
  }
}
