import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { QuotesList } from "@/components/admin/QuotesList";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { QuoteListResponseSchema, type QuoteSummary } from "@/domains/quoting/schema";

export const dynamic = "force-dynamic";

/**
 * /v2/quotes — the v2 quotes list (#183), first surface of the Epic 7
 * rebuild (#172 MIGRATE-BY-REBUILD ruling).
 *
 * Server component (jobs-index pattern):
 *   1. Gate auth via session cookie (middleware also gates this prefix).
 *   2. Require the ADMIN surface — quoting is commercial, so unlike
 *      /v2/jobs there is no LH read access.
 *   3. Fetch /api/quotes-v2 server-side with the session cookie; parse at
 *      the boundary (QuoteListResponseSchema, archived already filtered
 *      server-side).
 *   4. Hand rows to <QuotesList /> (client: rows + create flow).
 *
 * Parked on /v2/quotes (no vercel.json change), same canonical-URL future
 * as /v2/jobs. Legacy /admin/quotes was deleted by the cutover (#376) and
 * 307s to /command-centre; the two legacy draft shells stay in the legacy
 * store (see the honest note in QuotesList).
 *
 * Cross-ref:
 *   src/app/v2/jobs/page.tsx — the pattern reference
 *   api/quotes-v2.js — list/create/save/archive endpoint
 *   docs/quoting-legacy-audit.md — the #172 ruling this build follows
 */
export default async function QuotesPage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/v2/quotes");
  }
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }

  const { quotes, fetchError } = await loadQuotes(raw);

  return (
    <AdminShell title="Quotes">
      <div className="mx-auto max-w-5xl space-y-4">
        {fetchError ? (
          <Card className="border-amber-200 bg-amber-50" role="alert">
            <CardTitle>Couldn&rsquo;t load quotes</CardTitle>
            <CardDescription className="text-amber-900">
              {fetchError}. Try refreshing in a moment.
            </CardDescription>
          </Card>
        ) : (
          <QuotesList quotes={quotes} />
        )}
      </div>
    </AdminShell>
  );
}

async function loadQuotes(cookieValue: string | undefined): Promise<{
  quotes: ReadonlyArray<QuoteSummary>;
  fetchError: string | null;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";

  try {
    const res = await fetch(`${base}/api/quotes-v2`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (!res.ok) {
      return { quotes: [], fetchError: `API returned ${res.status}` };
    }
    const body = await res.json();
    const parsed = QuoteListResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { quotes: [], fetchError: "Unexpected response shape" };
    }
    return { quotes: parsed.data.quotes, fetchError: null };
  } catch (err) {
    return {
      quotes: [],
      fetchError: err instanceof Error ? err.message : "Network error",
    };
  }
}
