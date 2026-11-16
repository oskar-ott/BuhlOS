"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, ImagePlus, Loader2 } from "lucide-react";
import { useDialogFocus } from "@/components/ui/useDialogFocus";
import { cn } from "@/lib/cn";
import { itemPhotos, storePhoto } from "@/domains/workshop-stock/client";
import { allPhotoIds, errorCopy, MAX_ITEM_PHOTOS, photoUrl } from "@/domains/workshop-stock/format";
import { PHOTO_PROBLEM_COPY, preparePhoto } from "@/domains/workshop-stock/photo";
import type { StockItem } from "@/domains/workshop-stock/schema";

type Props = {
  item: Pick<StockItem, "id" | "name" | "photoId" | "photos" | "archivedAt">;
  /** the database has more photos per item (capabilities.morePhotos) */
  enabled: boolean;
  /** the office: take a photo off, choose the main one */
  manage?: boolean;
  /** phone: 44 px+ targets; office: compact */
  size?: "field" | "office";
  onChanged: (item: StockItem) => void;
};

/**
 * Every photo of a workshop item — the main one first, then the others (owner
 * pull 2026-11-16: "multiple photos of items": the back of the box, the
 * terminals, the rating plate). A strip of thumbnails; one tap opens them full
 * screen to swipe through. Anyone can add photos — several at once from the
 * camera roll, or one from the camera; each is saved to the item straight
 * away, on its own. Taking one off, or choosing the main one (the catalogue
 * card and list thumbnail), stays the office's.
 *
 * Through the same authenticated proxy as every stock photo. With nothing to
 * show and nothing to add (an archived item with no photos, or the feature not
 * set up), it renders nothing.
 */
