"use client";

import { useState } from "react";
import { ExternalLink, Globe, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { findWebPhoto, lookupCode, replaceItemPhoto, type WebPhoto } from "@/domains/workshop-stock/client";
import { errorCopy, photoUrl } from "@/domains/workshop-stock/format";
import type { StockItem } from "@/domains/workshop-stock/schema";

/**
 * A product photo from the web (owner pull 2026-11-05: "grab an image from the
 * internet as the stock image"). The image is the one the online code check
 * found on the product page it matched — the maker's or an allowlisted
 * wholesaler's site — fetched by the server and shown here BEFORE it's used:
 * "Use this photo" makes it the item's photo; "Not this one" leaves it (the
 * pending copy expires on its own). It says where it came from, and that it's
 * a product photo, not one taken in the workshop (P7).
 *
 * No check on record for the code yet → the check runs first (the same one
 * "Check code online" runs, from the cache when there is one), then the photo.
 */
export function WebPhotoFinder({ item, lookupEnabled, onUsed, compact = false }: { item: StockItem; lookupEnabled: boolean; onUsed: () => void; compact?: boolean }) {
  const [phase, setPhase] = useState<"idle" | "checking" | "fetching" | "preview" | "saving">("idle");
  const [found, setFound] = useState<WebPhoto | null>(null);
  const [message, setMessage] = useState<{ tone: "muted" | "error"; text: string } | null>(null);

  if (!lookupEnabled) return compact ? null : <p className="text-xs text-text-muted">Finding a photo online needs the online code check, which isn&rsquo;t set up.</p>;
  if (!item.manufacturerCode) return compact ? null : <p className="text-xs text-text-muted">Add the maker&rsquo;s code in Details to find its product photo online.</p>;

  async function find() {
    setMessage(null);
    setFound(null);
    setPhase("fetching");
    let r = await findWebPhoto(item.id);
    if (!r.ok && r.error.status === 409 && (r.error.body as { error?: string } | null)?.error === "not_checked") {
      setPhase("checking");
      // exactly the item's own brand / code / colour / size — the check the server reads back
      const l = await lookupCode({ brand: item.brand, manufacturerCode: item.manufacturerCode!, colourFinish: item.colourFinish, variantDetails: item.variant ?? "" });
      if (!l.ok) { setPhase("idle"); setMessage({ tone: "error", text: errorCopy(l.error.status, l.error.body, "Couldn't check the code online right now.") }); return; }
      if (l.data.status !== "manufacturer_code_matched" && l.data.status !== "possible_match") {
        setPhase("idle");
        setMessage({ tone: "muted", text: l.data.reasons?.[0] ? `No product page found to take a photo from — ${l.data.reasons[0].charAt(0).toLowerCase()}${l.data.reasons[0].slice(1)}.` : "No product page found to take a photo from." });
        return;
      }
      setPhase("fetching");
      r = await findWebPhoto(item.id);
    }
    if (!r.ok) { setPhase("idle"); setMessage({ tone: r.error.status === 404 ? "muted" : "error", text: errorCopy(r.error.status, r.error.body, "Couldn't get a photo online right now.") }); return; }
    setFound(r.data);
    setPhase("preview");
  }

  async function use() {
    if (!found) return;
    setPhase("saving");
    const r = await replaceItemPhoto(item.id, found.photoId);
    if (!r.ok) { setPhase("preview"); setMessage({ tone: "error", text: errorCopy(r.error.status, r.error.body, "Couldn't change the photo.") }); return; }
    setPhase("idle");
    setFound(null);
    setMessage({ tone: "muted", text: `Photo changed — the product photo from ${found.source.domain ?? "the web"}.` });
    onUsed();
  }

  const where = found?.source.domain ?? "the web";
  const whose = found?.source.kind === "manufacturer" ? "the maker's site" : found?.source.kind === "supplier" ? "a wholesaler's site" : null;

  return (
    <div className="space-y-2" data-testid="stock-web-photo">
      {phase === "preview" || phase === "saving" ? (
        found ? (
          <div className="space-y-2 rounded-card border border-border bg-surface-subtle p-3" data-testid="stock-web-photo-preview">
            <div className="flex items-start gap-3">
              {/* the server's stored copy, through the photo proxy — the browser never loads the outside site */}
              {/* eslint-disable-next-line @next/next/no-img-element -- an authenticated same-origin proxy */}
              <img src={photoUrl(found.photoId)} alt="The product photo found online" className="h-28 w-28 shrink-0 rounded-[6px] border border-border bg-surface object-contain" />
              <div className="min-w-0 space-y-1 text-sm">
                <p className="font-semibold text-text">Product photo from {where}</p>
                {whose ? <p className="text-xs text-text-muted">From {whose}, on the page the online check matched to {item.manufacturerCode}.</p> : null}
                {found.source.pageUrl ? (
                  <a href={found.source.pageUrl} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 text-xs text-state-info underline">
                    Open the product page <ExternalLink aria-hidden="true" className="h-3 w-3" />
                  </a>
                ) : null}
                <p className="text-xs text-text-muted">A catalogue photo, not one taken in the workshop — check it&rsquo;s the same item before using it.</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={() => void use()} disabled={phase === "saving"} data-testid="stock-web-photo-use">{phase === "saving" ? "Saving…" : "Use this photo"}</Button>
              <Button type="button" variant="secondary" size="sm" onClick={() => { setFound(null); setPhase("idle"); }} disabled={phase === "saving"}>Not this one</Button>
            </div>
          </div>
        ) : null
      ) : phase === "checking" || phase === "fetching" ? (
        <p className="flex items-center gap-2 text-sm text-text" role="status">
          <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
          {phase === "checking" ? `Checking ${item.manufacturerCode} online…` : "Getting the product photo…"}
        </p>
      ) : (
        <div className={compact ? "flex flex-wrap items-center gap-2" : "space-y-1"}>
          <Button type="button" variant="secondary" size="sm" onClick={() => void find()} data-testid="stock-web-photo-find">
            <Globe aria-hidden="true" className="h-4 w-4" /> Find a photo online
          </Button>
          {compact ? null : <p className="text-xs text-text-muted">The product photo from the maker&rsquo;s or a wholesaler&rsquo;s page for {item.manufacturerCode} — you see it before it&rsquo;s used.</p>}
        </div>
      )}
      {message ? <p className={message.tone === "error" ? "text-sm text-state-danger" : "text-sm text-text-muted"} role={message.tone === "error" ? "alert" : "status"}>{message.text}</p> : null}
    </div>
  );
}
