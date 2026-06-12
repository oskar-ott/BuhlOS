import Link from "next/link";
import type { Route } from "next";
import { cookies, headers } from "next/headers";
import { PhilShell } from "@/components/phil/PhilShell";
import { PhilMyLicencesCard } from "@/components/phil/PhilMyLicencesCard";
import { PhilMyInductionsCard } from "@/components/phil/PhilMyInductionsCard";
import {
  MyInductionHistoryResponseSchema,
  type InductionRecord,
} from "@/domains/jobs/induction";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { CredentialListResponseSchema } from "@/domains/workforce/schema";
import type { Credential } from "@/domains/workforce/types";
import { PhilSignOutButton } from "@/components/phil/PhilSignOutButton";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { UnderConstructionPanel } from "@/components/ui/UnderConstructionPanel";
import { PushNotificationsCard } from "@/components/pwa/PushNotificationsCard";

/**
 * /v2/phil — Phil landing / "More" tab profile placeholder.
 *
 * Per the Interface Bible vNext §16.4 (Pass 1 — "Demote the four nav
 * cards on Phil home"), this surface no longer duplicates the bottom-tab
 * links to /phil/my-day, /phil/jobs and /phil/gear. The tab bar owns
 * those. What remains is: a short orientation line, an onboarding replay
 * card, an account card (sign out), and the profile/settings UC panel.
 */
export const dynamic = "force-dynamic";

export default async function PhilV2HomePage() {
  const [{ credentials, fetchError }, inductions] = await Promise.all([
    loadMyLicences(),
    loadMyInductions(),
  ]);
  return (
    <PhilShell title="Phil">
      <div className="space-y-4">
        <Card className="space-y-2">
          <CardTitle>You&rsquo;re on Phil</CardTitle>
          <CardDescription>
            Use the bottom tabs for your day, jobs and gear. This page is
            where your profile and notification settings will live.
          </CardDescription>
        </Card>

        <Card className="space-y-3">
          <div>
            <CardTitle>New here?</CardTitle>
            <CardDescription>
              Three-minute tour of what Phil does. Replay any time — Hours,
              Gear, Jobs, on-site evidence, permissions, then back here.
            </CardDescription>
          </div>
          <div>
            <Link
              href={"/phil/onboarding" as Route}
              className="inline-flex h-11 items-center justify-center rounded-card bg-accent-yellow px-4 text-sm font-semibold text-brand-navy hover:brightness-95"
            >
              Start the tour →
            </Link>
          </div>
        </Card>

        <Card className="space-y-3">
          <div>
            <CardTitle>Account</CardTitle>
            <CardDescription>
              Signing out returns you to the login screen. You&rsquo;ll need
              your username and PIN to get back in.
            </CardDescription>
          </div>
          <PhilSignOutButton />
        </Card>

        {/* #422: leave lives here on the More tab now, not on My Day —
            My Day stays about today's one action. */}
        <Card className="space-y-3">
          <div>
            <CardTitle>Time off</CardTitle>
            <CardDescription>
              Off sick or taking leave? Request it here — approved days stop
              showing as missing hours.
            </CardDescription>
          </div>
          <div>
            <Link
              href={"/phil/leave" as Route}
              className="inline-flex h-11 items-center justify-center rounded-card border border-border bg-surface px-4 text-sm font-semibold text-text hover:border-brand-navy"
              data-testid="more-leave-link"
            >
              Request leave →
            </Link>
          </div>
        </Card>

        {/* #331: the worker's own licence register — the licence-expiry
            push deep-links to this page. */}
        <PhilMyLicencesCard credentials={credentials} fetchError={fetchError} />

        {/* #332: jobs where this worker's site induction is on record. */}
        <PhilMyInductionsCard
          records={inductions.records}
          fetchError={inductions.fetchError}
        />

        <PushNotificationsCard audience="phil" />

        <UnderConstructionPanel
          feature="Profile · settings"
          description="Your worker profile and the rest of your settings live here once the loops above are field-stable."
        />
      </div>
    </PhilShell>
  );
}

/**
 * Own licences via GET /api/licences?mine=1 — the session cookie IS the
 * identity (no userId parameter exists on the self route, so a worker can
 * never read a colleague's records). Fail-soft: signed-out / API-down just
 * renders the card's honest error state; this page has never gated.
 */
async function loadMyLicences(): Promise<{
  credentials: ReadonlyArray<Credential>;
  fetchError: string | null;
}> {
  try {
    const store = await cookies();
    const raw = store.get(SESSION_COOKIE)?.value;
    if (!raw) return { credentials: [], fetchError: "not signed in" };
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    const proto = h.get("x-forwarded-proto") ?? "http";
    const base = host ? `${proto}://${host}` : "http://localhost:3000";
    const res = await fetch(`${base}/api/licences?mine=1`, {
      cache: "no-store",
      headers: { cookie: `${SESSION_COOKIE}=${raw}` },
    });
    if (!res.ok) return { credentials: [], fetchError: `API ${res.status}` };
    const parsed = CredentialListResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { credentials: [], fetchError: "bad shape" };
    return { credentials: parsed.data.credentials, fetchError: null };
  } catch (err) {
    return {
      credentials: [],
      fetchError: err instanceof Error ? err.message : "network error",
    };
  }
}

/** #332: own induction history (?mine=1 — session identity only). Fail-soft. */
async function loadMyInductions(): Promise<{
  records: ReadonlyArray<InductionRecord>;
  fetchError: string | null;
}> {
  try {
    const store = await cookies();
    const raw = store.get(SESSION_COOKIE)?.value;
    if (!raw) return { records: [], fetchError: "not signed in" };
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    const proto = h.get("x-forwarded-proto") ?? "http";
    const base = host ? `${proto}://${host}` : "http://localhost:3000";
    const res = await fetch(`${base}/api/job-inductions?mine=1`, {
      cache: "no-store",
      headers: { cookie: `${SESSION_COOKIE}=${raw}` },
    });
    if (!res.ok) return { records: [], fetchError: `API ${res.status}` };
    const parsed = MyInductionHistoryResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { records: [], fetchError: "bad shape" };
    return { records: parsed.data.records, fetchError: null };
  } catch (err) {
    return {
      records: [],
      fetchError: err instanceof Error ? err.message : "network error",
    };
  }
}
