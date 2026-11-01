"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { replaceItemPhoto, storePhoto } from "@/domains/workshop-stock/client";
import { errorCopy } from "@/domains/workshop-stock/format";
import type { StockItem } from "@/domains/workshop-stock/schema";
import { PhotoCapture } from "./PhotoCapture";
import { Slot } from "./ui";

/**
 * "No photo of where it lives yet" — offered while someone is putting stock
 * away (Add / Return) or looking at an item that has none (owner pull
 * 2026-11-01: "when someone is putting an item into stock, they take a photo
 * of the general location — the shelf text might be wrong, the photo is the
 * reference").
 *
 * One tap opens the camera; the photo is saved to the item straight away, on
 * its own — it is a fact about the item, not part of the movement, so the
 * take/add never waits on it and never fails because of it. The crew can only
 * FILL a missing photo; replacing one stays the office's (like the shelf
 * text), and the server refuses anything else.
 */
export function LocationPhotoPrompt({ itemId, onSaved, className }: { itemId: string; onSaved: (item: StockItem) => void; className?: string }) {
  const [state, setState] = useState<"idle" | "saving" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function save(dataUrl: string, thumbDataUrl: string | null) {
    setState("saving");
    setMessage(null);
    const s = await storePhoto(dataUrl, thumbDataUrl);
    if (!s.ok) {
      setState("error");
      setMessage(errorCopy(s.error.status, s.error.body, "Couldn't save the photo just now. Try again — the stock itself is unaffected."));
      return;
    }
    const r = await replaceItemPhoto(itemId, s.data.photoId, "location");
    if (!r.ok) {
      setState("error");
      setMessage(errorCopy(r.error.status, r.error.body, "Couldn't save the photo just now. Try again — the stock itself is unaffected."));
      return;
    }
    setState("done");
    onSaved(r.data.item);
  }

  if (state === "saving") {
    return (
      <Slot tone="inf" icon={Loader2} title="Saving the photo of where it lives…" className={className} role="status">
        The stock itself doesn&rsquo;t wait on this.
      </Slot>
    );
  }
  if (state === "done") {
    return (
      <Slot tone="ok" title="Photo of where it lives saved" className={className} role="status" testId="stock-location-prompt-done">
        Shown to whoever comes to take it.
      </Slot>
    );
  }
  return (
    <Slot
      tone="neu"
      title="No photo of where it lives yet"
      className={className}
      testId="stock-location-prompt"
      below={
        <>
          <PhotoCapture variant="single" tone="ter" label="Photograph where it's going" sub="saved to the item now · on its own" onPhoto={(u, _d, t) => void save(u, t)} testId="stock-location-prompt-photo" />
          {message ? <p role="alert" className="mt-1.5 text-sm font-medium text-state-danger-subtle-text">{message}</p> : null}
        </>
      }
    >
      Putting it away? Photograph the spot — the next person finds it from the photo, not just the shelf text.
    </Slot>
  );
}
