"use client";

import { useRef, useState } from "react";
import { Check, Globe, Loader2, X } from "lucide-react";
import { Drawer } from "@/components/ui/Drawer";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { StockThumb } from "@/components/stock/StockThumb";
import { cn } from "@/lib/cn";
import { findWebPhoto, lookupCode, replaceItemPhoto } from "@/domains/workshop-stock/client";
import { errorCopy, identityLine, photoUrl } from "@/domains/workshop-stock/format";
import type { StockItem } from "@/domains/workshop-stock/schema";
import { BULK_WEB_PHOTO_MAX, findPhotoFor, needsWebPhoto, type WebPhotoFound } from "@/domains/workshop-stock/web-photo";
import { Block } from "./StockAdminForms";

type RowState = "waiting" | "checking" | "fetching" | "found" | "none" | "error" | "saving" | "used" | "skipped";
interface Row {
  item: StockItem;
  state: RowState;
  photo?: WebPhotoFound;
  text?: string;
}

/**
 * Product photos for every item without one, in one go (owner pull
 * 2026-11-05, after the one-item "Find a photo online"). The same steps per
 * item (web-photo.ts), one item at a time, up to BULK_WEB_PHOTO_MAX a run —
 * each may spend one of the day's online checks. Nothing is applied on its
 * own: every photo found waits for "Use" (or "Use all found"), because a
 * product page sometimes carries a logo or the wrong variant (P7). A limit or
 * lost signal stops the run and says so; the rest stay as they were.
 */
export function WebPhotoBatch({ items, onChanged, onOpenItem, onClose }: { items: StockItem[]; onChanged: () => void; onOpenItem: (id: string) => void; onClose: () => void }) {
  const eligible = needsWebPhoto(items);
  const noCode = items.filter((i) => !i.archivedAt && !i.photoId && !i.manufacturerCode).length;
  const [rows, setRows] = useState<Row[]>(() => eligible.slice(0, BULK_WEB_PHOTO_MAX).map((item) => ({ item, state: "waiting" })));
  const [running, setRunning] = useState(false);
  const [stopped, setStopped] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const halt = useRef(false);

  const set = (id: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.item.id === id ? { ...r, ...patch } : r)));

  async function run() {
    halt.current = false;
    setRunning(true);
    setStopped(null);
    for (const row of rows) {
      if (halt.current) break;
      if (row.state !== "waiting" && row.state !== "error") continue;
      set(row.item.id, { state: "fetching", text: undefined });
      const out = await findPhotoFor(row.item, { findWebPhoto, lookupCode, onChecking: () => set(row.item.id, { state: "checking" }) });
      if (out.kind === "found") set(row.item.id, { state: "found", photo: out.photo });
      else if (out.kind === "none") set(row.item.id, { state: "none", text: out.text });
      else {
        set(row.item.id, { state: "error", text: out.text });
        if (out.stop) { setStopped(out.text); break; }
      }
    }
    setRunning(false);
  }

  async function apply(row: Row) {
    if (!row.photo) return false;
    set(row.item.id, { state: "saving" });
    const r = await replaceItemPhoto(row.item.id, row.photo.photoId);
    if (r.ok) { set(row.item.id, { state: "used" }); return true; }
    set(row.item.id, { state: "found", text: errorCopy(r.error.status, r.error.body, "Couldn't change the photo.") });
    return false;
  }

  async function applyAll() {
    setApplying(true);
    let any = false;
    for (const row of rows.filter((r) => r.state === "found")) any = (await apply(row)) || any;
    setApplying(false);
    if (any) onChanged();
  }

  const counts = rows.reduce<Record<RowState, number>>((acc, r) => ({ ...acc, [r.state]: acc[r.state] + 1 }), { waiting: 0, checking: 0, fetching: 0, found: 0, none: 0, error: 0, saving: 0, used: 0, skipped: 0 });
  const done = rows.length - counts.waiting - counts.checking - counts.fetching;
  const started = done > 0 || running;

  return (
    <Drawer
      open
      onClose={() => { halt.current = true; onClose(); }}
      title="Find photos online"
      subtitle={`${eligible.length} ${eligible.length === 1 ? "item" : "items"} with a maker's code and no photo`}
      footer={
        counts.found > 0 ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-text-muted">{counts.found} found, waiting for you</span>
            <Button type="button" size="sm" onClick={() => void applyAll()} disabled={applying || running} data-testid="stock-web-batch-use-all">
              {applying ? "Saving…" : `Use all ${counts.found} found`}
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="space-y-4" data-testid="stock-web-batch">
        {!rows.length ? (
          <Block tone="neu" title="Nothing to look up">
            <p>{noCode ? `${noCode} ${noCode === 1 ? "item has" : "items have"} no photo but no maker's code either — add the code in its Details, or take a photo.` : "Every item with a maker's code already has a photo."}</p>
          </Block>
        ) : (
          <>
            <p className="text-sm text-text-muted">
              For each item, the product photo from the maker&rsquo;s or a wholesaler&rsquo;s page its code matches. An item not checked online yet uses one of today&rsquo;s online checks. You see every photo before it&rsquo;s used — they&rsquo;re catalogue photos, not ones taken in the workshop.
              {eligible.length > rows.length ? ` This run looks at the first ${rows.length}; run it again for the rest.` : ""}
              {noCode ? ` ${noCode} without a maker's code can't be looked up.` : ""}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {running ? (
                <>
                  <p className="flex items-center gap-2 text-sm text-text" role="status"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> Looking at {Math.min(done + 1, rows.length)} of {rows.length}…</p>
                  <Button type="button" variant="secondary" size="sm" onClick={() => { halt.current = true; }}>Stop</Button>
                </>
              ) : counts.waiting > 0 || counts.error > 0 ? (
                <Button type="button" size="sm" onClick={() => void run()} data-testid="stock-web-batch-start">
                  <Globe aria-hidden="true" className="h-4 w-4" /> {started ? `Carry on (${counts.waiting + counts.error} left)` : `Find photos for ${rows.length} ${rows.length === 1 ? "item" : "items"}`}
                </Button>
              ) : (
                <p className="text-sm text-text-muted" role="status">Done — {counts.used} used, {counts.found} waiting, {counts.none} with nothing to use.</p>
              )}
            </div>
            {stopped ? <Block tone="warn" title="Stopped" role="alert"><p>{stopped} The items not looked at yet are left as they were.</p></Block> : null}
            <ul className="divide-y divide-border rounded-card border border-border" data-testid="stock-web-batch-list">
              {rows.map((r) => <BatchRow key={r.item.id} row={r} busy={applying} onUse={() => void apply(r).then((ok) => { if (ok) onChanged(); })} onSkip={() => set(r.item.id, { state: "skipped" })} onOpen={() => onOpenItem(r.item.id)} />)}
            </ul>
          </>
        )}
      </div>
    </Drawer>
  );
}

