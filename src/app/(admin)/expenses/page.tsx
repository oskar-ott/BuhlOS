import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { ExpensesReviewQueue } from "@/components/admin/ExpensesReviewQueue";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { ExpenseListResponseSchema } from "@/domains/expenses/schema";
import type { ExpenseItem } from "@/domains/expenses/types";

export const dynamic = "force-dynamic";

/**
 * /expenses — the BuhlOS reimbursement review queue (#536).
 *
 * Field workers submit a receipt + amount + category in Phil; this is the
 * office surface that reviews them and moves each submitted → approved →
 * reimbursed (or declines). Server component does the cookie-bearing fetch
 * against /api/expenses (admin sees all); the client component owns the
 * filtering + the review transitions (admin-gated PATCH).
 *
 * Boundary (payroll-boundary ADR #609): BuhlOS captures + approves; the actual
 * payout runs through payroll/Xero (#249) — not built here.
 *
 * Cross-ref:
 *   docs/route-ownership.md §4/§8/§9 — /expenses is APPROVED
 *   api/expenses.js · src/domains/expenses/*
 */
export default async function ExpensesPage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/expenses");
  }
  // Office/admin surface — matches the admin-tier list gate in api/expenses.js.
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }

  const { expenses, fetchError } = await loadExpenses(raw);

  return (
    <AdminShell title="Expenses">
      <div className="mx-auto max-w-4xl space-y-5">
        <Card>
          <CardTitle>Expenses</CardTitle>
          <CardDescription>
            Receipts the crew paid for out of pocket — fuel, parking, materials, tolls — submitted
            from Phil for reimbursement. Review the receipt, then approve and mark reimbursed once
            it&rsquo;s paid.
          </CardDescription>
        </Card>

        <ExpensesReviewQueue initialExpenses={expenses} fetchError={fetchError} />
      </div>
    </AdminShell>
  );
}

async function loadExpenses(cookieValue: string | undefined): Promise<{
  expenses: ReadonlyArray<ExpenseItem>;
  fetchError: string | null;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";

  try {
    const res = await fetch(`${base}/api/expenses`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (!res.ok) {
      return { expenses: [], fetchError: `API returned ${res.status}` };
    }
    const parsed = ExpenseListResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      return { expenses: [], fetchError: "Unexpected response shape" };
    }
    return { expenses: parsed.data.expenses, fetchError: null };
  } catch (err) {
    return {
      expenses: [],
      fetchError: err instanceof Error ? err.message : "Network error",
    };
  }
}
