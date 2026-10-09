"use client";

import { useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { LOOKUP_LABEL } from "@/domains/workshop-stock/format";
import type { LookupResult } from "@/domains/workshop-stock/schema";

const TONE: Record<LookupResult["status"], string> = {
  manufacturer_code_matched: "border-state-success text-state-success",
  possible_match: "border-state-warning text-state-warning",
  no_match: "border-border-strong text-text-muted",
  unavailable: "border-border-strong text-text-muted",
  not_configured: "border-border-strong text-text-muted",
  not_checked: "border-border-strong text-text-muted",
};

/**
 * The online code check for a NEW item, shown as evidence — never as a
 * certificate. Status chip, what the source calls it, the exact code as the
 * source writes it, a link to the source, and every reason it is not a clean
 * match. "Use these details" is the one confirmation; ignoring it saves the
 * item as "saved without external verification".
 */
export function LookupCard({
  state,
  result,
  accepted,
  onAccept,
  onReject,
  onRetry,
}: {
  state: "idle" | "checking" | "done";
  result: LookupResult | null;
  accepted: boolean | null;
  onAccept: () => void;
  onReject: () => void;
  onRetry?: () => void;
}) {
  // The listing photo is a nice-to-have from the source site: if it won't load, show none.
  const [imageFailed, setImageFailed] = useState(false);
  if (state === "checking") {
    return (
      <div className="flex items-center gap-3 rounded-card border border-border bg-surface-subtle p-3 text-sm text-text-muted" role="status" data-testid="stock-lookup-checking">
        <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" />
        Checking the code with the maker and wholesaler sites…
      </div>
    );
  }
  if (!result || state === "idle") return null;
  const c = result.candidate;
  const actionable = (result.status === "manufacturer_code_matched" || result.status === "possible_match") && c;
  return (
    <div className="space-y-2 rounded-card border border-border bg-surface-raised p-3" data-testid="stock-lookup-card" data-status={result.status}>
      <div className="flex items-center justify-between gap-2">
        <span className={cn("inline-flex items-center rounded-pill border px-2 py-0.5 text-xs font-semibold", TONE[result.status])} data-testid="stock-lookup-status">
          {LOOKUP_LABEL[result.status]}
        </span>
        {result.cached ? <span className="text-xs text-text-muted">checked earlier</span> : null}
      </div>
      {actionable && c ? (
        <div className="flex gap-3">
          {c.imageUrl && !imageFailed ? (
            // eslint-disable-next-line @next/next/no-img-element -- an allowlisted maker/wholesaler image, no referrer sent
            <img src={c.imageUrl} alt="" referrerPolicy="no-referrer" loading="lazy" onError={() => setImageFailed(true)} className="h-16 w-16 shrink-0 rounded-card border border-border object-contain" />
          ) : null}
          <div className="min-w-0 text-sm">
            <p className="font-semibold text-text">{c.name || c.sourceTitle || "Listing"}</p>
            <p className="text-text-muted">
              {[c.brand, c.codeAsWritten ? `code ${c.codeAsWritten}` : null, c.colour].filter(Boolean).join(" · ")}
            </p>
            {c.sourceUrl ? (
              <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="mt-1 inline-flex min-h-[44px] items-center gap-1 font-semibold text-brand-navy underline" data-testid="stock-lookup-source">
                {c.sourceDomain || "Source"} <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
      {result.reasons.length ? (
        <ul className="list-disc space-y-0.5 pl-5 text-sm text-text-muted" data-testid="stock-lookup-reasons">
          {result.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
      <p className="text-xs text-text-muted">A public listing using this code — not a certification or a check that it suits the job.</p>
      {actionable ? (
        <div className="grid grid-cols-2 gap-2 pt-1">
          <button type="button" onClick={onAccept} aria-pressed={accepted === true} className={cn("min-h-[48px] rounded-card border px-3 text-sm font-semibold", accepted === true ? "border-brand-navy bg-brand-navy text-text-inverse" : "border-border-strong text-text")} data-testid="stock-lookup-accept">
            {accepted === true ? "Using these details" : "Use these details"}
          </button>
          <button type="button" onClick={onReject} aria-pressed={accepted === false} className={cn("min-h-[48px] rounded-card border px-3 text-sm font-semibold", accepted === false ? "border-brand-navy bg-surface-subtle text-text" : "border-border-strong text-text")} data-testid="stock-lookup-reject">
            Not this product
          </button>
        </div>
      ) : onRetry && (result.status === "unavailable") ? (
        <button type="button" onClick={onRetry} className="min-h-[44px] text-sm font-semibold text-brand-navy">Try the check again</button>
      ) : null}
    </div>
  );
}
