"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bluetooth, Check, Download, Loader2, Printer, Usb } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { BIN_LABEL_NAMES, binLabels, layoutBinLabel, pickedLabels, rackLabels, type BinLabelKind, type BinLabelPick, type BinLabelSpec } from "@/domains/workshop-stock/bin-label";
import { locationText, rackLabel, type LocationMatrix, type MatrixRack } from "@/domains/workshop-stock/location-matrix";
import { LABEL_SIZES, type LabelSize } from "@/domains/workshop-stock/label";
import type { useLabelPrinter } from "@/components/stock/useLabelPrinter";

type Printer = ReturnType<typeof useLabelPrinter>;

/**
 * Bin labels on the location matrix (owner, 2026-11-05): the code label
 * ("3B-4") and the contents label (what goes in the bin), printed straight to
 * the NIIMBOT on the same connection as item labels — one bin from its editor,
 * or a whole rack from its header. Which labels print is picked label by label
 * (owner, 2026-11-06) and remembered on this computer. docs/workshop-stock.md
 */

const PICK_KEY = "buhlos.stock.binLabelPick";
const BOTH: BinLabelPick = { code: true, contents: true };

/** Which bin labels to print, remembered on this computer (a convenience only: without storage it's both). */
export function useBinLabelPick(): [BinLabelPick, (kind: BinLabelKind) => void] {
  const [pick, setPick] = useState<BinLabelPick>(() => {
    if (typeof window === "undefined") return BOTH;
    try {
      const saved = JSON.parse(window.localStorage.getItem(PICK_KEY) ?? "null") as Partial<BinLabelPick> | null;
      return saved && typeof saved.code === "boolean" && typeof saved.contents === "boolean" ? { code: saved.code, contents: saved.contents } : BOTH;
    } catch {
      return BOTH;
    }
  });
  const toggle = useCallback((kind: BinLabelKind) => {
    setPick((was) => {
      const next = { ...was, [kind]: !was[kind] };
      try { window.localStorage.setItem(PICK_KEY, JSON.stringify(next)); } catch { /* a per-computer convenience only */ }
      return next;
    });
  }, []);
  return [pick, toggle];
}

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