function BatchRow({ row, busy, onUse, onSkip, onOpen }: { row: Row; busy: boolean; onUse: () => void; onSkip: () => void; onOpen: () => void }) {
  const { item, state, photo, text } = row;
  const shown = (state === "found" || state === "saving" || state === "used") && photo;
  return (
    <li className={cn("flex items-start gap-3 p-3", (state === "skipped" || state === "none") && "opacity-70")} data-testid="stock-web-batch-row">
      {shown ? (
        // eslint-disable-next-line @next/next/no-img-element -- the server's stored copy through the authenticated photo proxy
        <img src={photoUrl(photo.photoId)} alt={`Product photo for ${item.name}`} className="h-16 w-16 shrink-0 rounded-[6px] border border-border bg-surface object-contain" />
      ) : (
        <StockThumb photoId={null} alt="" size="lg" />
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <button type="button" onClick={onOpen} className="block text-left font-semibold text-text hover:underline">{item.name}</button>
        {identityLine(item) ? <p className="text-xs text-text-muted">{identityLine(item)}</p> : null}
        <p className="text-xs">
          {state === "waiting" ? <span className="text-text-muted">Waiting</span> : null}
          {state === "checking" ? <span className="inline-flex items-center gap-1 text-text"><Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" /> Checking {item.manufacturerCode} online…</span> : null}
          {state === "fetching" ? <span className="inline-flex items-center gap-1 text-text"><Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" /> Getting the photo…</span> : null}
          {(state === "found" || state === "saving") && photo ? <span className="text-text">From {photo.source.domain ?? "the web"}{photo.source.kind === "manufacturer" ? " (the maker's site)" : photo.source.kind === "supplier" ? " (a wholesaler)" : ""}</span> : null}
          {state === "used" ? <Pill tone="success" dot>Photo used</Pill> : null}
          {state === "skipped" ? <span className="text-text-muted">Skipped — left without a photo</span> : null}
          {state === "none" || state === "error" ? <span className={state === "error" ? "text-state-danger" : "text-text-muted"}>{text}</span> : null}
        </p>
        {(state === "found" || state === "saving") && text ? <p className="text-xs text-state-danger" role="alert">{text}</p> : null}
        {(state === "found" || state === "saving") && photo?.source.pageUrl ? (
          <a href={photo.source.pageUrl} target="_blank" rel="noopener noreferrer nofollow" className="text-xs text-state-info underline">Open the product page</a>
        ) : null}
      </div>
      {state === "found" || state === "saving" ? (
        <div className="flex shrink-0 flex-col gap-1.5">
          <Button type="button" size="sm" onClick={onUse} disabled={busy || state === "saving"} data-testid="stock-web-batch-use"><Check aria-hidden="true" className="h-4 w-4" /> Use</Button>
          <Button type="button" variant="secondary" size="sm" onClick={onSkip} disabled={busy || state === "saving"}><X aria-hidden="true" className="h-4 w-4" /> Skip</Button>
        </div>
      ) : null}
    </li>
  );
}
