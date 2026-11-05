"use client";

import { useEffect, useRef, useState } from "react";
import { Bluetooth, Download, Loader2, Printer, Usb } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { BIN_LABEL_KINDS, binLabels, layoutBinLabel, rackLabels, type BinLabelKind, type BinLabelSpec } from "@/domains/workshop-stock/bin-label";
import { locationText, rackLabel, type LocationMatrix, type MatrixRack } from "@/domains/workshop-stock/location-matrix";
import { LABEL_SIZES, type LabelSize } from "@/domains/workshop-stock/label";
import type { useLabelPrinter } from "@/components/stock/useLabelPrinter";

type Printer = ReturnType<typeof useLabelPrinter>;

/**
 * Bin labels on the location matrix (owner, 2026-11-05): the code label
 * ("A2 B3") and the contents label (what goes in the bin), printed straight to
 * the NIIMBOT on the same connection as item labels — one bin from its editor,
 * or a whole rack from its header. docs/workshop-stock.md
 */

/** Draw a bin label: white, black text, each line as large as its layout says and no wider than the label. */
export function drawBinLabel(canvas: HTMLCanvasElement, size: LabelSize, spec: BinLabelSpec) {
  const lay = layoutBinLabel(size, spec);
  canvas.width = lay.width;
  canvas.height = lay.height;
  const g = canvas.getContext("2d");
  if (!g) return;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, lay.width, lay.height);
  g.fillStyle = "#000";
  g.textBaseline = "top";
  g.textAlign = "center";
  const room = lay.width - 12;
  for (const line of lay.lines) {
    const font = (px: number) => `${line.bold ? "700" : "500"} ${px}px system-ui, sans-serif`;
    g.font = font(line.size);
    const wide = g.measureText(line.text).width;
    const px = wide > room ? Math.floor((line.size * room) / wide) : line.size;
    g.font = font(px);
    // shrunk text sits in the middle of the line's height, so a long code doesn't hug the top
    g.fillText(line.text, lay.width / 2, line.y + Math.round((line.size - px) / 2), room);
  }
}

/** Every label of a print job, drawn at the size given (fitted to the printer's head). */
export function drawBinLabels(size: LabelSize, specs: BinLabelSpec[]): HTMLCanvasElement[] {
  return specs.map((spec) => {
    const canvas = document.createElement("canvas");
    drawBinLabel(canvas, size, spec);
    return canvas;
  });
}

function count(n: number): string {
  return `${n} ${n === 1 ? "label" : "labels"}`;
}

function Chip({ on, onClick, children, testId }: { on: boolean; onClick: () => void; children: React.ReactNode; testId?: string }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={cn("h-8 rounded-[4px] border px-2.5 text-xs font-semibold", on ? "border-accent-yellow bg-surface-raised text-text ring-1 ring-accent-yellow" : "border-border bg-surface-subtle text-text-muted hover:border-border-strong")} data-testid={testId}>
      {children}
    </button>
  );
}

/** The bar at the top of the matrix: label size (the roll in the printer), which labels, and the printer. */
export function BinLabelBar({ lp, size, setSize, kind, setKind }: { lp: Printer; size: LabelSize; setSize: (key: string) => void; kind: BinLabelKind; setKind: (k: BinLabelKind) => void }) {
  return (
    <section className="rounded-[4px] border border-border bg-surface p-3" data-testid="stock-binlabel-bar">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="console-label">Bin labels</h2>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Label size">
          {LABEL_SIZES.map((s) => <Chip key={s.key} on={s.key === size.key} onClick={() => { setSize(s.key); lp.clear(); }} testId="stock-binlabel-size">{s.label}</Chip>)}
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Which labels">
          {BIN_LABEL_KINDS.map((k) => <Chip key={k.key} on={k.key === kind} onClick={() => setKind(k.key)} testId="stock-binlabel-kind">{k.label}</Chip>)}
        </div>
        <span className="flex-1" />
        {lp.canPrint ? (
          lp.printer ? (
            <span className="flex items-center gap-2 text-xs text-text-muted" data-testid="stock-binlabel-printer">
              {lp.printer.link === "usb" ? <Usb aria-hidden="true" className="h-4 w-4" /> : <Bluetooth aria-hidden="true" className="h-4 w-4" />}
              {lp.printer.name}
              <Button type="button" variant="ghost" size="sm" disabled={!!lp.state} onClick={() => void lp.disconnect()}>Disconnect</Button>
            </span>
          ) : (
            <span className="text-xs text-text-muted" data-testid="stock-binlabel-printer">Print connects to the printer by {lp.links.bluetooth ? "Bluetooth" : "USB cable"}.</span>
          )
        ) : (
          <span className="text-xs text-text-muted">Printing straight to the label printer needs Chrome or Edge on a computer. Save a bin&apos;s labels as pictures from its editor instead.</span>
        )}
      </div>
      <p className="mt-1.5 text-xs text-text-muted">The code label is the bin&apos;s code as large as it fits (A2 B3 = rack A, shelf 2, bin 3). The contents label is the code with what goes in the bin — the words set below; a bin with none gets only its code.</p>
    </section>
  );
}

/** What happened to the last print started here — said next to the button that started it. */
function Status({ lp, mine }: { lp: Printer; mine: boolean }) {
  if (!mine) return null;
  if (lp.error) return <p className="mt-2 text-sm text-state-danger" role="alert" data-testid="stock-binlabel-error">{lp.error}</p>;
  if (lp.printed) return <p className="mt-2 text-sm text-state-success" role="status" data-testid="stock-binlabel-printed">{lp.printed}</p>;
  return null;
}

