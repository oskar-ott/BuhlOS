"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Route } from "next";
import { Card, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { fetchClaimsView, type ClaimsViewWire } from "@/domains/progress-claims/client";
import { formatCentsAud } from "@/domains/progress-claims/math";

/**
 * Job-hub progress-claims card (#372): the derived claimed-to-date position +
 * the latest claim's status, linking into the /claims register. Rendered by
 * the hub ONLY when the `progress_claims` flag is on for an admin viewer; the
 * endpoint additionally 404s when dark and 403s non-admin, so a failed fetch
 * hides the card (a money surface never leaks and never renders a fake 0).
 */
export function JobClaimsCard({ jobId }: { jobId: string }) {
  const [view, setView] = useState<ClaimsViewWire | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "hidden">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchClaimsView(jobId);
      if (cancelled) return;
      if (res.kind !== "ok") {
        setState("hidden");
        return;
      }
      setView(res.view);
      setState("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (state === "hidden") return null;

  const claims = view?.claims ?? [];
  const latest = claims.length > 0 ? claims.reduce((a, b) => (b.number > a.number ? b : a)) : null;

  return (
    <Card data-testid="job-claims-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Progress claims</CardTitle>
        <Link
          href={`/v2/jobs/${encodeURIComponent(jobId)}/claims` as Route}
          className="text-sm underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          Open register
        </Link>
      </div>
      {state === "loading" || !view ? (
        <p className="mt-2 text-sm text-text-muted">Loading…</p>
      ) : claims.length === 0 ? (
        <p className="mt-2 text-sm text-text-muted">
          No claims yet — build claim 1 from{" "}
          {view.seed.source === "quote"
            ? "the linked quote's priced lines"
            : view.seed.source === "packages"
              ? "the compiled work packages"
              : "scratch"}
          .
        </p>
      ) : (
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <div className="rounded-card border border-border bg-surface px-3 py-2">
            <div className="font-display text-base text-text">
              {formatCentsAud(view.derived.claimedToDateCents)}
            </div>
            <div className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
              Claimed to date
            </div>
          </div>
          <div className="rounded-card border border-border bg-surface px-3 py-2">
            <div className="font-display text-base text-text">
              {view.derived.oldestUnpaidDays == null ? "—" : `${view.derived.oldestUnpaidDays}d`}
            </div>
            <div className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
              Oldest unpaid
            </div>
          </div>
          <div className="rounded-card border border-border bg-surface px-3 py-2">
            <div className="flex items-center gap-1.5">
              <span className="font-display text-base text-text">Claim {latest?.number}</span>
              {latest ? (
                <Pill
                  tone={
                    latest.status === "paid"
                      ? "success"
                      : latest.status === "draft"
                        ? "neutral"
                        : "info"
                  }
                >
                  {latest.status}
                </Pill>
              ) : null}
            </div>
            <div className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
              Latest claim
            </div>
          </div>
        </dl>
      )}
    </Card>
  );
}
