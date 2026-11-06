"use client";

import { useEffect } from "react";
import { Bluetooth, Loader2, Printer, Usb } from "lucide-react";
import type { LabelSize } from "@/domains/workshop-stock/label";
import type { useLabelPrinter } from "./useLabelPrinter";
import { BigButton, MiniButton, Slot } from "./ui";

/**
 * Print label — an item's label straight to a NIIMBOT printer from Chrome, no
 * NIIMBOT app (owner, 2026-11-03: a B1, on the office computer). The first
 * Print opens Chrome's printer list (Bluetooth, or USB with "Use a USB cable
 * instead"); the printer stays connected for the tab. A size the connected
 * printer doesn't take is said next to the button and not printed.
 *
 * `drawLabel` draws the label at the size it's given onto a canvas — the
 * same drawing as the preview, fitted to the printer's head.
 */
export function LabelDirectPrint({ lp, size, drawLabel }: {
  lp: ReturnType<typeof useLabelPrinter>;
  size: LabelSize;
  drawLabel: (canvas: HTMLCanvasElement, size: LabelSize) => void;
}) {
  const { links, printer, state, printed, error, clear } = lp;
  useEffect(() => { clear(); }, [size.key, clear]);

  function print(link?: "bluetooth" | "usb") {
    void lp.print({
      size,
      link,
      done: "Printed. Stick it on the item or its bin — scanning it opens this item.",
      draw: (fitted) => {
        const canvas = document.createElement("canvas");
        drawLabel(canvas, fitted);
        return [canvas];
      },
    });
  }

  return (
    <div className="space-y-2" data-testid="stock-label-direct">
      <BigButton
        variant="pri"
        icon={state ? <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" /> : <Printer aria-hidden="true" className="h-5 w-5" />}
        label={state === "connecting" ? "Connecting…" : state === "printing" ? "Printing…" : "Print label"}
        sub={printer ? `on ${printer.name}` : links.bluetooth ? "connects to the printer by Bluetooth" : "connects to the printer by USB cable"}
        disabled={!!state}
        onClick={() => print()}
        data-testid="stock-label-print"
      />
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-text-muted">
        {printer ? (
          <>
            <MiniButton onClick={() => void lp.disconnect()} disabled={!!state} data-testid="stock-label-disconnect">Disconnect printer</MiniButton>
            <span className="inline-flex items-center gap-1">{printer.link === "usb" ? <Usb aria-hidden="true" className="h-4 w-4" /> : <Bluetooth aria-hidden="true" className="h-4 w-4" />}Connected</span>
          </>
        ) : links.bluetooth && links.usb ? (
          <MiniButton onClick={() => print("usb")} disabled={!!state} data-testid="stock-label-print-usb">
            <Usb aria-hidden="true" className="mr-1 inline h-4 w-4" />Use a USB cable instead
          </MiniButton>
        ) : null}
      </div>
      {printed ? <Slot tone="ok" role="status" testId="stock-label-printed">{printed}</Slot> : null}
      {error ? <Slot tone="bad" role="alert" testId="stock-label-print-error">{error}</Slot> : null}
    </div>
  );
}
