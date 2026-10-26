"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Flashlight, ScanLine } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Live code reading (Workshop Stock, Take screen): the phone's camera looks for
 * a barcode on its own — no shutter, about 1–2 s — using the browser's built-in
 * BarcodeDetector. Nothing leaves the phone and nothing is written: a code
 * found is handed to the screen, which matches it against the list it already
 * holds (so it still works with no signal) and opens the confirmation.
 *
 * Where the browser has no detector (iOS Safari today), the camera is refused,
 * or there is no camera, the viewfinder says so in one sentence and the rest of
 * the screen — search, "You often take", the label photo — carries on. The
 * torch is offered only when the camera reports it can.
 */

export type ScannerState = "starting" | "scanning" | "unsupported" | "denied" | "no-camera" | "error" | "off";

interface DetectedBarcode {
  rawValue: string;
}
interface DetectorLike {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>;
}
type DetectorCtor = new (opts?: { formats?: string[] }) => DetectorLike;

const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "itf"];
const SCAN_EVERY_MS = 260;
const SAME_CODE_QUIET_MS = 2500;

export const SCANNER_COPY: Record<Exclude<ScannerState, "scanning" | "starting" | "off">, string> = {
  unsupported: "This phone's browser can't read codes live — photograph the label, or search.",
  denied: "Camera is off for BuhlOS — turn it on in your phone's settings. Search and the label photo still work.",
  "no-camera": "No camera found on this device — search the list instead.",
  error: "The camera didn't start. Search the list, or photograph the label.",
};

function detectorCtor(): DetectorCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { BarcodeDetector?: DetectorCtor };
  return typeof w.BarcodeDetector === "function" ? w.BarcodeDetector : null;
}

export function liveReadingSupported(): boolean {
  return Boolean(detectorCtor()) && typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}

export function LiveCodeScanner({
  active,
  onCode,
  onState,
  frameText = "Point at the barcode or product code",
  hit = false,
  overlay,
  className,
}: {
  /** stop the camera while the screen shows something else */
  active: boolean;
  onCode: (raw: string) => void;
  onState?: (s: ScannerState) => void;
  frameText?: string;
  /** a code was just found: the frame goes solid yellow */
  hit?: boolean;
  /** the matched-item card laid over the bottom of the viewfinder */
  overlay?: ReactNode;
  className?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<ScannerState>(active ? "starting" : "off");
  const [torch, setTorch] = useState<{ can: boolean; on: boolean }>({ can: false, on: false });
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;
  const onStateRef = useRef(onState);
  onStateRef.current = onState;

  useEffect(() => {
    onStateRef.current?.(state);
  }, [state]);

  useEffect(() => {
    if (!active) {
      setState("off");
      return;
    }
    const Ctor = detectorCtor();
    if (!Ctor || typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setState("unsupported");
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastCode = "";
    let lastAt = 0;
    const detector = new Ctor({ formats: FORMATS });

    async function start() {
      setState("starting");
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      } catch (e) {
        if (!alive) return;
        const name = (e as { name?: string } | null)?.name ?? "";
        setState(name === "NotAllowedError" || name === "SecurityError" ? "denied" : name === "NotFoundError" || name === "OverconstrainedError" ? "no-camera" : "error");
        return;
      }
      if (!alive) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        try {
          await video.play();
        } catch {
          /* autoplay refused: the frame stays dark, the sentence below says what to do */
        }
      }
      const track = stream.getVideoTracks()[0];
      const caps = (track?.getCapabilities?.() ?? {}) as { torch?: boolean };
      setTorch({ can: Boolean(caps.torch), on: false });
      setState("scanning");
      const tick = async () => {
        if (!alive) return;
        const v = videoRef.current;
        if (v && v.readyState >= 2 && document.visibilityState === "visible") {
          try {
            const found = await detector.detect(v);
            const raw = found.find((b) => b.rawValue)?.rawValue;
            if (raw && alive) {
              const now = Date.now();
              if (raw !== lastCode || now - lastAt > SAME_CODE_QUIET_MS) {
                lastCode = raw;
                lastAt = now;
                onCodeRef.current(raw);
              }
            }
          } catch {
            /* a frame the detector couldn't read: try the next */
          }
        }
        if (alive) timer = setTimeout(() => void tick(), SCAN_EVERY_MS);
      };
      void tick();
    }
    void start();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [active]);

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torch.on;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorch((t) => ({ ...t, on: next }));
    } catch {
      setTorch({ can: false, on: false });
    }
  }

  const running = state === "scanning" || state === "starting";
  return (
    <div className={cn("relative flex min-h-[220px] flex-1 flex-col items-center justify-center overflow-hidden rounded-2xl bg-accent-ink", className)} data-testid="stock-live-scanner" data-state={state}>
      <video ref={videoRef} playsInline muted autoPlay className={cn("absolute inset-0 h-full w-full object-cover", running ? "opacity-100" : "opacity-0")} aria-hidden="true" />
      {running ? (
        <div
          className={cn("relative flex h-[120px] w-[240px] items-center justify-center rounded-xl p-3 text-center text-sm font-medium text-[#dfe6ee]", hit ? "border-[3px] border-accent-yellow bg-accent-yellow/10" : "border-2 border-dashed border-white/60")}
          aria-hidden="true"
        >
          {hit ? null : frameText}
        </div>
      ) : (
        <div className="relative max-w-[300px] px-4 text-center">
          <ScanLine aria-hidden="true" className="mx-auto mb-2 h-7 w-7 text-[#dfe6ee]" />
          <p className="text-sm font-medium leading-snug text-[#eef2f7]" role="status">
            {state === "off" ? "Camera paused." : SCANNER_COPY[state as keyof typeof SCANNER_COPY]}
          </p>
        </div>
      )}
      {torch.can && running ? (
        <button type="button" onClick={() => void toggleTorch()} aria-pressed={torch.on} className="absolute right-2.5 top-2.5 inline-flex min-h-[44px] items-center gap-1.5 rounded-[10px] border border-white/40 bg-white/15 px-3 text-sm font-semibold text-white">
          <Flashlight aria-hidden="true" className="h-4 w-4" />
          Light
        </button>
      ) : null}
      {overlay ? (
        <div className="absolute inset-x-2.5 bottom-2.5">{overlay}</div>
      ) : running ? (
        <p className="absolute inset-x-3 bottom-3 flex items-center gap-2 rounded-xl bg-brand-navy/85 px-3 py-2.5 text-sm font-medium leading-snug text-[#eef2f7]" role="status">
          <ScanLine aria-hidden="true" className="h-4 w-4 shrink-0" />
          {state === "starting" ? "Starting the camera…" : "Looking for a code — no need to press anything"}
        </p>
      ) : null}
    </div>
  );
}
