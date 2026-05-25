import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { StatusChip } from "./StatusChip";

interface AttentionBannerProps {
  /** Short tag in the corner ("Rejected", "Missing", "Needs you"). */
  chip: string;
  /** Chip tone — defaults to danger for blocking items. */
  tone?: "danger" | "warning" | "info";
  /** Main line — what happened. */
  title: string;
  /** Optional secondary line — what the worker should do next. */
  description?: ReactNode;
  /** Optional inline CTA — typically a Link wrapped around plain text. */
  cta?: ReactNode;
  className?: string;
}

/**
 * Surface admin decisions or environment states the worker must act on.
 *
 * Per the Interface Bible vNext §13 (AttentionBanner component spec) and
 * §16.3 (Pass 1 quick wins):
 *   - Top of /v2/phil for rejected hours, rejected snags, missing gear.
 *   - Red wash · status chip · short message · CTA.
 *   - Order: rejections first, missing second. Stack at most two.
 *
 * Renders as a region with role="status" so assistive tech announces it
 * the same way the existing rejection callouts in JobSnagsPanel do.
 */
export function AttentionBanner({
  chip,
  tone = "danger",
  title,
  description,
  cta,
  className,
}: AttentionBannerProps) {
  const bg =
    tone === "danger"
      ? "border-rose-200 bg-rose-50 text-rose-900"
      : tone === "warning"
        ? "border-amber-200 bg-amber-50 text-amber-900"
        : "border-sky-200 bg-sky-50 text-sky-900";
  return (
    <section
      role="status"
      className={cn(
        "flex flex-col gap-2 rounded-card border p-3.5",
        bg,
        className
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="font-display text-[15px] font-semibold leading-snug text-text">
          {title}
        </p>
        <StatusChip tone={tone} className="shrink-0">
          {chip}
        </StatusChip>
      </div>
      {description ? (
        <p className="text-sm leading-snug">{description}</p>
      ) : null}
      {cta ? <div className="pt-0.5 text-sm font-medium">{cta}</div> : null}
    </section>
  );
}
