"use client";

/**
 * Printing a label straight to a NIIMBOT printer from Chrome (owner,
 * 2026-11-03: "is there a way to incorporate the printer" — a B1, on the
 * office computer, in Chrome). No NIIMBOT app in between: Chrome talks to the
 * printer over Bluetooth (Web Bluetooth) or a USB cable (Web Serial), and the
 * open-source @mmote/niimbluelib speaks the printer's protocol.
 *
 * NIIMBOT doesn't publish that protocol — the library is reverse-engineered,
 * so a printer firmware update could break it. Save image (→ the NIIMBOT app)
 * stays beside it as the fallback.
 *
 * The library (and the Capacitor code it pulls in) is loaded only when someone
 * presses Print, never with the stock screen. One printer connection is kept
 * for the whole tab, so the second label doesn't ask again.
 */

import type { NiimbotAbstractClient, PrinterModelMeta, PrintTaskName } from "@mmote/niimbluelib";

export type PrinterLink = "bluetooth" | "usb";

export interface ConnectedPrinter {
  /** what the printer calls itself over Bluetooth ("B1-H123…"), or the model */
  name: string;
  /** the NIIMBOT model the printer reported ("B1") */
  model: string;
  printheadPixels: number;
  direction: "top" | "left";
  link: PrinterLink;
}

type Lib = typeof import("@mmote/niimbluelib");

let lib: Lib | null = null;
let client: NiimbotAbstractClient | null = null;
let current: ConnectedPrinter | null = null;
let task: PrintTaskName | null = null;
let meta: PrinterModelMeta | null = null;
const listeners = new Set<(p: ConnectedPrinter | null) => void>();

function announce() {
  for (const l of listeners) l(current);
}

