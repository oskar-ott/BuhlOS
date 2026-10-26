"use client";

import { useEffect, useState } from "react";
import { MapPin, Maximize2 } from "lucide-react";
import { useDialogFocus } from "@/components/ui/useDialogFocus";
import { cn } from "@/lib/cn";
import { photoUrl } from "@/domains/workshop-stock/format";

/**
 * The photo of WHERE an item lives (Workshop Stock) — for stock that isn't in
 * an obvious place: the one tub on the top shelf behind the door. Shown to
 * whoever comes to take it, beside the shelf text; one tap opens it full screen.
 *
 * Through the same authenticated proxy as the product photo (the Blob URL never
 * reaches the browser). A photo that won't load says so instead of showing a
 * broken image.
 */
export function LocationPhoto({ photoId, location, size = "md", className }: { photoId: string; location: string | null; size?: "md" | "lg"; className?: string }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn("flex w-full items-center gap-3 rounded-xl border border-border bg-surface-subtle p-2 text-left hover:border-brand-navy", className)}
        data-testid="stock-location-photo"
      >
        {failed ? (
          <span className={cn("flex shrink-0 items-center justify-center rounded-lg border border-border-strong bg-surface text-text-muted", size === "lg" ? "h-20 w-20" : "h-14 w-14")}>
            <MapPin aria-hidden="true" className="h-6 w-6" />
          </span>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- an authenticated same-origin proxy, not a static asset
          <img
            src={photoUrl(photoId, "thumb")}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
            className={cn("shrink-0 rounded-lg border border-border object-cover", size === "lg" ? "h-20 w-20" : "h-14 w-14")}
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold text-text">Where to find it</span>
          {location ? <span className="block truncate text-[13px] font-medium text-text">{location}</span> : null}
          <span className="mt-0.5 flex items-center gap-1 text-[13px] text-state-info">
            <Maximize2 aria-hidden="true" className="h-3.5 w-3.5" />
            {failed ? "Photo didn't load — tap to try again" : "Tap to see the photo"}
          </span>
        </span>
      </button>
      {open ? <LocationPhotoViewer photoId={photoId} location={location} onClose={() => { setOpen(false); setFailed(false); }} /> : null}
    </>
  );
}

function LocationPhotoViewer({ photoId, location, onClose }: { photoId: string; location: string | null; onClose: () => void }) {
  const panelRef = useDialogFocus(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label="Where to find it" className="fixed inset-0 z-[60] flex flex-col bg-accent-ink" data-testid="stock-location-photo-viewer">
      <div ref={panelRef} className="flex h-full flex-col pb-[env(safe-area-inset-bottom)]">
        <header className="flex shrink-0 items-center gap-2 px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="font-display text-base font-bold text-text-inverse">Where to find it</p>
            {location ? <p className="truncate text-sm text-text-inverse/80">{location}</p> : null}
          </div>
          <button type="button" onClick={onClose} className="inline-flex min-h-[48px] min-w-[48px] items-center justify-center rounded-[10px] px-3 text-[15px] font-semibold text-text-inverse hover:bg-white/10">
            Close
          </button>
        </header>
        <div className="flex min-h-0 flex-1 items-center justify-center p-2">
          {failed ? (
            <p className="max-w-xs text-center text-sm text-text-inverse/80" role="status">
              Couldn&rsquo;t load the photo. {location ? `It lives at: ${location}.` : ""}
            </p>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- an authenticated same-origin proxy, not a static asset
            <img src={photoUrl(photoId, "full")} alt={location ? `Where it lives: ${location}` : "Where it lives"} onError={() => setFailed(true)} className="max-h-full max-w-full object-contain" />
          )}
        </div>
      </div>
    </div>
  );
}
