"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Drawer } from "@/components/ui/Drawer";
import { Button } from "@/components/ui/Button";
import { NewItemForm, type NewItemSeed } from "@/components/stock/NewItemForm";
import { PhotoCapture } from "@/components/stock/PhotoCapture";
import { StockThumb } from "@/components/stock/StockThumb";
import { readPhoto } from "@/domains/workshop-stock/client";
import { decideRead } from "@/domains/workshop-stock/flow";
import { balanceLabel, errorCopy, READ_STATUS_COPY } from "@/domains/workshop-stock/format";
import type { CandidateItem, StockItem, WriteResult } from "@/domains/workshop-stock/schema";
import { Block } from "./StockAdminForms";

/**
 * Office "Add item": the same new-item form the crew uses, by hand or with a
 * photo (optional — drop one and the name and codes are read from it). A photo
 * that turns out to be an item already listed says so and points at its row;
 * nothing is created twice. Same "Saves as" line, same single transaction.
 */
export function StockAdminAdd({ items, capabilities, onSaved, onOpenItem, onClose }: { items: StockItem[]; capabilities: { photoRead: boolean; lookup: boolean }; onSaved: (r: WriteResult) => void; onOpenItem: (id: string) => void; onClose: () => void }) {
  const [seed, setSeed] = useState<NewItemSeed>({ product: null, photoId: null, dataUrl: null });
  const [formKey, setFormKey] = useState(1);
  const [reading, setReading] = useState(false);
  const [note, setNote] = useState<{ tone: "warn" | "neu" | "inf"; title: string; body: string } | null>(null);
  const [matched, setMatched] = useState<CandidateItem | null>(null);
  const [lastLocation, setLastLocation] = useState<string | null>(null);
  const [saved, setSaved] = useState<WriteResult | null>(null);

  async function onPhoto(dataUrl: string, _dark: boolean, thumb: string | null) {
    setReading(true);
    setNote(null);
    setMatched(null);
    const r = await readPhoto(dataUrl, "add", thumb);
    setReading(false);
    if (!r.ok) {
      setSeed({ product: null, photoId: null, dataUrl, thumbDataUrl: thumb });
      setFormKey((k) => k + 1);
      setNote({ tone: "warn", title: "Couldn't read the photo", body: `${errorCopy(r.error.status, r.error.body, "The reader didn't answer.")} The photo is kept for the item — fill the form by hand.` });
      return;
    }
    const outcome = decideRead(r.data, null);
    const product = outcome.kind !== "status" && outcome.kind !== "pick-product" ? r.data.reading?.products[outcome.productIndex] ?? null : outcome.kind === "pick-product" ? outcome.products[0] ?? null : null;
    setSeed({ product, photoId: r.data.photoId, dataUrl, thumbDataUrl: thumb });
    setFormKey((k) => k + 1);
    if (outcome.kind === "status") setNote({ tone: "warn", title: READ_STATUS_COPY[outcome.status].title, body: "The photo is kept for the item — fill the form by hand." });
    else if (outcome.kind === "exact") setMatched(outcome.item);
    else if (outcome.kind === "candidates") setNote({ tone: "inf", title: "This may already be listed", body: `It looks like ${outcome.candidates.map((c) => `“${c.item.name}”`).join(" or ")}. Check the list before saving a new item.` });
    else if (outcome.kind === "pick-product") setNote({ tone: "neu", title: "More than one product in the photo", body: "The first one fills the form — check the details." });
  }

  function onFormSaved(r: WriteResult, again: boolean) {
    onSaved(r);
    setLastLocation(r.item.location);
    if (!again) {
      onClose();
      return;
    }
    setSaved(r);
    setSeed({ product: null, photoId: null, dataUrl: null });
    setMatched(null);
    setNote(null);
    setFormKey((k) => k + 1);
  }

  return (
    <Drawer open onClose={onClose} title="Add item" subtitle="new workshop stock · by hand or from a photo">
      <div className="-mx-1 space-y-4" data-testid="stock-admin-add-drawer">
        {saved ? (
          <Block tone="inf" title={`Saved: ${saved.item.name}`} role="status">
            <p>{balanceLabel(saved.item)} recorded{saved.item.location ? ` at ${saved.item.location}` : ""}. Add the next one below.</p>
          </Block>
        ) : null}
        {capabilities.photoRead ? (
          <div className="flex items-start gap-3 rounded-card border border-dashed border-border-strong bg-surface-subtle p-3">
            {seed.dataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- local preview
              <img src={seed.dataUrl} alt="The photo" className="h-16 w-16 shrink-0 rounded-[4px] border border-border object-cover" />
            ) : (
              <StockThumb photoId={null} alt="" size="lg" />
            )}
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-sm text-text-muted">{seed.dataUrl ? "Label read · becomes the item's photo." : "Optional. Photograph the item or its label and the name and codes are read from it."}</p>
              {reading ? (
                <p className="flex items-center gap-2 text-sm text-text" role="status"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> Reading the label…</p>
              ) : (
                <PhotoCapture label={seed.dataUrl ? "Replace photo" : "Choose photo"} onPhoto={(u, d, t) => void onPhoto(u, d, t)} testId="stock-admin-add-photo" />
              )}
            </div>
          </div>
        ) : null}
        {note ? <Block tone={note.tone} title={note.title} role="status"><p>{note.body}</p></Block> : null}
        {matched ? (
          <Block tone="inf" title={`Already listed as “${matched.name}”`} role="status" testId="stock-admin-add-matched">
            <p>{[matched.location, `${balanceLabel(matched)} recorded`].filter(Boolean).join(" · ")}. Add to it from its row instead of making a second item.</p>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button type="button" size="sm" onClick={() => onOpenItem(matched.id)}>Open that item</Button>
              <Button type="button" variant="secondary" size="sm" onClick={() => setMatched(null)}>It&rsquo;s a different product</Button>
            </div>
          </Block>
        ) : (
          <NewItemForm key={formKey} seed={seed} items={items} lookupEnabled={capabilities.lookup} defaultLocation={lastLocation} emphasis="save" onSaved={onFormSaved} onUseExisting={(item) => onOpenItem(item.id)} />
        )}
      </div>
    </Drawer>
  );
}