/** Be told when the printer connects or drops (switched off, out of range). */
export function onPrinterChange(listener: (p: ConnectedPrinter | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function connectedPrinter(): ConnectedPrinter | null {
  return current;
}

/** What this browser can use to reach a printer. Chrome and Edge on a computer: both; Chrome on Android: Bluetooth; Safari, Firefox, iPhone: neither. */
export function printerLinks(): { bluetooth: boolean; usb: boolean } {
  if (typeof navigator === "undefined") return { bluetooth: false, usb: false };
  const nav = navigator as Navigator & { bluetooth?: unknown; serial?: unknown };
  return { bluetooth: !!nav.bluetooth, usb: !!nav.serial };
}

/**
 * Load the library (once). Webpack hands back its named exports; other
 * bundlers can wrap a CommonJS module under `default` — take either, so a
 * bundler change can't quietly break Print.
 */
async function loadLib(): Promise<Lib> {
  if (lib) return lib;
  const mod = (await import("@mmote/niimbluelib")) as Lib & { default?: Lib };
  lib = typeof mod.NiimbotBluetoothClient === "function" ? mod : (mod.default as Lib);
  return lib;
}

/**
 * Fetch the library ahead of the first Print. Chrome only opens its printer
 * chooser shortly after a click — a slow download between the click and the
 * chooser would have it refuse — so the label panel starts this as it opens.
 */
export function preloadPrinterLibrary(): void {
  void loadLib().catch(() => { /* tried again on Print */ });
}

/** A message for the person, or null when they simply closed Chrome's printer chooser. */
export class PrinterError extends Error {}

function cancelled(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  const msg = String((e as { message?: string } | null)?.message ?? "");
  return name === "NotFoundError" && /cancel|no port selected|chooser/i.test(msg);
}

/**
 * Ask Chrome for the printer (its chooser opens), connect, and find out what
 * model it is. Resolves null when the chooser was closed without picking one.
 */
export async function connectPrinter(link: PrinterLink): Promise<ConnectedPrinter | null> {
  const l = await loadLib();
  await disconnectPrinter();
  const c: NiimbotAbstractClient = link === "usb" ? new l.NiimbotSerialClient() : new l.NiimbotBluetoothClient();
  let info: { deviceName?: string };
  try {
    info = await c.connect();
  } catch (e) {
    try { await c.disconnect(); } catch { /* already gone */ }
    if (cancelled(e)) return null;
    throw new PrinterError(
      link === "usb"
        ? "Couldn't connect to the printer over USB. Check the cable is in and the printer is on, then try again."
        : "Couldn't connect to the printer. Check it's switched on and close the NIIMBOT app on any phone that's connected to it, then try again.",
    );
  }
  const m = c.getModelMetadata();
  const t = c.getPrintTaskType();
  if (!m || !t) {
    await c.disconnect();
    throw new PrinterError("This printer model isn't one BuhlOS can print to yet. Use Save image and print it from the NIIMBOT app.");
  }
  if (m.dpi !== 203) {
    await c.disconnect();
    throw new PrinterError(`Labels are drawn for 203 dpi printers and this ${m.model} prints at ${m.dpi} dpi. Use Save image and print it from the NIIMBOT app.`);
  }
  c.on("disconnect", () => {
    if (client !== c) return;
    client = null;
    current = null;
    task = null;
    meta = null;
    announce();
  });
  client = c;
  task = t;
  meta = m;
  current = {
    name: info.deviceName || String(m.model),
    model: String(m.model),
    printheadPixels: m.printheadPixels,
    direction: m.printDirection,
    link,
  };
  announce();
  return current;
}

export async function disconnectPrinter(): Promise<void> {
  const c = client;
  client = null;
  current = null;
  task = null;
  meta = null;
  if (c) {
    try { await c.disconnect(); } catch { /* already gone */ }
    announce();
  }
}

/**
 * What to tell the person when the printer refuses a job, by the reason it
 * gives (the library's PrinterErrorCode numbers). Anything else: the plain
 * "didn't print".
 */
export function printFailureCopy(reasonId: number | undefined): string {
  switch (reasonId) {
    case 1: return "The printer's lid is open. Shut it and try again.";
    case 2:
    case 8:
    case 28: return "The printer is out of labels, or they aren't loaded right. Check the roll and try again.";
    case 16: return "The printer says these labels are the wrong kind for it. Check the roll and try again.";
    case 3:
    case 4: return "The printer's battery is low. Charge it or plug it in, then try again.";
    case 7: return "The printer is too hot. Give it a minute, then try again.";
    case 9: return "The printer is busy. Wait for it to finish, then try again.";
    default: return "The label didn't print. Check the printer is on and has labels, then try again.";
  }
}

/** How long a label may take before we stop waiting for the printer to say it's done. */
export const PRINT_TIMEOUT_MS = 30_000;

/**
 * The label centred on the whole print head. A label narrower than the head
 * (40 mm on the B1's 48 mm) is sent at full head width with white either
 * side, so it lands in the middle whether the printer centres what it's sent
 * or starts it at the edge. The head is across the width for "top" printers
 * and across the height for "left" ones.
 */
export function padToHead(canvas: HTMLCanvasElement, printheadPixels: number, direction: "top" | "left"): HTMLCanvasElement {
  const across = direction === "left" ? canvas.height : canvas.width;
  if (across >= printheadPixels) return canvas;
  const out = document.createElement("canvas");
  out.width = direction === "left" ? canvas.width : printheadPixels;
  out.height = direction === "left" ? printheadPixels : canvas.height;
  const g = out.getContext("2d");
  if (!g) return canvas;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, out.width, out.height);
  g.drawImage(canvas, direction === "left" ? 0 : Math.floor((printheadPixels - across) / 2), direction === "left" ? Math.floor((printheadPixels - across) / 2) : 0);
  return out;
}

/**
 * Print the canvas (drawn at the printer's 8 dots/mm, already fitted to its
 * print head) `copies` times on the connected printer. Throws PrinterError
 * with something the person can act on.
 *
 * The library's background "are you there" ping is paused while printing, so
 * it can't sit between the print's own messages (and swallow a printer error
 * meant for the print), and a print that never reports finished gives up
 * after PRINT_TIMEOUT_MS instead of leaving the button on "Printing…".
 */
export async function printCanvas(canvas: HTMLCanvasElement, copies = 1): Promise<void> {
  if (!lib || !client || !current || !task || !meta) throw new PrinterError("The printer isn't connected. Press Print again to connect it.");
  const c = client;
  const image = lib.ImageEncoder.encodeCanvas(padToHead(canvas, meta.printheadPixels, meta.printDirection), lib.PageColorType.SingleColor, meta.printDirection);
  const job = c.protocol.newPrintTask(task, {
    totalPages: copies,
    density: meta.densityDefault,
    labelType: lib.LabelType.WithGaps,
  });
  const beating = c.isHeartbeatStarted();
  c.stopHeartbeat();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await job.printInit();
    await job.printPage(image, copies);
    await Promise.race([
      job.waitForFinished(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PrinterError("The printer didn't say it had finished. Check it, then try again.")), PRINT_TIMEOUT_MS);
      }),
    ]);
  } catch (e) {
    if (e instanceof PrinterError) throw e;
    throw new PrinterError(printFailureCopy((e as { reasonId?: number } | null)?.reasonId));
  } finally {
    clearTimeout(timer);
    try { await job.printEnd(); } catch { /* the printer may already have dropped */ }
    if (beating && client === c && c.isConnected()) c.startHeartbeat();
  }
}
