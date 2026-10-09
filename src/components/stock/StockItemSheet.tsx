"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, MapPin } from "lucide-react";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { fetchItem, newOperationKey, undoMovement } from "@/domains/workshop-stock/client";
import { balanceLabel, errorCopy, movementSummary, timeAgo, VERIFICATION_LABEL } from "@/domains/workshop-stock/format";
import type { ItemDetail, StockItem, StockMovement, WriteResult } from "@/domains/workshop-stock/schema";
import { FlowSheet } from "./FlowSheet";
import { MoveConfirm, type MoveItem } from "./MoveConfirm";
import { StockThumb } from "./StockThumb";

/**
 * One workshop item on the phone: what it is, where it lives, what's recorded,
 * when it was last counted — plus Take / Return / Add on THIS item and the
 * latest movements (your own recent ones can be undone here).
 */
export function StockItemSheet({ item: initial, onChanged, onClose }: { item: StockItem; onChanged: (r?: WriteResult) => void; onClose: () => void }) {
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [action, setAction] = useState<"take" | "return" | "add" | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetchItem(initial.id);
    if (r.ok) { setDetail(r.data); setLoadError(null); } else setLoadError(errorCopy(r.error.status, r.error.body, "Couldn't load this item's history."));
  }, [initial.id]);

  useEffect(() => { void load(); }, [load]);

  const item: StockItem = detail?.item ?? initial;

  async function undo(m: StockMovement) {
    setUndoing(m.id);
    setUndoError(null);
    const r = await undoMovement({ movementId: m.id }, newOperationKey());
    setUndoing(null);
    if (!r.ok) { setUndoError(errorCopy(r.error.status, r.error.body)); return; }
    onChanged(r.data);
    void load();
  }

  if (action) {
    return (
      <FlowSheet title={action === "take" ? "Take stock" : action === "return" ? "Return unused stock" : "Add stock"} onClose={onClose} onBack={() => { setAction(null); void load(); }} testId="stock-item-action">
        <MoveConfirm item={item as MoveItem} kind={action} onSaved={(r) => onChanged(r)} onClose={() => { setAction(null); void load(); }} />
      </FlowSheet>
    );
  }

  const v = item.verification;
  return (
    <FlowSheet title={item.name} onClose={onClose} testId="stock-item-sheet">
      <div className="flex gap-3">
        <StockThumb photoId={item.photoId} alt={item.name} size="lg" />
        <div className="min-w-0 space-y-1 text-sm">
          <p className="font-display text-base font-semibold text-text">{item.name}</p>
          {item.brand ? <p className="text-text-muted">{item.brand}</p> : null}
          {item.manufacturerCode ? <p className="text-text">Manufacturer code <span className="font-mono">{item.manufacturerCode}</span></p> : null}
          {item.supplierSku ? <p className="text-text">Supplier SKU <span className="font-mono">{item.supplierSku}</span>{item.supplierName ? ` (${item.supplierName})` : ""}</p> : null}
          {[item.colourFinish, item.variant].filter(Boolean).length ? <p className="text-text-muted">{[item.colourFinish, item.variant].filter(Boolean).join(" · ")}</p> : null}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 rounded-card border border-border bg-surface-raised p-3 text-sm">
        <div>
          <p className="text-xs uppercase tracking-wide text-text-muted">Recorded</p>
          <p className="font-display text-lg font-semibold text-text" data-testid="stock-sheet-balance">{balanceLabel(item)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-text-muted">Where</p>
          <p className="flex items-center gap-1 font-semibold text-text"><MapPin aria-hidden="true" className="h-3.5 w-3.5" />{item.location || "Not set"}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-text-muted">Last counted</p>
          <p className="text-text">{item.lastCountedAt ? `${timeAgo(item.lastCountedAt)}${item.lastCountedByName ? ` · ${item.lastCountedByName}` : ""}` : "Never"}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-text-muted">Last movement</p>
          <p className="text-text">{timeAgo(item.lastMovementAt)}</p>
        </div>
      </div>
      <p className="text-xs text-text-muted">Recorded stock is what&rsquo;s been logged — the shelf is the truth. Tell the office if they don&rsquo;t match.</p>

      <div className="grid grid-cols-3 gap-2">
        <button type="button" onClick={() => setAction("take")} disabled={Boolean(item.archivedAt)} className="min-h-[56px] rounded-card bg-accent-yellow px-2 font-semibold text-brand-navy disabled:opacity-50" data-testid="stock-sheet-take">Take</button>
        <button type="button" onClick={() => setAction("return")} disabled={Boolean(item.archivedAt)} className="min-h-[56px] rounded-card border border-border-strong px-2 font-semibold text-text disabled:opacity-50" data-testid="stock-sheet-return">Return</button>
        <button type="button" onClick={() => setAction("add")} disabled={Boolean(item.archivedAt)} className="min-h-[56px] rounded-card border border-border-strong px-2 font-semibold text-text disabled:opacity-50" data-testid="stock-sheet-add">Add</button>
      </div>

      <div className="rounded-card border border-border p-3 text-sm">
        <p className="font-semibold text-text">{VERIFICATION_LABEL[item.verificationStatus]}</p>
        {v && v.sourceUrl ? (
          <a href={v.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-[44px] items-center gap-1 text-brand-navy underline">
            {v.sourceDomain || "Source"} <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
          </a>
        ) : null}
        {v && v.reasons && v.reasons.length ? <p className="text-text-muted">{v.reasons.join(" · ")}</p> : null}
      </div>

      <section className="space-y-2">
        <h3 className="font-display text-sm font-semibold text-text">Latest movements</h3>
        {loadError ? <PhilNotice tone="warning" role="alert">{loadError}</PhilNotice> : null}
        {undoError ? <PhilNotice tone="danger" role="alert">{undoError}</PhilNotice> : null}
        {!detail && !loadError ? <p className="text-sm text-text-muted">Loading…</p> : null}
        <ul className="space-y-1.5" data-testid="stock-sheet-movements">
          {(detail?.movements ?? []).slice(0, 12).map((m) => (
            <li key={m.id} className="flex items-center gap-2 rounded-card border border-border px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <p className={m.reversedBy ? "text-text-muted line-through" : "text-text"}>{movementSummary(m, item.baseUnit)}</p>
                <p className="truncate text-xs text-text-muted">{[m.actorName, timeAgo(m.createdAt), m.jobLabel].filter(Boolean).join(" · ")}{m.reversedBy ? ` · undone by ${m.reversedBy.actorName ?? "someone"}` : ""}</p>
              </div>
              {m.undo?.allowed ? (
                <button type="button" onClick={() => void undo(m)} disabled={undoing === m.id} className="min-h-[44px] shrink-0 rounded-card border border-brand-navy px-3 text-sm font-semibold text-brand-navy" data-testid="stock-sheet-undo">
                  {undoing === m.id ? "…" : "Undo"}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </FlowSheet>
  );
}
