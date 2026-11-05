"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Loader2, Printer, Share2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { makeLabelBarcode } from "@/domains/workshop-stock/client";
import { errorCopy } from "@/domains/workshop-stock/format";
import { ean13Modules, isGuardModule, layoutLabel, LABEL_SIZES, type LabelSize } from "@/domains/workshop-stock/label";
import type { StockItem } from "@/domains/workshop-stock/schema";
import { BigButton, Slot } from "./ui";
import { LabelDirectPrint } from "./LabelDirectPrint";
import { useLabelPrinter } from "./useLabelPrinter";
import { useLabelSize } from "./useLabelSize";

/** The item's plain shop barcode (not a box's) — the one a label carries. */
export function itemBarcode(item: Pick<StockItem, "identifiers">): string | null {
  const unit = item.identifiers.find((i) => i.kind === "barcode" && !i.packSizeMilli && /^\d{13}$/.test(i.value));
  return unit?.value ?? null;
}

/** Draw the label (white background, black bars and text) at the printer's 203 dpi. */
function draw(canvas: HTMLCanvasElement, size: LabelSize, code: string, name: string, shelf: string | null) {
  const lay = layoutLabel(size, name, shelf);
  const modules = ean13Modules(code);
  canvas.width = lay.width;
  canvas.height = lay.height;
  const g = canvas.getContext("2d");
  if (!g || !modules) return;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, lay.width, lay.height);
  g.fillStyle = "#000";
  g.textBaseline = "top";
  g.textAlign = "center";
  g.font = `600 ${lay.nameSize}px system-ui, sans-serif`;
  lay.nameLines.forEach((line, i) => g.fillText(line, lay.width / 2, 4 + i * (lay.nameSize + 2), lay.width - 8));
  if (lay.shelf) {
    g.font = `${lay.digitsSize}px system-ui, sans-serif`;
    g.fillText(lay.shelf, lay.width / 2, 4 + lay.nameLines.length * (lay.nameSize + 2), lay.width - 8);
  }
  for (let i = 0; i < modules.length; i++) {
    if (modules[i] !== "1") continue;
    const extra = isGuardModule(i) ? Math.round(lay.digitsSize / 2) : 0;
    g.fillRect(lay.barsX + i * lay.module, lay.barsY, lay.module, lay.barsHeight + extra);
  }
  g.font = `${lay.digitsSize}px ui-monospace, monospace`;
  g.fillText(code.split("").join(" ").replace(/^(\d) /, "$1  "), lay.width / 2, lay.barsY + lay.barsHeight + 2, lay.width - 4);
}

/**
 * A barcode label for an item, for the NIIMBOT app (owner, 2026-11-03). An item
 * with no barcode first gets one of ours (in-store EAN-13, made by the server —
 * scanning it finds this item). Then: the label at the chosen size, Share (the
 * phone's share sheet → NIIMBOT) or Save the image. The label size is
 * remembered on this device. With `directPrint` (the office drawer), Print
 * label sends it straight to the printer where Chrome can reach one.
 */
export function BarcodeLabel({ item, onItemChanged, directPrint = false }: {
  item: StockItem;
  onItemChanged?: (item: StockItem) => void;
  /** offer Print label straight to the printer (office drawer only — the phone keeps Share to NIIMBOT) */
  directPrint?: boolean;
}) {
  const [code, setCode] = useState<string | null>(() => itemBarcode(item));
  const [size, setSize] = useLabelSize();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const shelf = item.location;
  const lp = useLabelPrinter(directPrint);
  const canPrint = lp.canPrint;

  useEffect(() => { setCode(itemBarcode(item)); }, [item]);

  useEffect(() => {
    if (!code || !canvasRef.current) return;
    draw(canvasRef.current, size, code, item.name, shelf);
    setUrl(canvasRef.current.toDataURL("image/png"));
  }, [code, size, item.name, shelf]);

  const fileName = useMemo(() => `label-${(item.name || "item").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}-${code ?? ""}.png`, [item.name, code]);

  async function giveBarcode() {
    setBusy(true);
    setError(null);
    const r = await makeLabelBarcode(item.id);
    setBusy(false);
    if (!r.ok) { setError(errorCopy(r.error.status, r.error.body, "Couldn't make a barcode for it.")); return; }
    setCode(r.data.barcode);
    if (r.data.item) onItemChanged?.(r.data.item);
  }

  async function share() {
    if (!canvasRef.current) return;
    const blob: Blob | null = await new Promise((done) => canvasRef.current!.toBlob(done, "image/png"));
    if (!blob) return;
    const file = new File([blob], fileName, { type: "image/png" });
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.share && nav.canShare?.({ files: [file] })) {
      try { await nav.share({ files: [file], title: item.name }); } catch { /* closed the share sheet */ }
      return;
    }
    download();
  }

  function download() {
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
  }

  if (!code) {
    return (
      <div className="space-y-3" data-testid="stock-label">
        <Slot tone="neu" title="No barcode on this item yet">Give it one of ours to print on a label — scanning the label then finds this item, like a barcode on a box.</Slot>
        {error ? <Slot tone="bad" role="alert">{error}</Slot> : null}
        <BigButton variant="pri" icon={busy ? <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" /> : <Printer aria-hidden="true" className="h-5 w-5" />} label={busy ? "Making it…" : "Make a barcode label"} sub="for items with no packaging" disabled={busy} onClick={() => void giveBarcode()} data-testid="stock-label-make" />
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="stock-label">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Label size">
        {LABEL_SIZES.map((s) => (
          <button key={s.key} type="button" aria-pressed={s.key === size.key} onClick={() => setSize(s.key)} className={cn("min-h-[40px] rounded-full border px-3 text-[13px] font-semibold", s.key === size.key ? "border-brand-navy bg-brand-navy text-text-inverse" : "border-border-strong bg-surface text-text")} data-testid="stock-label-size">
            {s.label}
          </button>
        ))}
      </div>
      <div className="flex justify-center rounded-xl border border-border bg-surface-subtle p-3">
        <canvas ref={canvasRef} className={cn("h-auto max-w-full rounded-[4px] border border-border bg-white shadow-sm", size.widthMm >= 50 ? "w-[340px]" : size.widthMm >= 40 ? "w-[280px]" : "w-[210px]")} aria-label={`Label: ${item.name}, barcode ${code}`} role="img" data-testid="stock-label-preview" />
      </div>
      <p className="text-center font-mono text-[13px] text-text-muted">{code}</p>
      {canPrint ? <LabelDirectPrint lp={lp} size={size} drawLabel={(canvas, size) => draw(canvas, size, code, item.name, shelf)} /> : null}
      <div className="grid grid-cols-2 gap-2">
        <BigButton variant={canPrint ? "sec" : "pri"} icon={<Share2 aria-hidden="true" className="h-5 w-5" />} label="Share to NIIMBOT" sub="or any app" onClick={() => void share()} data-testid="stock-label-share" />
        <BigButton variant="sec" icon={<Download aria-hidden="true" className="h-5 w-5" />} label="Save image" sub="then print it" onClick={download} data-testid="stock-label-save" />
      </div>
      <p className="text-[13px] text-text-muted">{canPrint ? "Or share or save it and print it as a picture in the NIIMBOT app, on the same size label." : "In the NIIMBOT app, print it as a picture on the same size label. Stick it on the item or its bin — scanning it opens this item."}</p>
    </div>
  );
}
