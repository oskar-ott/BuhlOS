"use client";

import { useEffect, useState } from "react";
import { Bluetooth, Loader2, Printer, Usb } from "lucide-react";
import { fitToPrinthead, sizesForPrinter, type LabelSize } from "@/domains/workshop-stock/label";
import { connectedPrinter, connectPrinter, disconnectPrinter, onPrinterChange, printCanvas, PrinterError, type ConnectedPrinter, type PrinterLink } from "./labelPrinter";
import { BigButton, MiniButton, Slot } from "./ui";

/**
 * Print label — straight to a NIIMBOT printer from Chrome, no NIIMBOT app
 * (owner, 2026-11-03: a B1, on the office computer). The first Print opens
 * Chrome's printer list (Bluetooth, or USB with "Use a USB cable instead");
 * the printer stays connected for the tab. A size the connected printer
 * doesn't take is said and not printed, so no label is wasted.
 *
 * `drawLabel` draws the label at the size it's given onto a canvas — the
 * same drawing as the preview, fitted to the printer's head.
 */
export function LabelDirectPrint({ size, links, drawLabel }: {
  size: LabelSize;
  links: { bluetooth: boolean; usb: boolean };
  drawLabel: (canvas: HTMLCanvasElement, size: LabelSize) => void;
}) {
  const [printer, setPrinter] = useState<ConnectedPrinter | null>(null);
  const [state, setState] = useState<"connecting" | "printing" | null>(null);
  const [printed, setPrinted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrongSize = sizesForPrinter(printer?.model, size);

  useEffect(() => {
    setPrinter(connectedPrinter());
    return onPrinterChange(setPrinter);
  }, []);
  useEffect(() => { setPrinted(false); setError(null); }, [size.key]);

  async function print(link: PrinterLink) {
    if (state) return;
    setError(null);
    setPrinted(false);
    try {
      let p = connectedPrinter();
      if (!p || p.link !== link) {
        setState("connecting");
        p = await connectPrinter(link);
        if (!p) return; // closed Chrome's printer list
      }
      if (sizesForPrinter(p.model, size)) return; // said above the button
      setState("printing");
      const canvas = document.createElement("canvas");
      drawLabel(canvas, fitToPrinthead(size, p.printheadPixels, p.direction));
      await printCanvas(canvas, 1);
      setPrinted(true);
    } catch (e) {
      setError(e instanceof PrinterError ? e.message : "The label didn't print. Check the printer is on and has labels, then try again.");
    } finally {
      setState(null);
    }
  }

  return (
    <div className="space-y-2" data-testid="stock-label-direct">
      {printer && wrongSize ? (
        <Slot tone="warn" testId="stock-label-size-mismatch">The {printer.model} takes {wrongSize} mm labels — pick the size on the roll that&apos;s in it, then Print.</Slot>
      ) : null}
      <BigButton
        variant="pri"
        icon={state ? <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" /> : <Printer aria-hidden="true" className="h-5 w-5" />}
        label={state === "connecting" ? "Connecting…" : state === "printing" ? "Printing…" : "Print label"}
        sub={printer ? `on ${printer.name}` : links.bluetooth ? "connects to the printer by Bluetooth" : "connects to the printer by USB cable"}
        disabled={!!state}
        onClick={() => void print(printer?.link ?? (links.bluetooth ? "bluetooth" : "usb"))}
        data-testid="stock-label-print"
      />
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-text-muted">
        {printer ? (
          <>
            <MiniButton onClick={() => void disconnectPrinter()} disabled={!!state} data-testid="stock-label-disconnect">Disconnect printer</MiniButton>
            <span className="inline-flex items-center gap-1">{printer.link === "usb" ? <Usb aria-hidden="true" className="h-4 w-4" /> : <Bluetooth aria-hidden="true" className="h-4 w-4" />}Connected</span>
          </>
        ) : links.bluetooth && links.usb ? (
          <MiniButton onClick={() => void print("usb")} disabled={!!state} data-testid="stock-label-print-usb">
            <Usb aria-hidden="true" className="mr-1 inline h-4 w-4" />Use a USB cable instead
          </MiniButton>
        ) : null}
      </div>
      {printed ? <Slot tone="ok" role="status" testId="stock-label-printed">Printed. Stick it on the item or its bin — scanning it opens this item.</Slot> : null}
      {error ? <Slot tone="bad" role="alert" testId="stock-label-print-error">{error}</Slot> : null}
    </div>
  );
}
