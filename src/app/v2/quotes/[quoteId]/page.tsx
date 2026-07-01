import Link from "next/link";
import type { Route } from "next";
import { notFound, redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { QuoteBuilderClient } from "@/components/admin/QuoteBuilderClient";
import { QuoteDeliveryCard } from "@/components/admin/QuoteDeliveryCard";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { isFlagEnabled } from "../../../../../api/_lib/feature-flags.js";
import { canAccessSurface } from "@/lib/auth/permissions";
import { QuoteDetailResponseSchema, type Quote } from "@/domains/quoting/schema";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ quoteId: string }>;
}

/**
 * /v2/quotes/[quoteId] — the v2 quote builder (#183).
 *
 * Loads the FULL document (quotes-v2/<id>.json via GET /api/quotes-v2?id=)
 * server-side and hands it to the client builder, which holds the loaded
 * `updatedAt` as its save precondition — a save racing another tab 409s and
 * surfaces the stale banner instead of silently overwriting (issue #183
 * requirement 3/4).
 *
 * Admin tier only (commercial figures) — same gate as the list page;
 * middleware gates the prefix, this is defence-in-depth.
 *
 * Cross-ref:
 *   src/components/admin/QuoteBuilderClient.tsx — the builder itself
 *   src/app/v2/jobs/[jobId]/builder/page.tsx — the pattern reference
 *   api/quotes-v2.js — document read + full-document save
 */
export default async function QuoteBuilderPage({ params }: PageParams) {
  const { quoteId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/v2/quotes/${quoteId}`)}`);
  }
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }
  if (!(await isFlagEnabled("quotes", session))) notFound();

  const result = await loadQuote(raw, quoteId);

  if (result.kind !== "ok") {
    return (
      <AdminShell title="Quote">
        <div className="mx-auto max-w-5xl space-y-4">
          <Card role="alert">
            <CardTitle>
              {result.kind === "not_found" ? "Quote not found" : "Couldn’t load this quote"}
            </CardTitle>
            <CardDescription className="mt-1">
              {result.kind === "not_found"
                ? "It may have been created in the old quoting tool, or the link is stale."
                : `${result.message}. Try refreshing in a moment.`}
            </CardDescription>
            <p className="mt-3 text-sm">
              <Link
                href={"/v2/quotes" as Route}
                className="font-medium text-brand-navy underline underline-offset-2"
              >
                Back to all quotes
              </Link>
            </p>
          </Card>
        </div>
      </AdminShell>
    );
  }

  return (
    <AdminShell title="Quote builder">
      <div className="space-y-4">
        {/* #240: client-facing lifecycle (sent → viewed → accepted/declined). */}
        <QuoteDeliveryCard quoteId={result.quote.id} />
        <QuoteBuilderClient initialQuote={result.quote} />
      </div>
    </AdminShell>
  );
}

type LoadResult =
  | { kind: "ok"; quote: Quote }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

async function loadQuote(cookieValue: string | undefined, quoteId: string): Promise<LoadResult> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";

  try {
    const res = await fetch(`${base}/api/quotes-v2?id=${encodeURIComponent(quoteId)}`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (res.status === 404) return { kind: "not_found" };
    if (!res.ok) return { kind: "error", message: `API returned ${res.status}` };
    const body = await res.json();
    const parsed = QuoteDetailResponseSchema.safeParse(body);
    if (!parsed.success) return { kind: "error", message: "Unexpected response shape" };
    return { kind: "ok", quote: parsed.data.quote };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : "Network error" };
  }
}