/** "6 code labels and 2 contents labels" — what a print is about to send. */
function describe(specs: BinLabelSpec[]): string {
  const parts = (["code", "contents"] as const)
    .map((kind) => [kind, specs.filter((s) => s.kind === kind).length] as const)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${n} ${kind} ${n === 1 ? "label" : "labels"}`);
  return parts.join(" and ") || "no labels";
}

function Chip({ on, onClick, children, testId }: { on: boolean; onClick: () => void; children: React.ReactNode; testId?: string }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={cn("h-8 rounded-[4px] border px-2.5 text-xs font-semibold", on ? "border-accent-yellow bg-surface-raised text-text ring-1 ring-accent-yellow" : "border-border bg-surface-subtle text-text-muted hover:border-border-strong")} data-testid={testId}>
      {children}
    </button>
  );
}

/** The bar at the top of the matrix: label size (the roll in the printer), which labels, and the printer. */
export function BinLabelBar({ lp, size, setSize, pick, togglePick }: { lp: Printer; size: LabelSize; setSize: (key: string) => void; pick: BinLabelPick; togglePick: (kind: BinLabelKind) => void }) {
  return (
    <section className="rounded-[4px] border border-border bg-surface p-3" data-testid="stock-binlabel-bar">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="console-label">Bin labels</h2>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Label size">
          {LABEL_SIZES.map((s) => <Chip key={s.key} on={s.key === size.key} onClick={() => { setSize(s.key); lp.clear(); }} testId="stock-binlabel-size">{s.label}</Chip>)}
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Which labels to print">
          {(["code", "contents"] as const).map((kind) => (
            <Chip key={kind} on={pick[kind]} onClick={() => togglePick(kind)} testId="stock-binlabel-pick">
              {pick[kind] ? <Check aria-hidden="true" className="mr-1 inline h-3.5 w-3.5" /> : null}{BIN_LABEL_NAMES[kind]}
            </Chip>
          ))}
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
      <p className="mt-1.5 text-xs text-text-muted">The code label is the bin&apos;s code as large as it fits (3B-4 = rack 3, shelf B, bin 4). The contents label is the code with what goes in the bin — the words set below; a bin with none has no contents label. Tick the labels you want; in a bin you can also click a label to tick or untick it.</p>
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

/** One label drawn on a canvas, as it will print (redrawn when what's on it changes). */
function LabelCanvas({ size, spec }: { size: LabelSize; spec: BinLabelSpec }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const content = JSON.stringify(spec);
  useEffect(() => {
    if (ref.current) drawBinLabel(ref.current, size, spec);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `content` stands for `spec`
  }, [size, content]);
  return (
    <canvas
      ref={ref}
      className="block h-auto w-40 rounded-[3px] border border-border bg-white"
      role="img"
      aria-label={spec.kind === "code" ? `Code label: ${spec.code}` : `Contents label: ${spec.code}, ${spec.contents.join(", ")}`}
      data-testid="stock-binlabel-preview"
    />
  );
}

/**
 * In a bin's editor: its labels as they'll print. Click a label to tick or
 * untick it; Print (or Save as pictures) takes the ticked ones.
 */
export function BinLabelPreview({ lp, size, pick, togglePick, matrix, rack, shelf, bin, mine, onPrint }: { lp: Printer; size: LabelSize; pick: BinLabelPick; togglePick: (kind: BinLabelKind) => void; matrix: LocationMatrix; rack: MatrixRack; shelf: number; bin: number; mine: boolean; onPrint: PrintBinLabels }) {
  const all = binLabels(matrix, rack, shelf, bin);
  const picked = pickedLabels(all, pick);
  const place = locationText(rack, shelf, bin);

  function save() {
    drawBinLabels(size, picked).forEach((canvas, i) => {
      const a = document.createElement("a");
      a.href = canvas.toDataURL("image/png");
      a.download = `bin-${picked[i]!.code.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${picked[i]!.kind}.png`;
      a.click();
    });
  }

  return (
    <div className="mt-3 border-t border-border pt-3" data-testid="stock-binlabel-bin">
      <p className="console-label">Labels for {place}</p>
      <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Labels to print">
        {all.map((spec) => (
          <button
            key={spec.kind}
            type="button"
            aria-pressed={pick[spec.kind]}
            onClick={() => togglePick(spec.kind)}
            className={cn("rounded-[4px] border p-1.5 text-left transition-opacity duration-100", pick[spec.kind] ? "border-accent-yellow bg-surface-raised" : "border-border bg-surface-subtle opacity-50 hover:opacity-80")}
            data-testid="stock-binlabel-toggle"
          >
            <LabelCanvas size={size} spec={spec} />
            <span className="mt-1 flex items-center gap-1 text-xs font-semibold text-text">
              <span className={cn("inline-flex h-4 w-4 items-center justify-center rounded-[3px] border", pick[spec.kind] ? "border-accent-yellow bg-accent-yellow text-text-inverse" : "border-border-strong")} aria-hidden="true">
                {pick[spec.kind] ? <Check className="h-3 w-3" /> : null}
              </span>
              {BIN_LABEL_NAMES[spec.kind]}
            </span>
          </button>
        ))}
      </div>
      {all.length === 1 ? <p className="mt-1.5 text-xs text-text-muted" data-testid="stock-binlabel-no-contents">No contents label: nothing is set for this bin yet. Add words above.</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {lp.canPrint ? (
          picked.length ? (
            <PrintButton lp={lp} label={`Print ${count(picked.length)}`} onPrint={(link) => onPrint(picked, `Printed ${picked.length === 1 ? "the label" : count(picked.length)} for ${place}.`, link)} testId="stock-binlabel-print" />
          ) : (
            <Button type="button" size="sm" disabled data-testid="stock-binlabel-print"><Printer aria-hidden="true" className="h-4 w-4" /> Tick a label to print</Button>
          )
        ) : null}
        <Button type="button" variant="ghost" size="sm" onClick={save} disabled={!picked.length} data-testid="stock-binlabel-save"><Download aria-hidden="true" className="h-4 w-4" /> Save as pictures</Button>
      </div>
      <Status lp={lp} mine={mine} />
    </div>
  );
}

/** In a rack's header: Print every bin's labels — asked first, with the count, since it's a lot of labels. */
export function RackLabelPrint({ lp, pick, matrix, rack, mine, onPrint }: { lp: Printer; pick: BinLabelPick; matrix: LocationMatrix; rack: MatrixRack; mine: boolean; onPrint: PrintBinLabels }) {
  const [asking, setAsking] = useState(false);
  const specs = rackLabels(matrix, rack, pick);
  const rackName = rackLabel(rack.name);
  if (!lp.canPrint) return null;
  return (
    <div className="mt-2" data-testid="stock-binlabel-rack-area">
      {asking ? (
        <div className="flex flex-wrap items-center gap-2 rounded-[4px] border border-accent-yellow bg-surface-subtle p-2" data-testid="stock-binlabel-rack-confirm">
          <span className="text-sm text-text">Print {describe(specs)} for {rackName}{lp.printer ? ` on ${lp.printer.name}` : ""}?</span>
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