function PrintButton({ lp, label, onPrint, testId }: { lp: Printer; label: string; onPrint: (link?: "bluetooth" | "usb") => void; testId: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" disabled={!!lp.state} onClick={() => onPrint()} data-testid={testId}>
        {lp.state ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <Printer aria-hidden="true" className="h-4 w-4" />}
        {lp.state === "connecting" ? "Connecting…" : lp.state === "printing" ? "Printing…" : label}
      </Button>
      {!lp.printer && lp.links.bluetooth && lp.links.usb ? (
        <Button type="button" variant="ghost" size="sm" disabled={!!lp.state} onClick={() => onPrint("usb")} data-testid={`${testId}-usb`}>
          <Usb aria-hidden="true" className="h-4 w-4" /> USB cable instead
        </Button>
      ) : null}
    </span>
  );
}

/** Print these labels; `done` is what's said once they're out. */
export type PrintBinLabels = (specs: BinLabelSpec[], done: string, link?: "bluetooth" | "usb") => void;

/** In a bin's editor: its labels as they'll print, Print them, or save them as pictures. */
export function BinLabelPreview({ lp, size, kind, matrix, rack, shelf, bin, mine, onPrint }: { lp: Printer; size: LabelSize; kind: BinLabelKind; matrix: LocationMatrix; rack: MatrixRack; shelf: number; bin: number; mine: boolean; onPrint: PrintBinLabels }) {
  const specs = binLabels(matrix, rack, shelf, bin, kind);
  const place = locationText(rack, shelf, bin);
  const box = useRef<HTMLDivElement | null>(null);
  const [urls, setUrls] = useState<string[]>([]);
  // redrawn when what's on the labels changes, not every time the matrix re-renders
  const content = JSON.stringify(specs);

  useEffect(() => {
    const host = box.current;
    if (!host) return;
    host.replaceChildren(...specs.map((spec) => {
      const canvas = document.createElement("canvas");
      drawBinLabel(canvas, size, spec);
      canvas.className = "h-auto w-40 rounded-[3px] border border-border bg-white";
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", spec.kind === "code" ? `Code label: ${spec.code}` : `Contents label: ${spec.code}, ${spec.contents.join(", ")}`);
      canvas.dataset.testid = "stock-binlabel-preview";
      return canvas;
    }));
    setUrls(Array.from(host.querySelectorAll("canvas"), (c) => c.toDataURL("image/png")));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `content` stands for `specs`
  }, [size, content]);

  function save() {
    urls.forEach((url, i) => {
      const a = document.createElement("a");
      a.href = url;
      a.download = `bin-${specs[i]!.code.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${specs[i]!.kind}.png`;
      a.click();
    });
  }

  if (!specs.length) {
    return <p className="mt-3 border-t border-border pt-3 text-xs text-text-muted" data-testid="stock-binlabel-none">Nothing set for this bin yet, so it has no contents label. Add words above, or print its code label.</p>;
  }
  return (
    <div className="mt-3 border-t border-border pt-3" data-testid="stock-binlabel-bin">
      <p className="console-label">Labels for {place}</p>
      <div ref={box} className="mt-2 flex flex-wrap gap-2" />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {lp.canPrint ? <PrintButton lp={lp} label={`Print ${count(specs.length)}`} onPrint={(link) => onPrint(specs, `Printed ${specs.length === 1 ? "the label" : count(specs.length)} for ${place}.`, link)} testId="stock-binlabel-print" /> : null}
        <Button type="button" variant="ghost" size="sm" onClick={save} disabled={!urls.length} data-testid="stock-binlabel-save"><Download aria-hidden="true" className="h-4 w-4" /> Save as pictures</Button>
      </div>
      <Status lp={lp} mine={mine} />
    </div>
  );
}

/** In a rack's header: Print every bin's labels — asked first, with the count, since it's a lot of labels. */
export function RackLabelPrint({ lp, kind, matrix, rack, mine, onPrint }: { lp: Printer; kind: BinLabelKind; matrix: LocationMatrix; rack: MatrixRack; mine: boolean; onPrint: PrintBinLabels }) {
  const [asking, setAsking] = useState(false);
  const specs = rackLabels(matrix, rack, kind);
  const rackName = rackLabel(rack.name);
  if (!lp.canPrint) return null;
  return (
    <div className="mt-2" data-testid="stock-binlabel-rack-area">
      {asking ? (
        <div className="flex flex-wrap items-center gap-2 rounded-[4px] border border-accent-yellow bg-surface-subtle p-2" data-testid="stock-binlabel-rack-confirm">
          <span className="text-sm text-text">Print {count(specs.length)} for {rackName}{lp.printer ? ` on ${lp.printer.name}` : ""}?</span>
          <PrintButton lp={lp} label="Print them" onPrint={(link) => { setAsking(false); onPrint(specs, `Printed ${count(specs.length)} for ${rackName}.`, link); }} testId="stock-binlabel-rack-go" />
          <Button type="button" variant="ghost" size="sm" onClick={() => setAsking(false)}>Cancel</Button>
        </div>
      ) : (
        <Button type="button" variant="ghost" size="sm" disabled={!specs.length || !!lp.state} onClick={() => setAsking(true)} data-testid="stock-binlabel-rack">
          <Printer aria-hidden="true" className="h-4 w-4" /> Print labels for this rack ({count(specs.length)})
        </Button>
      )}
      <Status lp={lp} mine={mine} />
    </div>
  );
}
