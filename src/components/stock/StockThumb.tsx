"use client";

import { useState } from "react";
import { Package } from "lucide-react";
import { cn } from "@/lib/cn";
import { photoUrl } from "@/domains/workshop-stock/format";

/**
 * A workshop item's product photo through the authenticated proxy (the Blob URL
 * never reaches the browser), or a plain package icon — never a broken image.
 */
export function StockThumb({ photoId, alt, size = "md", className }: { photoId: string | null; alt: string; size?: "sm" | "md" | "lg"; className?: string }) {
  const [failed, setFailed] = useState(false);
  const box = size === "lg" ? "h-28 w-28" : size === "sm" ? "h-10 w-10" : "h-14 w-14";
  if (!photoId || failed) {
    return (
      <div aria-hidden="true" className={cn("flex shrink-0 items-center justify-center rounded-card border border-border bg-surface-subtle text-text-muted", box, className)}>
        <Package className={size === "lg" ? "h-10 w-10" : "h-6 w-6"} />
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- an authenticated same-origin proxy, not a static asset
    <img
      src={photoUrl(photoId)}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={cn("shrink-0 rounded-card border border-border bg-surface-subtle object-cover", box, className)}
    />
  );
}
