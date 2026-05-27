"use client";

import { AlertOctagon, AlertTriangle, Info } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { cn } from "@/lib/cn";
import {
  deriveAttention,
  type AttentionItem,
  type AttentionTone,
  type DeriveAttentionInput,
} from "./PhilJobAttention";

const TONE_STYLES: Record<
  AttentionTone,
  {
    container: string;
    label: string;
    icon: ComponentType<SVGProps<SVGSVGElement>>;
    iconClass: string;
    actionClass: string;
  }
> = {
  danger: {
    container: "border-rose-300 bg-rose-50",
    label: "text-rose-700",
    icon: AlertOctagon,
    iconClass: "text-rose-600",
    actionClass:
      "border-rose-300 bg-rose-100 text-rose-900 hover:bg-rose-200",
  },
  warning: {
    container: "border-amber-300 bg-amber-50",
    label: "text-amber-700",
    icon: AlertTriangle,
    iconClass: "text-amber-700",
    actionClass:
      "border-amber-300 bg-amber-100 text-amber-900 hover:bg-amber-200",
  },
  info: {
    container: "border-brand-navy/20 bg-brand-navy/[0.04]",
    label: "text-brand-navy/80",
    icon: Info,
    iconClass: "text-brand-navy",
    actionClass:
      "border-brand-navy/30 bg-surface text-brand-navy hover:bg-surface-subtle",
  },
};

/**
 * Phil — Job needs-attention strip.
 *
 * Renders the items returned by {@link deriveAttention} as the Bible's
 * "Needs Attention" block: max three rows, every row carrying its
 * reasonShown line and a single direct action. Renders nothing when no
 * items qualify (per bible §07 — "do not show no-alerts").
 *
 * Action targets are in-page anchors by default — the rest of the job
 * detail lives below this strip on the same scroll surface. We use a
 * smooth-scroll on click rather than a Next router push so the rest of
 * the page state stays intact (selected stage, selected area).
 *
 * Cross-ref:
 *   /tmp/phil-bible/buhlos-phil/project/Phil Job Interface Bible.html §07
 *   src/components/phil/PhilJobAttention.ts — derivation logic
 *   src/components/phil/PhilJobDetail.tsx — caller
 */
export function PhilJobAttentionStrip(props: DeriveAttentionInput) {
  const { items, total } = deriveAttention(props);
  if (items.length === 0) return null;

  return (
    <section
      aria-labelledby="phil-job-attention-h"
      className="rounded-card border border-border bg-surface-raised p-3 shadow-card"
    >
      <div className="flex items-baseline justify-between gap-2 px-1">
        <h2
          id="phil-job-attention-h"
          className="font-display text-[11px] font-semibold uppercase tracking-wider text-text-muted"
        >
          Needs attention
        </h2>
        {total > items.length ? (
          <span
            className="text-[11px] uppercase tracking-wider text-text-muted"
            aria-live="polite"
          >
            {items.length} of {total}
          </span>
        ) : null}
      </div>
      <ul className="mt-2 space-y-2">
        {items.map((item) => (
          <AttentionRow key={item.id} item={item} />
        ))}
      </ul>
    </section>
  );
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const tone = TONE_STYLES[item.tone];
  const Icon = tone.icon;
  return (
    <li className={cn("rounded-card border-l-4 p-3", tone.container)}>
      <div className="flex items-start gap-2.5">
        <Icon
          aria-hidden="true"
          className={cn("h-4 w-4 shrink-0", tone.iconClass)}
        />
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "font-display text-[10px] font-semibold uppercase tracking-wider",
              tone.label,
            )}
          >
            {item.kind}
          </p>
          <p className="mt-0.5 break-words font-display text-sm font-semibold text-text">
            {item.title}
          </p>
          <p className="mt-1 break-words text-xs text-text-muted">
            {item.reasonShown}
          </p>
          <a
            href={item.anchor}
            className={cn(
              "mt-2 inline-flex min-h-[36px] items-center justify-center gap-1 rounded-card border px-3 py-1.5 text-xs font-semibold transition-colors",
              tone.actionClass,
            )}
          >
            {item.actionLabel} →
          </a>
        </div>
      </div>
    </li>
  );
}
