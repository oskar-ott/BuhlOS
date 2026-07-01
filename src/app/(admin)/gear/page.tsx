import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { isFlagEnabled } from "../../../../api/_lib/feature-flags.js";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { UnderConstructionPanel } from "@/components/ui/UnderConstructionPanel";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { isFieldRole, isLeadingHandRole } from "@/lib/auth/roles";
import { ExpiringCalibrationSchema, GearListResponseSchema } from "@/domains/gear/schema";
import type { ExpiringCalibration, GearAsset, GearHolderUser } from "@/domains/gear/types";
import { GearRegisterClient } from "@/components/admin/GearRegisterClient";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * /gear — Phase C admin gear register.
 *
 * Server component loads the full asset list (including archived) and the
 * worker list for the assignment picker, then hands both to a client
 * component that handles assign / return / mark-condition mutations.
 *
 * Cross-ref:
 *   docs/rebuild-audit/13-ui-information-architecture.md §Section Gear
 *   docs/rebuild-audit/12-domain-model-deep-dive.md §Gear
 *   api/assets.js
 */
export default async function GearRegisterPage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/gear");
  }
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }
  // #760: gear kill-switch — when the owner turns gear off, the surface 404s.
  if (!(await isFlagEnabled("gear", session))) {
    notFound();
  }

  const [{ assets, holders, fetchError }, compliance] = await Promise.all([
    loadRegister(raw),
    loadCompliance(raw),
  ]);

  return (
    <AdminShell
      title="Gear · register"
      breadcrumb={
        <Link
          href="/command-centre"
          className="underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          ← Command centre
        </Link>
      }
    >
      <div className="mx-auto max-w-6xl space-y-4">
        <Card>
          <CardTitle>Assets · who has what</CardTitle>
          <CardDescription>
            Assign gear to a worker, return to depot, or mark damaged / missing. Every action is
            logged with actor and timestamp in the asset history.
          </CardDescription>
        </Card>

        <ComplianceSection compliance={compliance} />

        {fetchError ? (
          <Card className="border-amber-200 bg-amber-50" role="alert">
            <CardTitle>Couldn&rsquo;t load assets</CardTitle>
            <CardDescription className="text-amber-900">
              {fetchError}. Refresh the page to try again.
            </CardDescription>
          </Card>
        ) : null}

        {assets.length === 0 && !fetchError ? (
          <EmptyState
            title="No assets yet"
            description="Nothing in the gear register yet. Assets appear here as soon as they're added to the store."
          />
        ) : (
          <GearRegisterClient initialAssets={assets} holders={holders} />
        )}

        <UnderConstructionPanel
          feature="Bulk operations · QR scanning · label printing"
          description="Create, edit and archive now live on the register above (#389). Still to come: bulk assign / bulk retire, camera-based QR scanning, and label printer (Nimbot/Brother) integration."
        />
      </div>
    </AdminShell>
  );
}

/**
 * Compliance rows from GET /api/tags-expiring (#305) — the SAME computation
 * (api/_lib/tag-compliance.js) that drives the daily push alerts, so this
 * board and the notifications can never disagree. Server sorts expired-first.
 */
const ExpiringTagSchema = z
  .object({
    id: z.string().nullable(),
    jobId: z.string(),
    jobName: z.string(),
    tagNumber: z.string(),
    applianceType: z.string(),
    owner: z.string(),
    expiryDate: z.string(),
    daysToExpiry: z.number(),
    status: z.enum(["expired", "expiring"]),
  })
  .passthrough();

const ComplianceResponseSchema = z
  .object({
    tags: z.array(ExpiringTagSchema),
    calibrations: z.array(ExpiringCalibrationSchema).optional(),
  })
  .passthrough();

type ComplianceData = {
  tags: ReadonlyArray<z.infer<typeof ExpiringTagSchema>>;
  calibrations: ReadonlyArray<ExpiringCalibration>;
  error: boolean;
};

async function loadCompliance(cookieValue: string | undefined): Promise<ComplianceData> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(`${base}/api/tags-expiring`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (!res.ok) return { tags: [], calibrations: [], error: true };
    const parsed = ComplianceResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { tags: [], calibrations: [], error: true };
    return {
      tags: parsed.data.tags,
      calibrations: parsed.data.calibrations ?? [],
      error: false,
    };
  } catch {
    return { tags: [], calibrations: [], error: true };
  }
}

/** "3d overdue" / "due today" / "due in 5d" from signed daysToExpiry. */
function dueLabel(daysToExpiry: number): string {
  if (daysToExpiry < 0) return `${-daysToExpiry}d overdue`;
  if (daysToExpiry === 0) return "due today";
  return `due in ${daysToExpiry}d`;
}

/**
 * Expired-first compliance board (#305): test & tag entries across ALL jobs
 * (with job + owner context) plus instrument calibrations from the register.
 * Hidden entirely when everything is compliant — absence of the card IS the
 * all-clear; an empty-but-present warning card would train people to ignore it.
 */
