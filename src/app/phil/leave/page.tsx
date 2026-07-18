import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { isFlagEnabled } from "../../../../api/_lib/feature-flags.js";
import { PhilShell } from "@/components/phil/PhilShell";
import { PhilPageIntro } from "@/components/phil/ui/PhilPageIntro";
import { PhilBackLink } from "@/components/phil/ui/PhilBackLink";
import { PhilLeaveClient } from "@/components/phil/PhilLeaveClient";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { LeaveListResponseSchema } from "@/domains/timesheets/schema";
import { BUSINESS_TIMEZONE, localDateString } from "@/domains/timesheets/service";
import type { LeaveRequest } from "@/domains/timesheets/types";

export const dynamic = "force-dynamic";

/** /phil/leave (#333) — request → office approval → "missing" exemption. */
export default async function PhilLeavePage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/phil/leave");
  }
  if (!canAccessSurface(session.role, "phil")) {
    redirect("/v2/login");
  }

  // observations_inbox gates the Capture launcher's observation options
  // (server-resolved boolean; cached flags.json read).
  const [{ requests, error }, observationsEnabled] = await Promise.all([
    loadMine(raw),
    isFlagEnabled("observations_inbox", session),
  ]);
  const todayISO = localDateString(new Date(), BUSINESS_TIMEZONE);

  return (
    <PhilShell
      title="Leave"
      userId={session.userId ?? ""}
      observationsEnabled={observationsEnabled}
    >
      <div className="space-y-4">
        <PhilBackLink href="/phil/my-day">My day</PhilBackLink>
        <PhilPageIntro
          title="Leave"
          description="Request time off and see what the office decided. Once the office approves, those days stop showing as missing hours."
        />
        <PhilLeaveClient initialRequests={requests} fetchError={error} todayISO={todayISO} />
      </div>
    </PhilShell>
  );
}

async function loadMine(
  cookieValue: string | undefined,
): Promise<{ requests: LeaveRequest[]; error: string | null }> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(`${base}/api/leave?mine=1`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (!res.ok) return { requests: [], error: `Leave API returned ${res.status}` };
    const parsed = LeaveListResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { requests: [], error: "Unexpected response shape" };
    return { requests: [...parsed.data.requests], error: null };
  } catch (err) {
    return { requests: [], error: err instanceof Error ? err.message : "Network error" };
  }
}
