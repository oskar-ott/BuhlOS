"use client";

import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/cn";
import { itemLinks } from "@/domains/workshop-stock/format";

/**
 * An item's product links — its page at an online wholesaler, and the maker's
 * spec page when there is one — each opening in a new tab. Nothing renders
 * when the item has neither (no empty slot, P7). `size="field"` gives the
 * phone's 44 px rows; the office drawer uses the compact one.
 */
export function ProductLinks({ item, size = "office", className }: { item: { productUrl?: string | null; specUrl?: string | null }; size?: "field" | "office"; className?: string }) {
  const links = itemLinks(item);
  if (!links.length) return null;
  return (
    <ul className={cn(size === "field" ? "divide-y divide-border rounded-[14px] border border-border" : "flex flex-wrap gap-x-4 gap-y-1", className)} data-testid="stock-product-links">
      {links.map((l) => (
        <li key={l.kind}>
          <a
            href={l.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className={cn(
              "flex items-center gap-2",
              size === "field" ? "min-h-[44px] px-3 py-2 text-[15px] text-text" : "min-h-[28px] text-sm text-state-info underline-offset-2 hover:underline",
            )}
            data-testid={`stock-link-${l.kind}`}
          >
            <span className={cn("min-w-0 flex-1 truncate", size === "office" && "flex-none")}>
              <span className="font-semibold">{l.label}</span>
              <span className="text-text-muted"> · {l.site}</span>
            </span>
            <ExternalLink aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
