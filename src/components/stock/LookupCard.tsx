"use client";

import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { LOOKUP_LABEL } from "@/domains/workshop-stock/format";
import type { LookupResult } from "@/domains/workshop-stock/schema";
import { MiniButton } from "./ui";

const TONE: Record<LookupResult["status"], { box: string; dot: string }> = {
  manufacturer_code_matched: { box: "border-state-success-subtle-border bg-state-success-subtle-bg", dot: "bg-state-success-dot" },
  possible_match: { box: "border-state-warning-subtle-border bg-state-warning-subtle-bg", dot: "bg-state-warning-dot" },
  no_match: { box: "border-border bg-surface-subtle", dot: "bg-state-neutral-dot" },
  unavailable: { box: "border-border bg-surface-subtle", dot: "bg-state-neutral-dot" },
  not_configured: { box: "border-border bg-surface-subtle", dot: "bg-state-neutral-dot" },
  not_checked: { box: "border-border bg-surface-subtle", dot: "bg-state-neutral-dot" },
};

/**
 * The online code check, shown as evidence — never as a certificate: the
 * status, what the listing calls it, the exact code as the source writes it, a
 * link to the source, every reason it is not a clean match, and the one
 * disclaimer. "Use these details" is the one confirmation and fills only the
 * empty fields; ignoring it saves the item as "saved without external
 * verification".
 */
export function LookupCard({
  state,
  result,
  accepted,
  onAccept,
  onReject,
  onRetry,
  acceptLabel = "Use these details · fills the empty fields only",
}: {
  state: "idle" | "checking" | "done";
  result: LookupResult | null;
  accepted: boolean | null;
  onAccept: () => void;
  onReject: () => void;
  onRetry?: () => void;
  acceptLabel?: string;
}) {
  if (state === "checking") {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-subtle p-3 text-sm text-text-muted" role="status" data-testid="stock-lookup-checking">
        <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" />
        Checking the code with the maker and wholesaler sites…
      </div>
    );
  }
  if (!result || state === "idle") return null;
  const c = result.candidate;
  const actionable = (result.status === "manufacturer_code_matched" || result.status === "possible_match") && c;
  const t = TONE[result.status];
  const described = c ? [c.brand, c.name || c.sourceTitle].filter(Boolean).join(" ") : null;
  return (
    <div className={cn("space-y-1.5 rounded-xl border p-3", t.box)} data-testid="stock-lookup-card" data-status={result.status}>
      <p className="font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-text-muted">Online check{result.cached ? " · checked earlier" : ""}</p>
      <p className="flex items-center gap-2 text-[15px] font-bold text-text">
        <span aria-hidden="true" className={cn("inline-block h-2 w-2 rounded-full", t.dot)} />
        <span data-testid="stock-lookup-status">{LOOKUP_LABEL[result.status]}</span>
      </p>
      {result.reasons.length ? (
        <ul className="space-y-0.5 text-sm text-text" data-testid="stock-lookup-reasons">
          {result.reasons.map((r) => (
            <li key={r}>
              <strong className="font-semibold">{r}</strong>
            </li>
          ))}
        </ul>
      ) : null}
      {actionable && c ? (
        <>
          {described ? <p className="text-sm text-text">{described}{c.colour ? ` · ${c.colour}` : ""}</p> : null}
          <p className="text-sm text-text">
            Source:{" "}
            {c.sourceUrl ? (
              <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="font-semibold text-state-info underline" data-testid="stock-lookup-source">
                {c.sourceDomain || "listing"}
              </a>
            ) : (
              <span className="font-semibold">{c.sourceDomain || "listing"}</span>
            )}
            {c.codeAsWritten ? (
              <>
                {" "}· code as written there: <span className="font-mono">{c.codeAsWritten}</span>
              </>
            ) : null}
          </p>
        </>
      ) : null}
      <p className="text-[13px] italic text-text-muted">A public listing using this code — not a certification or a check that it suits the job.</p>
      {actionable ? (
        accepted === true ? (
          <p className="text-sm font-semibold text-state-success-subtle-text">Details used · filled the empty fields only · your name was kept</p>
        ) : (
          <div className="flex flex-wrap gap-2 pt-0.5">
            <MiniButton onClick={onAccept} data-testid="stock-lookup-accept">
              {acceptLabel}
            </MiniButton>
            <button type="button" onClick={onReject} aria-pressed={accepted === false} className="min-h-[44px] px-2 text-sm font-semibold text-text-muted underline" data-testid="stock-lookup-reject">
              Not this product
            </button>
          </div>
        )
      ) : onRetry && result.status === "unavailable" ? (
        <div>
          <MiniButton onClick={onRetry}>Check this code online again</MiniButton>
        </div>
      ) : null}
    </div>
  );
}
