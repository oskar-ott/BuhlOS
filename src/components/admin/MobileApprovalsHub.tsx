"use client";

import { useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { ArrowRight, ClipboardCheck, FileCheck2, Package, Receipt, Wallet } from "lucide-react";
import { cn } from "@/lib/cn";
import { Card } from "@/components/ui/Card";

/**
 * Mobile Approvals triage (md:hidden) — the consolidated "what's waiting on
 * me?" view for a boss on a phone, sitting above the hours approval queue on
 * /hours/approvals.
 *
 * Hours are the page's main content (the existing, already-responsive queue
 * below), so this hub consolidates the OTHER day-to-day approval types into one
 * chip-filtered screen with REAL counts and a one-tap route into each type's
 * own (responsive) surface — clearing approvals fast one-handed without faking
 * a uniform approve/decline across five different action models.
 *
 * Truth over theatre (P7): counts are real or absent. Dayworks are SIGNED, not
 * office-approved, so that chip routes to the register rather than implying an
 * approve action. Proof to sign off (#503) is intentionally NOT here — it has
 * its own flagged surface on the Command Centre ("Today"), so this hub never
 * claims to host it (which would disagree with that surface).
 */

export interface MobileApprovalsCounts {
  /** Submitted expense claims awaiting review. */
  expenses: number;
  /** Witnessed ITPs awaiting sign-off (cross-job rollup). */
  itps: number;
  /** Open material requests awaiting the office. */
  materials: number;
}

type ChipKey = "expenses" | "itps" | "materials" | "dayworks";

export function MobileApprovalsHub({ counts }: { counts: MobileApprovalsCounts }) {
  // Default to the first type that actually has items, else Expenses.
  const initial: ChipKey =
    counts.expenses > 0
      ? "expenses"
      : counts.itps > 0
        ? "itps"
        : counts.materials > 0
          ? "materials"
          : "expenses";
  const [active, setActive] = useState<ChipKey>(initial);

  const daily = counts.expenses + counts.itps + counts.materials;

  const chips: Array<{ key: ChipKey; label: string; n?: number }> = [
    { key: "expenses", label: "Expenses", n: counts.expenses },
    { key: "itps", label: "ITPs", n: counts.itps },
    { key: "materials", label: "Materials", n: counts.materials },
    { key: "dayworks", label: "Dayworks" },
  ];

  return (
    <section className="space-y-3 md:hidden" aria-label="Approvals triage">
      <div className="px-1">
        <p className="font-mono text-[11px] uppercase tracking-widest text-text-muted">
          {daily > 0 ? `${daily} to action today` : "All clear"}
        </p>
      </div>

      {/* Filter chips with live counts (horizontal scroll). */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {chips.map((c) => {
          const isActive = active === c.key;
          return (
            <button
              key={c.key}
              type="button"
              aria-pressed={isActive}
              onClick={() => setActive(c.key)}
              className={cn(
                "inline-flex h-11 shrink-0 items-center gap-1.5 rounded-pill border px-3.5 text-sm",
                isActive
                  ? "border-brand-navy bg-brand-navy text-text-inverse"
                  : "border-border bg-surface text-text",
              )}
            >
              {c.label}
              {typeof c.n === "number" ? (
                <span
                  className={cn(
                    "font-mono text-[11px] font-semibold",
                    isActive ? "text-text-inverse/70" : "text-text-muted",
                  )}
                >
                  {c.n}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {active === "expenses" ? (
        <TypePanel
          icon={<Wallet aria-hidden="true" className="h-5 w-5" />}
          title="Expense claims"
          count={counts.expenses}
          empty="No expense claims waiting for you."
          line="Open the claim to see the receipt and breakdown, then approve or decline."
          href={"/expenses" as Route}
          cta="Review expenses"
        />
      ) : null}

      {active === "itps" ? (
        <TypePanel
          icon={<FileCheck2 aria-hidden="true" className="h-5 w-5" />}
          title="ITPs to sign off"
          count={counts.itps}
          empty="No ITPs waiting for sign-off."
          line="Witnessed inspection & test plans awaiting an independent office sign-off."
          href={"/qa" as Route}
          cta="Open QA status"
        />
      ) : null}

      {active === "materials" ? (
        <TypePanel
          icon={<Package aria-hidden="true" className="h-5 w-5" />}
          title="Material requests"
          count={counts.materials}
          empty="No material requests waiting on the office."
          line="Approve a request so procurement can place the order."
          href={"/material-requests" as Route}
          cta="Open material requests"
        />
      ) : null}

      {active === "dayworks" ? (
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-surface-subtle text-text-muted">
              <Receipt aria-hidden="true" className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-display text-sm font-semibold text-text">Daywork dockets</p>
              <p className="text-xs text-text-muted">
                Dockets are <strong>signed</strong> by the builder&rsquo;s supervisor, not approved
                by the office — the register tracks payment risk (unsigned, aging).
              </p>
            </div>
          </div>
          <Link
            href={"/v2/dayworks" as Route}
            className="mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-card bg-brand-navy px-4 text-sm font-medium text-text-inverse hover:bg-accent-ink"
          >
            Open daywork register
            <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </Link>
        </Card>
      ) : null}

      <p className="px-1 text-xs text-text-muted">
        <ClipboardCheck aria-hidden="true" className="mr-1 inline h-3.5 w-3.5 align-text-bottom" />
        Approve here on the move; payroll export, PO raising and the full audit trail run in BuhlOS on
        desktop.
      </p>
    </section>
  );
}

function TypePanel({
  icon,
  title,
  count,
  empty,
  line,
  href,
  cta,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  empty: string;
  line: string;
  href: Route;
  cta: string;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-brand-navy text-accent-yellow">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-display text-sm font-semibold text-text">{title}</p>
          <p className="text-xs text-text-muted">{count > 0 ? line : empty}</p>
        </div>
        {count > 0 ? (
          <span className="flex h-7 min-w-[28px] shrink-0 items-center justify-center rounded-pill bg-accent-yellow px-2 font-display text-sm font-bold text-brand-navy">
            {count}
          </span>
        ) : null}
      </div>
      {count > 0 ? (
        <Link
          href={href}
          className="mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-card bg-brand-navy px-4 text-sm font-medium text-text-inverse hover:bg-accent-ink"
        >
          {cta}
          <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </Link>
      ) : null}
    </Card>
  );
}