function ComplianceSection({ compliance }: { compliance: ComplianceData }) {
  const { tags, calibrations, error } = compliance;
  if (error) {
    return (
      <Card className="border-amber-200 bg-amber-50" role="alert">
        <CardTitle>Couldn&rsquo;t load compliance</CardTitle>
        <CardDescription className="text-amber-900">
          The test &amp; tag / calibration check didn&rsquo;t load. Refresh the page to try again.
        </CardDescription>
      </Card>
    );
  }
  if (tags.length === 0 && calibrations.length === 0) return null;

  return (
    <Card className="border-red-200" role="region" aria-label="Compliance — needs retest">
      <CardTitle>Compliance · needs retest</CardTitle>
      <CardDescription>
        Test &amp; tag and instrument calibrations expired or due in the next 14 days —
        expired first. The same list drives the daily push alerts.
      </CardDescription>

      {tags.length > 0 ? (
        <ul className="mt-3 divide-y divide-border text-sm">
          {tags.map((t) => (
            <li
              key={`${t.jobId}:${t.id ?? t.tagNumber}`}
              className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2"
            >
              <span className="min-w-0">
                <span className="font-medium text-text">
                  {t.applianceType || t.tagNumber || "Tag"}
                </span>
                {t.tagNumber && t.applianceType ? (
                  <span className="text-text-muted"> · {t.tagNumber}</span>
                ) : null}
                <span className="text-text-muted">
                  {" "}
                  — <Link href={`/v2/jobs/${t.jobId}`} className="underline underline-offset-2">
                    {t.jobName}
                  </Link>
                  {t.owner ? ` · ${t.owner}` : ""}
                </span>
              </span>
              <span
                className={
                  t.status === "expired" ? "font-medium text-red-700" : "text-amber-700"
                }
              >
                {t.expiryDate} · {dueLabel(t.daysToExpiry)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {calibrations.length > 0 ? (
        <div className="mt-3">
          <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">
            Instrument calibrations
          </h3>
          <ul className="divide-y divide-border text-sm">
            {calibrations.map((c) => (
              <li
                key={c.key}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2"
              >
                <span className="min-w-0">
                  <span className="font-medium text-text">{c.assetName}</span>
                  {c.identifier ? <span className="text-text-muted"> · {c.identifier}</span> : null}
                  <span className="text-text-muted">
                    {" "}
                    — {c.holderName ?? "in depot"}
                  </span>
                </span>
                <span
                  className={
                    c.status === "expired" ? "font-medium text-red-700" : "text-amber-700"
                  }
                >
                  {c.calibrationDue} · {dueLabel(c.daysToExpiry)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

const HoldersResponseSchema = z.object({
  users: z.array(
    z
      .object({
        id: z.string(),
        username: z.string(),
        role: z.string(),
      })
      .passthrough()
  ),
});

async function loadRegister(cookieValue: string | undefined): Promise<{
  assets: ReadonlyArray<GearAsset>;
  holders: ReadonlyArray<GearHolderUser>;
  fetchError: string | null;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  const cookieHeader = cookieValue
    ? ({ cookie: `${SESSION_COOKIE}=${cookieValue}` } as const)
    : undefined;

  try {
    const [assetsRes, holdersRes] = await Promise.all([
      fetch(`${base}/api/assets?archived=1`, { cache: "no-store", headers: cookieHeader }),
      fetch(`${base}/api/users?action=listTradies`, { cache: "no-store", headers: cookieHeader }),
    ]);

    if (!assetsRes.ok) {
      return { assets: [], holders: [], fetchError: `Assets API returned ${assetsRes.status}` };
    }
    const assetsBody = await assetsRes.json();
    const assetsParsed = GearListResponseSchema.safeParse(assetsBody);
    if (!assetsParsed.success) {
      return { assets: [], holders: [], fetchError: "Unexpected assets response shape" };
    }

    let holders: ReadonlyArray<GearHolderUser> = [];
    if (holdersRes.ok) {
      const holdersBody = await holdersRes.json();
      const holdersParsed = HoldersResponseSchema.safeParse(holdersBody);
      if (holdersParsed.success) {
        // Only field-tier workers + leading hands can hold gear (same rule the
        // assets API enforces on transfer). Defence-in-depth against a brittle
        // literal check: was `role !== "admin" && role !== "client"`, which
        // would have surfaced office/boss/pm/unknown roles as pickable holders.
        holders = holdersParsed.data.users.filter(
          (u) => isFieldRole(u.role) || isLeadingHandRole(u.role)
        );
      }
    }
    return { assets: assetsParsed.data.assets, holders, fetchError: null };
  } catch (err) {
    return {
      assets: [],
      holders: [],
      fetchError: err instanceof Error ? err.message : "Network error",
    };
  }
}
