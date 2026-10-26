"use client";

import { useState } from "react";
import { Package } from "lucide-react";
import { cn } from "@/lib/cn";
import { photoUrl } from "@/domains/workshop-stock/format";

const BOX = { xs: "h-9 w-9 rounded-[4px]", sm: "h-10 w-10 rounded-lg", md: "h-12 w-12 rounded-[10px]", lg: "h-16 w-16 rounded-xl", xl: "h-28 w-28 rounded-card" } as const;

/**
 * A workshop item's product photo through the authenticated proxy (the Blob URL
 * never reaches the browser), or a plain package icon — never a broken image.
 * List sizes load the small copy (the proxy serves the photo itself when there
 * isn't one); only the large view loads the full photo.
 */
export function StockThumb({ photoId, alt, size = "md", className }: { photoId: string | null; alt: string; size?: keyof typeof BOX; className?: string }) {
  const [failed, setFailed] = useState(false);
  const box = BOX[size];
  if (!photoId || failed) {
    return (
      <div aria-hidden="true" className={cn("flex shrink-0 items-center justify-center border border-border-strong bg-surface-subtle text-text-muted", box, className)}>
        <Package className={size === "xl" ? "h-10 w-10" : size === "lg" ? "h-7 w-7" : "h-5 w-5"} />
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- an authenticated same-origin proxy, not a static asset
    <img
      src={photoUrl(photoId, size === "xl" ? "full" : "thumb")}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={cn("shrink-0 border border-border bg-surface-subtle object-cover", box, className)}
    />
  );
}
