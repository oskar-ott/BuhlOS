"use client";

import { useState } from "react";
import { ClipboardList } from "lucide-react";
import { cn } from "@/lib/cn";
import { fetchLists, newId, saveList, saveListLine } from "@/domains/workshop-stock/client";
import { errorCopy, formatQuantity, toQuantityString } from "@/domains/workshop-stock/format";
import type { ShoppingList, StockItem } from "@/domains/workshop-stock/schema";
import { QuantityStepper } from "./QuantityStepper";
import { BigButton, FIELD, LinkButton, MiniButton, Slot } from "./ui";

/**
 * "Add to a shopping list" on one item (Workshop Stock): pick an open list —
 * your latest is chosen — or start one, say how many you need, add. The list
 * then says whether the workshop has it or it's for the wholesaler. Context on
 * a record (P10): nothing is added to the screen until it's asked for.
 */
export function AddToList({ item, viewerId, onOpenList }: { item: StockItem; viewerId: string | null; onOpenList: (listId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [lists, setLists] = useState<ShoppingList[] | null>(null);
  const [pick, setPick] = useState<string | "new" | null>(null);
  const [newName, setNewName] = useState("");
  const [qty, setQty] = useState(1000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<{ listId: string; name: string; qty: number } | null>(null);

  async function start() {
    setOpen(true);
    setError(null);
    const r = await fetchLists();
    if (!r.ok) { setError(errorCopy(r.error.status, r.error.body, "The lists didn't arrive — try again.")); setLists([]); setPick("new"); return; }
    const openLists = r.data.lists.filter((l) => !l.doneAt);
    setLists(openLists);
    const mine = openLists.find((l) => l.ownerId === viewerId);
    setPick((mine ?? openLists[0])?.id ?? "new");
  }

  async function add() {
    if (!pick || busy) return;
    setBusy(true);
    setError(null);
    let listId = pick;
    let name = lists?.find((l) => l.id === pick)?.name ?? "";
    if (pick === "new") {
      name = newName.trim();
      const id = newId();
      const s = await saveList({ id, name });
      if (!s.ok) { setBusy(false); setError(errorCopy(s.error.status, s.error.body)); return; }
      listId = s.data.list.id;
      setLists((ls) => [s.data.list, ...(ls ?? [])]);
      setPick(listId);
    }
    const r = await saveListLine({ listId, id: newId(), itemId: item.id, quantity: toQuantityString(qty) });
    setBusy(false);
    if (!r.ok) { setError(errorCopy(r.error.status, r.error.body)); return; }
    setAdded({ listId, name, qty });
  }

  if (!open) {
    return <BigButton variant="ter" icon={<ClipboardList aria-hidden="true" className="h-5 w-5" />} label="Add to a shopping list" onClick={() => void start()} data-testid="stock-add-to-list" />;
  }
  if (added) {
    return (
      <Slot tone="ok" title={`Added ${formatQuantity(added.qty, item.baseUnit)} to ${added.name}`} role="status" testId="stock-add-to-list-done" below={<div className="flex flex-wrap gap-2"><MiniButton variant="nav" onClick={() => onOpenList(added.listId)} data-testid="stock-add-to-list-open">Open the list</MiniButton><MiniButton onClick={() => { setAdded(null); setQty(1000); }}>Add to another</MiniButton></div>}>
        {item.balanceMilli ? "It's in the workshop part of the list." : "None recorded in the workshop — it's on the wholesaler part."}
      </Slot>
    );
  }
  const ready = pick && (pick !== "new" || newName.trim());
  const target = pick === "new" ? newName.trim() || "a new list" : lists?.find((l) => l.id === pick)?.name ?? "the list";
  return (
    <div className="space-y-2.5 rounded-[14px] border border-border p-3" data-testid="stock-add-to-list-panel">
      <p className="text-sm font-semibold text-text">Which list?</p>
      {!lists ? <p className="text-sm text-text-muted" role="status">Loading…</p> : (
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Which list">
          {lists.map((l) => (
            <button key={l.id} type="button" role="radio" aria-checked={pick === l.id} onClick={() => setPick(l.id)} className={cn("min-h-[40px] max-w-full truncate rounded-pill border px-3 text-sm font-semibold", pick === l.id ? "border-brand-navy bg-brand-navy text-text-inverse" : "border-border-strong bg-surface text-text")} data-testid="stock-add-to-list-pick">
              {l.name}
            </button>
          ))}
          <button type="button" role="radio" aria-checked={pick === "new"} onClick={() => setPick("new")} className={cn("min-h-[40px] rounded-pill border border-dashed px-3 text-sm font-semibold", pick === "new" ? "border-brand-navy bg-brand-navy text-text-inverse" : "border-border-strong bg-surface text-text")} data-testid="stock-add-to-list-new">
            + New list
          </button>
        </div>
      )}
      {pick === "new" ? <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="What's it for? e.g. Smith reno" maxLength={80} autoComplete="off" className={FIELD} aria-label="Name of the new list" data-testid="stock-add-to-list-name" /> : null}
      <QuantityStepper label="How many do you need?" valueMilli={qty} onChange={setQty} unit={item.baseUnit} testId="stock-add-to-list-qty" />
      {error ? <Slot tone="bad" role="alert">{error}</Slot> : null}
      <BigButton variant="nav" label={busy ? "Adding…" : `Add ${formatQuantity(qty, item.baseUnit)} to ${target}`} disabled={!ready || busy} onClick={() => void add()} data-testid="stock-add-to-list-save" />
      <LinkButton onClick={() => { setOpen(false); setError(null); }}>Not now</LinkButton>
    </div>
  );
}
