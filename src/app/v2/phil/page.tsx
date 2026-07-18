import Link from "next/link";
import type { Route } from "next";
import { cookies, headers } from "next/headers";
import { isFlagEnabled } from "../../../../api/_lib/feature-flags.js";
import { PhilShell } from "@/components/phil/PhilShell";
import { PhilMyLicencesCard } from "@/components/phil/PhilMyLicencesCard";
import { PhilMyInductionsCard } from "@/components/phil/PhilMyInductionsCard";
import { PhilMyRecordCard } from "@/components/phil/PhilMyRecordCard";
import {
  MyInductionHistoryResponseSchema,
  type InductionRecord,
} from "@/domains/jobs/induction";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { CredentialListResponseSchema } from "@/domains/workforce/schema";
import type { Credential } from "@/domains/workforce/types";
import {
  MyStatsRecordResponseSchema,
  type MyRecordWindow,
} from "@/domains/workforce/my-record";
import { PhilSignOutButton } from "@/components/phil/PhilSignOutButton";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { PushNotificationsCard } from "@/components/pwa/PushNotificationsCard";

/**
 * /v2/phil — Phil landing / "More" tab profile placeholder.
 *
 * Per the Interface Bible vNext §16.4 (Pass 1 — "Demote the four nav
 * cards on Phil home"), this surface no longer duplicates the bottom-tab
 * links to /phil/my-day, /phil/jobs and /phil/gear. The tab bar owns
 * those. What remains is: a short orientation line, an onboarding replay
 * card, and the worker's own account / leave / record cards.
 */
export const dynamic = "force-dynamic";

export default async function PhilV2HomePage() {
  // The signed-in worker's id — so sign-out can purge their client-only recent +
  // pinned jobs prefs (#145) on a shared device. Best-effort: absent → no purge.
  const store = await cookies();
  const session = decodeSessionCookie(store.get(SESSION_COOKIE)?.value);
  const viewerId = session?.userId ?? session?.sub ?? "";
  const [{ credentials, fetchError }, inductions, myRecord, observationsEnabled] =
    await Promise.all([
      loadMyLicences(),
      loadMyInductions(),
      loadMyRecord(),
      // observations_inbox gates the Capture launcher's observation options.
      isFlagEnabled("observations_inbox", session),
    ]);
  return (
    <PhilShell title="Phil" observationsEnabled={observationsEnabled}>
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
          <PhilSignOutButton userId={viewerId} />
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

        {/* #340: the worker's own recent work — trailing-weeks hours + the
            jobs they've been on. Self-only, read-only, built from their own
            logged hours (P7). */}
        <PhilMyRecordCard
          record={myRecord.record}
          fetchError={myRecord.fetchError}
        />

        <PushNotificationsCard audience="phil" />
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

/**
 * #340: own work record — the self-only `window` block off GET /api/my-stats.
 * That endpoint is identity-by-cookie with NO userId parameter, so a worker
 * can only ever read their own hours. Fail-soft: signed-out / API-down just
 * renders the card's honest error or empty state.
 */
async function loadMyRecord(): Promise<{
  record: MyRecordWindow | null;
  fetchError: string | null;
}> {
  try {
    const store = await cookies();
    const raw = store.get(SESSION_COOKIE)?.value;
    if (!raw) return { record: null, fetchError: "not signed in" };
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    const proto = h.get("x-forwarded-proto") ?? "http";
    const base = host ? `${proto}://${host}` : "http://localhost:3000";
    const res = await fetch(`${base}/api/my-stats`, {
      cache: "no-store",
      headers: { cookie: `${SESSION_COOKIE}=${raw}` },
    });
    if (!res.ok) return { record: null, fetchError: `API ${res.status}` };
    const parsed = MyStatsRecordResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { record: null, fetchError: "bad shape" };
    return { record: parsed.data.window, fetchError: null };
  } catch (err) {
    return {
      record: null,
      fetchError: err instanceof Error ? err.message : "network error",
    };
  }
}
