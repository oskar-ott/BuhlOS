"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchItem } from "@/domains/workshop-stock/client";
import { balanceLabel, errorCopy, formatQuantity, identityLine, movementSummary, movementWho, undoLabelFor, undoUntilLabel, whenLabel } from "@/domains/workshop-stock/format";
import type { ItemDetail, StockItem, WriteResult } from "@/domains/workshop-stock/schema";
import { FlowSheet } from "./FlowSheet";
import { LocationPhoto } from "./LocationPhoto";
import { MoveConfirm, type MoveItem } from "./MoveConfirm";
import { StockReceipt } from "./StockReceipt";
import { StockThumb } from "./StockThumb";
import { BigButton, Kicker, Slot } from "./ui";
import { UndoControl } from "./UndoControl";

const TITLE = { take: "Take stock", return: "Return stock", add: "Add stock" } as const;
const DIRECTION = { take: "out", return: "return", add: "in" } as const;

/**
 * One workshop item on the phone: what it is, where it lives, what's recorded,
 * when it was last counted and last moved — then the latest movements, each
 * with its own Undo while the server allows it. Take / Return / Add on THIS
 * item sit in the footer and go one level deeper to the same confirmation.
 * Where a worker would look for edit or delete, the sentence says the office
 * can.
 */
export function StockItemSheet({ item: initial, viewerId, onChanged, onClose }: { item: StockItem; viewerId?: string | null; onChanged: (r?: WriteResult) => void; onClose: () => void }) {
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [action, setAction] = useState<"take" | "return" | "add" | null>(null);
  const [receipt, setReceipt] = useState<WriteResult | null>(null);
  const [undone, setUndone] = useState<WriteResult | null>(null);

  const load = useCallback(async () => {
    const r = await fetchItem(initial.id);
    if (r.ok) { setDetail(r.data); setLoadError(null); } else setLoadError(errorCopy(r.error.status, r.error.body, "Couldn't load this item's history."));
  }, [initial.id]);

  useEffect(() => { void load(); }, [load]);

  const item: StockItem = detail?.item ?? initial;
  const archived = Boolean(item.archivedAt);

  function saved(r: WriteResult) {
    if (r.movement.kind === "reversal") setUndone(r);
    else { setReceipt(r); setUndone(null); }
    onChanged(r);
  }

  if (action) {
    const back = () => { setAction(null); void load(); };
    return (
      <FlowSheet title={TITLE[action]} direction={DIRECTION[action]} onClose={onClose} onBack={back} testId="stock-item-action">
        <MoveConfirm item={item as MoveItem} kind={action} onSaved={saved} onWrongItem={back} wrongItemLabel="Wrong item? Back to the item" doneLabel="Done" doneSub="back to the item" onClose={back} />
      </FlowSheet>
    );
  }

  const barcode = item.identifiers.find((i) => i.kind === "barcode");
  const lastMove = detail?.movements[0];
  return (
    <FlowSheet
      title="Workshop item"
      onClose={onClose}
      testId="stock-item-sheet"
      footer={
        <div className="grid grid-cols-3 gap-2">
          <BigButton variant="sec" label="Take" sub="out" disabled={archived} onClick={() => setAction("take")} data-testid="stock-sheet-take" />
          <BigButton variant="sec" label="Return" sub="back from a job" disabled={archived} onClick={() => setAction("return")} data-testid="stock-sheet-return" />
          <BigButton variant="sec" label="Add" sub="new stock" disabled={archived} onClick={() => setAction("add")} data-testid="stock-sheet-add" />
        </div>
      }
    >
      {receipt ? <StockReceipt result={receipt} undone={undone} onUndone={saved} undoTestId="stock-sheet-receipt-undo" /> : null}
      {archived ? <Slot tone="neu" title="Archived by the office">It&rsquo;s off the list. Its history stays on the record.</Slot> : null}

      <div className="flex gap-3">
        <StockThumb photoId={item.photoId} alt={item.name} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="font-display text-[20px] font-bold leading-tight text-text">{item.name}</p>
          {identityLine(item) ? <p className="mt-0.5 text-[13px] text-text-muted">{identityLine(item)}</p> : null}
          {barcode ? <p className="text-[13px] text-text-muted">Barcode <span className="font-mono">{barcode.value}</span></p> : null}
          {item.supplierSku ? <p className="text-[13px] text-text-muted">Supplier SKU <span className="font-mono">{item.supplierSku}</span>{item.supplierName ? ` (${item.supplierName})` : ""}</p> : null}
          <p className="mt-1 text-[13px] font-semibold text-text">{item.location || "No shelf set"}</p>
        </div>
      </div>

      {item.locationPhotoId ? <LocationPhoto photoId={item.locationPhotoId} location={item.location} size="lg" /> : null}

      <div className="grid grid-cols-3 gap-2 rounded-[14px] border border-border bg-surface-subtle p-3">
        <div>
          <p className="font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-text-muted">Recorded</p>
          <p className="mt-1 font-display text-[20px] font-bold leading-none text-text" data-testid="stock-sheet-balance">{balanceLabel(item)}</p>
        </div>
        <div>
          <p className="font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-text-muted">Last counted</p>
          <p className="mt-1.5 text-[13px] leading-snug text-text">{item.lastCountedAt ? [item.lastCountedByName ?? "the office", whenLabel(item.lastCountedAt)].join(" · ") : "Never"}</p>
        </div>
        <div>
          <p className="font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-text-muted">Last movement</p>
          <p className="mt-1.5 text-[13px] leading-snug text-text">{lastMove ? `${movementSummary(lastMove, item.baseUnit)} · ${movementWho(lastMove, viewerId)}` : item.lastMovementAt ? whenLabel(item.lastMovementAt) : "None yet"}</p>
        </div>
      </div>
      <p className="text-[13px] text-text-muted">Recorded stock is what&rsquo;s been logged — the shelf is the truth. Tell the office if they don&rsquo;t match.</p>

      <section className="space-y-1">
        <Kicker className="pt-1">Latest movements</Kicker>
        {loadError ? <Slot tone="warn" role="alert">{loadError}</Slot> : null}
        {!detail && !loadError ? <p className="text-sm text-text-muted">Loading…</p> : null}
        <ul className="divide-y divide-border" data-testid="stock-sheet-movements">
          {(detail?.movements ?? []).slice(0, 12).map((m) => {
            const until = undoUntilLabel(m.undo);
            return (
              <li key={m.id} className="flex items-start gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className={m.reversedBy ? "text-[15px] font-semibold text-text-muted line-through" : "text-[15px] font-semibold text-text"}>{movementSummary(m, item.baseUnit)}</p>
                  <p className="text-[13px] text-text-muted">
                    {movementWho(m, viewerId)}
                    {m.reversedBy ? ` · undone by ${m.reversedBy.actorName ?? "someone"}` : ""}
                    {m.pack ? ` · ${m.pack.count} ${m.pack.unit ?? "pack"}${m.pack.count === 1 ? "" : "s"} of ${formatQuantity(m.pack.sizeMilli, item.baseUnit)}` : ""}
                  </p>
                  {until ? <p className="text-[13px] text-text">{until.replace("You can undo this until", "Undo until").replace(/\.$/, "")}</p> : null}
                </div>
                <UndoControl movement={m} size="mini" label={undoLabelFor(m.kind)} onUndone={(r) => { saved(r); void load(); }} testId="stock-sheet-undo" />
              </li>
            );
          })}
        </ul>
        {detail && !detail.movements.length ? <p className="text-sm text-text-muted">No movements yet.</p> : null}
      </section>
      <p className="text-[13px] text-text-muted">Count wrong, or details need changing? The office can correct the count or change the details.</p>
    </FlowSheet>
  );
}
