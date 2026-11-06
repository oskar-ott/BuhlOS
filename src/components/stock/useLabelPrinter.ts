"use client";

import { useCallback, useEffect, useState } from "react";
import { fitToPrinthead, sizesForPrinter, type LabelSize } from "@/domains/workshop-stock/label";
import { connectedPrinter, connectPrinter, disconnectPrinter, onPrinterChange, preloadPrinterLibrary, printerLinks, printLabels, PrinterError, type ConnectedPrinter, type PrinterLink } from "./labelPrinter";

export type PrinterLinks = { bluetooth: boolean; usb: boolean };

export interface PrintRequest {
  /** the label size picked — checked against the printer, then fitted to its head */
  size: LabelSize;
  /** draw every label of the job at the size given (fitted to the head) */
  draw: (fitted: LabelSize) => HTMLCanvasElement[];
  /** what to say when it's printed ("Printed.", "Printed 24 labels for Rack A.") */
  done: string;
  /** Bluetooth or USB; by default the one connected, else Bluetooth where there is it */
  link?: PrinterLink;
}

/**
 * Printing labels straight to the NIIMBOT from a screen: what this browser
 * can reach, the connected printer (shared across the tab), and one print at
 * a time — connect if needed (Chrome's printer list), refuse a size the
 * printer doesn't take (said as the error, nothing printed), draw the
 * labels fitted to its head, print them as one job. Used by the item label
 * and the bin labels; each screen draws its own buttons.
 */
export function useLabelPrinter(enabled: boolean) {
  const [links, setLinks] = useState<PrinterLinks>({ bluetooth: false, usb: false });
  const [printer, setPrinter] = useState<ConnectedPrinter | null>(null);
  const [state, setState] = useState<"connecting" | "printing" | null>(null);
  const [printed, setPrinted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const l = printerLinks();
    setLinks(l);
    // fetch the printer code now: Chrome only opens its printer list shortly after a click
    if (l.bluetooth || l.usb) preloadPrinterLibrary();
    setPrinter(connectedPrinter());
    return onPrinterChange(setPrinter);
  }, [enabled]);

  const canPrint = enabled && (links.bluetooth || links.usb);

  const print = useCallback(async (req: PrintRequest) => {
    if (state) return;
    setError(null);
    setPrinted(null);
    const link = req.link ?? connectedPrinter()?.link ?? (links.bluetooth ? "bluetooth" : "usb");
    try {
      let p = connectedPrinter();
      if (!p || p.link !== link) {
        setState("connecting");
        p = await connectPrinter(link);
        if (!p) return; // closed Chrome's printer list
      }
      const takes = sizesForPrinter(p.model, req.size);
      if (takes) {
        // said next to the button, and nothing sent — no label wasted
        setError(`The ${p.model} takes ${takes} mm labels. Pick the size on the roll that's in it, then Print again.`);
        return;
      }
      setState("printing");
      const canvases = req.draw(fitToPrinthead(req.size, p.printheadPixels, p.direction));
      await printLabels(canvases);
      setPrinted(req.done);
    } catch (e) {
      setError(e instanceof PrinterError ? e.message : "It didn't print. Check the printer is on and has labels, then try again.");
    } finally {
      setState(null);
    }
  }, [state, links.bluetooth]);

  const clear = useCallback(() => { setPrinted(null); setError(null); }, []);

  return {
    links,
    canPrint,
    printer,
    state,
    printed,
    error,
    print,
    clear,
    disconnect: disconnectPrinter,
  };
}