export function ItemPhotos({ item, enabled, manage = false, size = "office", onChanged }: Props) {
  const ids = allPhotoIds(item);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const archived = Boolean(item.archivedAt);
  const extras = ids.length - (item.photoId ? 1 : 0);
  const canAdd = enabled && !archived && extras < MAX_ITEM_PHOTOS;
  if (!ids.length && !canAdd) return null;

  async function add(files: FileList | null) {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    setMessage(null);
    let latest: StockItem | null = null;
    let saved = 0;
    let problem: string | null = null;
    for (let i = 0; i < list.length; i++) {
      setBusy(list.length > 1 ? `Saving photo ${i + 1} of ${list.length}…` : "Saving photo…");
      const prepared = await preparePhoto(list[i]!);
      if (!prepared.ok) { problem = PHOTO_PROBLEM_COPY[prepared.reason]; continue; }
      const s = await storePhoto(prepared.dataUrl, prepared.thumbDataUrl);
      if (!s.ok) { problem = errorCopy(s.error.status, s.error.body, "Couldn't save the photo just now. Try again."); break; }
      const r = await itemPhotos(item.id, s.data.photoId, "add");
      if (!r.ok) { problem = errorCopy(r.error.status, r.error.body, "Couldn't add the photo just now. Try again."); break; }
      latest = r.data.item;
      saved++;
    }
    setBusy(null);
    if (latest) onChanged(latest);
    // say how far it got when not every photo went on
    setMessage(problem && list.length > 1 ? `${saved} of ${list.length} photos saved. ${problem}` : problem);
  }

  async function act(photoId: string, op: "remove" | "main") {
    setBusy(op === "remove" ? "Removing…" : "Saving…");
    setMessage(null);
    const r = await itemPhotos(item.id, photoId, op);
    setBusy(null);
    if (!r.ok) { setMessage(errorCopy(r.error.status, r.error.body)); return; }
    onChanged(r.data.item);
    const left = allPhotoIds(r.data.item);
    setOpen(left.length ? (op === "main" ? 0 : Math.min(open ?? 0, left.length - 1)) : null);
  }

  const field = size === "field";
  const box = field ? "h-[72px] w-[72px] rounded-xl" : "h-16 w-16 rounded-[10px]";
  return (
    <section className="space-y-1.5" data-testid="stock-item-photos">
      <ul className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" aria-label={`Photos of ${item.name}`}>
        {ids.map((id, i) => (
          <li key={id} className="shrink-0">
            <button type="button" onClick={() => setOpen(i)} className={cn("relative block overflow-hidden border border-border bg-surface-subtle hover:border-brand-navy", box)} aria-label={`Photo ${i + 1} of ${ids.length}${i === 0 && item.photoId ? " (main)" : ""}`} data-testid="stock-item-photo">
              {/* eslint-disable-next-line @next/next/no-img-element -- an authenticated same-origin proxy, not a static asset */}
              <img src={photoUrl(id, "thumb")} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
              {i === 0 && item.photoId && ids.length > 1 ? <span className="absolute inset-x-0 bottom-0 bg-black/60 py-0.5 text-center text-[11px] font-semibold text-text-inverse">Main</span> : null}
            </button>
          </li>
        ))}
        {canAdd ? (
          <li className="shrink-0">
            <label
              className={cn("flex cursor-pointer flex-col items-center justify-center gap-0.5 border border-dashed border-border-strong bg-surface text-center font-semibold text-brand-navy hover:border-brand-navy", box, field ? "text-[13px]" : "text-xs", busy && "pointer-events-none opacity-60")}
              data-testid="stock-item-photo-add"
            >
              {busy ? <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" /> : <ImagePlus aria-hidden="true" className="h-5 w-5" />}
              {ids.length ? "Add photos" : "Add a photo"}
              {/* no `capture`: the phone offers the camera or the camera roll, and several can be picked at once */}
              <input type="file" accept="image/*" multiple className="sr-only" disabled={Boolean(busy)} onChange={(e) => { const f = e.currentTarget.files; void add(f).finally(() => { e.target.value = ""; }); }} data-testid="stock-item-photo-input" />
            </label>
          </li>
        ) : null}
      </ul>
      {busy ? <p className="text-[13px] text-text-muted" role="status">{busy}</p> : null}
      {message ? <p className="text-[13px] font-medium text-state-danger" role="alert">{message}</p> : null}
      {enabled && !archived && extras >= MAX_ITEM_PHOTOS ? <p className="text-[13px] text-text-muted">{MAX_ITEM_PHOTOS + 1} photos — the most an item can have.</p> : null}
      {open !== null && ids[open] ? (
        <PhotoViewer
          ids={ids}
          index={open}
          name={item.name}
          hasMain={Boolean(item.photoId)}
          manage={manage && enabled && !archived}
          busy={Boolean(busy)}
          message={message}
          onIndex={setOpen}
          onAct={(id, op) => void act(id, op)}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </section>
  );
}

function PhotoViewer({ ids, index, name, hasMain, manage, busy, message, onIndex, onAct, onClose }: {
  ids: string[]; index: number; name: string; hasMain: boolean; manage: boolean; busy: boolean; message: string | null;
  onIndex: (i: number) => void; onAct: (id: string, op: "remove" | "main") => void; onClose: () => void;
}) {
  const panelRef = useDialogFocus(true);
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const id = ids[index]!;
  const isMain = hasMain && index === 0;
  const prev = () => { if (index > 0) { onIndex(index - 1); setFailed(false); setConfirming(false); } };
  const next = () => { if (index < ids.length - 1) { onIndex(index + 1); setFailed(false); setConfirming(false); } };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") prev();
      if (e.key === "ArrowRight") next();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // a swipe left / right moves between the photos
  const [startX, setStartX] = useState<number | null>(null);
  return (
    <div role="dialog" aria-modal="true" aria-label={`Photos of ${name}`} className="fixed inset-0 z-[60] flex flex-col bg-accent-ink" data-testid="stock-item-photo-viewer">
      <div ref={panelRef} className="flex h-full flex-col pb-[env(safe-area-inset-bottom)]">
        <header className="flex shrink-0 items-center gap-2 px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate font-display text-base font-bold text-text-inverse">{name}</p>
            <p className="text-sm text-text-inverse opacity-80" data-testid="stock-item-photo-count">Photo {index + 1} of {ids.length}{isMain && ids.length > 1 ? " · main" : ""}</p>
          </div>
          <button type="button" onClick={onClose} className="inline-flex min-h-[48px] min-w-[48px] items-center justify-center rounded-[10px] px-3 text-[15px] font-semibold text-text-inverse hover:bg-white/10">
            Close
          </button>
        </header>
        <div
          className="relative flex min-h-0 flex-1 items-center justify-center p-2"
          onTouchStart={(e) => setStartX(e.touches[0]?.clientX ?? null)}
          onTouchEnd={(e) => {
            const end = e.changedTouches[0]?.clientX;
            if (startX !== null && end !== undefined && Math.abs(end - startX) > 50) (end < startX ? next : prev)();
            setStartX(null);
          }}
        >
          {failed ? (
            <p className="max-w-xs text-center text-sm text-text-inverse opacity-80" role="status">Couldn&rsquo;t load the photo.</p>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- an authenticated same-origin proxy, not a static asset
            <img key={id} src={photoUrl(id, "full")} alt={`${name} — photo ${index + 1}`} onError={() => setFailed(true)} className="max-h-full max-w-full object-contain" />
          )}
          {index > 0 ? (
            <button type="button" onClick={prev} aria-label="Previous photo" className="absolute left-2 top-1/2 inline-flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-text-inverse hover:bg-black/60" data-testid="stock-item-photo-prev">
              <ChevronLeft aria-hidden="true" className="h-6 w-6" />
            </button>
          ) : null}
          {index < ids.length - 1 ? (
            <button type="button" onClick={next} aria-label="Next photo" className="absolute right-2 top-1/2 inline-flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-text-inverse hover:bg-black/60" data-testid="stock-item-photo-next">
              <ChevronRight aria-hidden="true" className="h-6 w-6" />
            </button>
          ) : null}
        </div>
        {manage ? (
          <footer className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-3">
            {!isMain ? (
              <button type="button" disabled={busy} onClick={() => onAct(id, "main")} className="min-h-[44px] rounded-[10px] border border-white/40 px-3 text-sm font-semibold text-text-inverse hover:bg-white/10 disabled:opacity-50" data-testid="stock-item-photo-main">
                Make this the main photo
              </button>
            ) : null}
            {/* taking a photo off sits apart, at the far end, and asks first (P12) */}
            <span className="flex-1" />
            {confirming ? (
              <span className="flex items-center gap-2">
                <span className="text-sm text-text-inverse">Remove this photo?</span>
                <button type="button" disabled={busy} onClick={() => { setConfirming(false); onAct(id, "remove"); }} className="min-h-[44px] rounded-[10px] bg-state-danger px-3 text-sm font-semibold text-text-inverse disabled:opacity-50" data-testid="stock-item-photo-remove-confirm">Remove</button>
                <button type="button" onClick={() => setConfirming(false)} className="min-h-[44px] rounded-[10px] px-3 text-sm font-semibold text-text-inverse hover:bg-white/10">Keep it</button>
              </span>
            ) : ids.length > 1 ? (
              <button type="button" disabled={busy} onClick={() => setConfirming(true)} className="min-h-[44px] rounded-[10px] px-3 text-sm font-semibold text-text-inverse opacity-80 underline hover:bg-white/10 disabled:opacity-50" data-testid="stock-item-photo-remove">
                Remove photo…
              </button>
            ) : null}
          </footer>
        ) : null}
        {message ? <p className="px-3 pb-3 text-sm text-text-inverse" role="alert">{message}</p> : null}
      </div>
    </div>
  );
}
