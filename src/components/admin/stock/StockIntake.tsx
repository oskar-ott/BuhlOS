"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, Lock, Maximize, Minimize, Pause, Play, RotateCcw, ScanBarcode, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { cleanBarcode, findByBarcode } from "@/domains/workshop-stock/barcode";
import { readIntakeCrop } from "@/domains/workshop-stock/client";
import { decideRead } from "@/domains/workshop-stock/flow";
import { errorCopy, formatNumber, READ_STATUS_COPY, signedQuantity } from "@/domains/workshop-stock/format";
import { sessionTotals } from "@/domains/workshop-stock/intake";
import { absorbLight, barcodeNear, cropRect, emptyTracker, findObjects, stepTracker, type Box, type RawFrame, type Track, type TrackerState } from "@/domains/workshop-stock/intake-tracker";
import { matrixLocations } from "@/domains/workshop-stock/location-matrix";
import type { ReadPhotoResult, ReadProduct, StockUnit } from "@/domains/workshop-stock/schema";
import { Block } from "./StockAdminForms";
import { LoggedRow, NeedsYouCard, type Placed } from "./IntakeCards";
import { drawOverlay, readOverlayColours, unlockSound, type OverlayTag } from "./intake-overlay";
import { blankPlaced, NEEDS_YOU, useScanSafeShortcuts, useStatusCues, useStockSession } from "./useStockSession";

/**
 * /stock/intake — the camera table. A webcam looks down at a table; each object
 * put under it gets a red box, is identified, logged, given its location and
 * turns green. Everything live runs in this browser (docs/workshop-stock.md):
 *
 *   object spotted (intake-tracker.ts, against a picture of the empty table)
 *     → a barcode in its crop, read here, matched against the list here
 *     → otherwise that one crop goes to the label reader on the server
 *     → an exact code match logs by itself; anything less stays red and asks.
 *
 * Words alone never log (two GPOs look alike): only a barcode or a code does, or
 * the office's own pick. Every placement is its own movement with its own
 * idempotency key, so it can be undone or re-amounted on its own.
 */

type CameraState = "starting" | "live" | "denied" | "none" | "error" | "unsupported";

const CAMERA_COPY: Record<Exclude<CameraState, "starting" | "live">, string> = {
  denied: "The browser has the camera turned off for BuhlOS. Allow it in the address bar, then reload.",
  none: "No camera found. Plug in the webcam, then reload.",
  error: "The camera didn't start. Another app may be using it. Close that, then reload.",
  unsupported: "This browser can't use a camera. Open this page in Chrome.",
};

const ANALYSE_EVERY_MS = 150;
const ANALYSIS_WIDTH = 320;
const CAMERA_CHANGED_SHARE = 0.5;
const CROP_LONG_SIDE_MAX = 1600;
const CROP_LONG_SIDE_MIN = 800;
const THUMB_LONG_SIDE = 240;
const READS_AT_ONCE = 2;
const ROWS_SHOWN = 30;
const CALIBRATION_FRAMES = 8;
const FULL_HD_WIDTH = 1920;
const SOUND_KEY = "buhlos.stock.intake.sound";
const NOTE = "Camera table";
const REASON_UNDO = "Logged by mistake at the camera table";
const REASON_AMOUNT = "Amount corrected at the camera table";
const CAMERA_KEY = "buhlos.stock.intake.camera";
const BUILT_IN_CAMERA = /facetime|built-?in|macbook|integrated/i;

interface DetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string; boundingBox?: { x: number; y: number; width: number; height: number } }>>;
}
type DetectorCtor = new (opts?: { formats?: string[] }) => DetectorLike;

function makeDetector(): DetectorLike | null {
  const Ctor = (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
  if (typeof Ctor !== "function") return null;
  try {
    return new Ctor({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "itf"] });
  } catch {
    return null;
  }
}

/** How much of the smaller box the two share (0–1). */
function overlapShare(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.min(a.w * a.h, b.w * b.h);
}

/** label reads waiting at most (two run at once) — beyond this an object asks the person */
const MAX_QUEUED_READS = 8;

function rememberedCamera(): string | null {
  try {
    return window.localStorage.getItem(CAMERA_KEY);
  } catch {
    return null;
  }
}

function rememberCamera(id: string) {
  try {
    window.localStorage.setItem(CAMERA_KEY, id);
  } catch {
    /* only a convenience */
  }
}

function amountText(p: Placed): string {
  if (p.amountMilli === null || !p.unit) return "";
  return p.unit === "each" ? `+${formatNumber(p.amountMilli)}` : signedQuantity(p.amountMilli, p.unit);
}

/** What the reticle on an object says. It only ever repeats what the save and the read say. */
function describeTrack(track: Track, placed: Placed | undefined): OverlayTag {
  if (track.touching) return { tone: "touching", title: "MOVE APART", detail: null };
  if (!track.settled) return { tone: "settling", title: null, detail: null };
  if (!placed) return { tone: "reading", title: "READING", detail: null };
  switch (placed.status) {
    case "reading": return { tone: "reading", title: "READING", detail: null };
    case "saving": return { tone: "reading", title: "LOGGING", detail: null };
    case "logged": return { tone: "logged", title: `✓ ${amountText(placed)} ${placed.itemName ?? ""}`.trim(), detail: placed.location ?? "NO LOCATION" };
    case "pick": return { tone: "needs", title: "! WHICH ITEM?", detail: null };
    case "several": return { tone: "needs", title: "! WHICH PRODUCT?", detail: null };
    case "new": return { tone: "needs", title: "! NEW ITEM", detail: null };
    case "amount": return { tone: "needs", title: "! HOW MUCH?", detail: null };
    case "problem": return { tone: "needs", title: "! NEEDS YOU", detail: null };
    default: return { tone: "hidden", title: null, detail: null };
  }
}

function Readout({ label, value, tone, testId }: { label: string; value: string; tone?: "warn"; testId?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="console-label">{label}</span>
      <span className={cn("font-mono text-[13px] font-semibold uppercase tabular-nums", tone === "warn" ? "text-state-warning" : "text-text")} data-testid={testId}>{value}</span>
    </span>
  );
}

function Key({ children }: { children: string }) {
  return <kbd className="rounded-[3px] border border-border-strong bg-surface px-1.5 py-0.5 font-mono text-xs font-semibold text-text">{children}</kbd>;
}

export function StockIntake() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [camera, setCamera] = useState<CameraState>("starting");
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [tableChanged, setTableChanged] = useState(false);
  const session = useStockSession({ note: NOTE, undoReason: REASON_UNDO, amountReason: REASON_AMOUNT });
  const { placed, items, matrix, matrixAvailable, loadError, typesEnabled, load, placedRef, itemsRef, setPlaced, patch, placedById, fullItem, logTo, pickItem, createFromDraft, setLocation, changeAmount, undoPlaced } = session;
  const [lock, setLockState] = useState<{ itemId: string; name: string; unit: StockUnit; milli: number } | null>(null);
  const [hasDetector, setHasDetector] = useState(true);
  const [showAllRows, setShowAllRows] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [full, setFull] = useState(false);
  const [sound, setSound] = useState(true);
  const [telemetry, setTelemetry] = useState<{ fps: number; onTable: number } | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const calibration = useRef<{ sum: Float32Array | null; frames: number } | null>(null);
  const memory = useRef(new Map<number, { x: number; y: number; w: number; h: number; loggedAt: number | null }>());
  const lockRef = useRef(lock);
  lockRef.current = lock;
  const runningRef = useRef(false);
  runningRef.current = running;
  const backgroundRef = useRef<Uint8ClampedArray | null>(null);
  const frameRef = useRef<RawFrame | null>(null);
  const trackerRef = useRef<TrackerState>(emptyTracker());
  const detectorRef = useRef<DetectorLike | null>(null);
  const readQueue = useRef<Array<() => Promise<void>>>([]);
  const readsActive = useRef(0);

  useEffect(() => {
    detectorRef.current = makeDetector();
    setHasDetector(Boolean(detectorRef.current));
    setDeviceId(rememberedCamera());
    try {
      setSound(window.localStorage.getItem(SOUND_KEY) !== "off");
    } catch {
      /* only a convenience */
    }
  }, []);

  // ── the camera ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamera("unsupported");
      return;
    }
    let alive = true;
    let stream: MediaStream | null = null;
    const video = videoRef.current;
    async function start() {
      setCamera("starting");
      const dims = { width: { ideal: 3840 }, height: { ideal: 2160 } };
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId }, ...dims } : dims, audio: false });
      } catch (e) {
        if (!alive) return;
        const name = (e as { name?: string } | null)?.name ?? "";
        if (deviceId && (name === "NotFoundError" || name === "OverconstrainedError")) {
          setDeviceId(null); // the remembered webcam isn't plugged in: use whichever is
          return;
        }
        setCamera(name === "NotAllowedError" || name === "SecurityError" ? "denied" : name === "NotFoundError" || name === "OverconstrainedError" ? "none" : "error");
        return;
      }
      if (!alive) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      if (video) {
        video.srcObject = stream;
        try {
          await video.play();
        } catch {
          /* autoplay refused: the frame stays dark and Start stays off */
        }
      }
      const found = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
      if (!alive) return;
      setDevices(found);
      setCamera("live");
      const settings = stream.getVideoTracks()[0]?.getSettings();
      setSize(settings?.width && settings.height ? { w: settings.width, h: settings.height } : null);
      // A MacBook starts on its own camera; the one above the table is the other one.
      if (!deviceId) {
        const current = settings?.deviceId;
        const webcam = found.find((d) => d.deviceId !== current && d.label && !BUILT_IN_CAMERA.test(d.label));
        const currentIsBuiltIn = BUILT_IN_CAMERA.test(found.find((d) => d.deviceId === current)?.label ?? "");
        if (webcam && currentIsBuiltIn) setDeviceId(webcam.deviceId);
      }
    }
    void start();
    return () => {
      alive = false;
      stream?.getTracks().forEach((t) => t.stop());
      if (video) video.srcObject = null;
    };
  }, [deviceId]);

  // ── identifying ─────────────────────────────────────────────────────────────

  function pumpReads() {
    while (readsActive.current < READS_AT_ONCE && readQueue.current.length) {
      const task = readQueue.current.shift()!;
      readsActive.current += 1;
      void task().finally(() => {
        readsActive.current -= 1;
        pumpReads();
      });
    }
  }

  async function applyRead(id: number, result: ReadPhotoResult, chosen: number | null) {
    const outcome = decideRead(result, chosen);
    const barcode = placedById(id)?.barcode ?? null;
    switch (outcome.kind) {
      case "status":
        if (barcode) patch(id, { status: "new", product: null, problem: null });
        else patch(id, { status: "problem", problem: `${READ_STATUS_COPY[outcome.status].title}. ${READ_STATUS_COPY[outcome.status].body}` });
        return;
      case "pick-product":
        patch(id, { status: "several", readResult: result });
        return;
      case "exact": {
        const product: ReadProduct | null = result.reading?.products[outcome.productIndex] ?? null;
        patch(id, { product });
        const item = await fullItem(outcome.item.id);
        if (item) await logTo(id, item);
        else patch(id, { status: "problem", problem: "That item isn't in the workshop list any more." });
        return;
      }
      case "candidates":
        patch(id, { status: "pick", product: result.reading?.products[outcome.productIndex] ?? null, choices: outcome.candidates.map((c) => c.item) });
        return;
      case "none":
        patch(id, { status: "new", product: result.reading?.products[outcome.productIndex] ?? null });
        return;
    }
  }

  function queueRead(id: number, crop: string) {
    // A spending guard (2026-11-03: a flickering table queued 120 label reads):
    // past MAX_QUEUED_READS waiting, an object asks the person instead of the reader.
    if (readQueue.current.length >= MAX_QUEUED_READS) {
      patch(id, { status: "problem", problem: "Lots on the table at once, so this one wasn't read. Read it again when the others are done, or scan its barcode." });
      return;
    }
    readQueue.current.push(async () => {
      const r = await readIntakeCrop(crop);
      if (!r.ok) {
        patch(id, { status: "problem", problem: errorCopy(r.error.status, r.error.body, "The label reader didn't answer. Try again.") });
        return;
      }
      await applyRead(id, r.data, null);
    });
    pumpReads();
  }

  async function identify(id: number, canvas: HTMLCanvasElement, crop: string, box?: Box) {
    let barcode: string | null = null;
    try {
      const found = await detectorRef.current?.detect(canvas);
      barcode = found?.map((b) => cleanBarcode(b.rawValue)).find(Boolean) ?? null;
    } catch {
      /* a crop the detector couldn't read: the label reader still can */
    }
    // Not in the crop? Look across the whole picture for a barcode on or beside
    // this object (2026-11-03: a box spotted too small cut the barcode off).
    if (!barcode && box) barcode = await barcodeInFrame(box);
    patch(id, { barcode });
    if (barcode) {
      const hits = findByBarcode(itemsRef.current, barcode);
      if (hits.length === 1) {
        await logTo(id, hits[0]!.item);
        return;
      }
      if (hits.length > 1) {
        patch(id, { status: "pick", choices: hits.map((h) => h.item) });
        return;
      }
    }
    queueRead(id, crop);
  }

  async function barcodeInFrame(box: Box): Promise<string | null> {
    const video = videoRef.current;
    const detector = detectorRef.current;
    if (!video || !video.videoWidth || !detector) return null;
    try {
      const full = document.createElement("canvas");
      full.width = video.videoWidth;
      full.height = video.videoHeight;
      full.getContext("2d")?.drawImage(video, 0, 0);
      const found = await detector.detect(full);
      const W = video.videoWidth;
      const H = video.videoHeight;
      const codes = found
        .map((b) => ({ value: cleanBarcode(b.rawValue), bb: b.boundingBox }))
        .filter((b): b is { value: string; bb: { x: number; y: number; width: number; height: number } } => Boolean(b.value && b.bb))
        .map((b) => ({ value: b.value, box: { x: b.bb.x / W, y: b.bb.y / H, w: b.bb.width / W, h: b.bb.height / H } }));
      return barcodeNear(box, codes);
    } catch {
      return null;
    }
  }

  function grabCrop(box: Box): { canvas: HTMLCanvasElement; crop: string; thumb: string | null } | null {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return null;
    const rect = cropRect(box, video.videoWidth, video.videoHeight);
    const long = Math.max(rect.w, rect.h);
    const scale = long > CROP_LONG_SIDE_MAX ? CROP_LONG_SIDE_MAX / long : long < CROP_LONG_SIDE_MIN ? Math.min(3, CROP_LONG_SIDE_MIN / long) : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(rect.w * scale);
    canvas.height = Math.round(rect.h * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(video, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height);
    const thumbCanvas = document.createElement("canvas");
    const thumbScale = Math.min(1, THUMB_LONG_SIDE / Math.max(canvas.width, canvas.height));
    thumbCanvas.width = Math.max(8, Math.round(canvas.width * thumbScale));
    thumbCanvas.height = Math.max(8, Math.round(canvas.height * thumbScale));
    thumbCanvas.getContext("2d")?.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
    return { canvas, crop: canvas.toDataURL("image/jpeg", 0.85), thumb: thumbCanvas.toDataURL("image/jpeg", 0.7) };
  }

  function onSettled(track: Track) {
    // Never twice for the same thing: if a row is still on the table right
    // here (mostly overlapping), this is that object seen again, not a new one.
    const again = placedRef.current.find((p) => p.onTable && p.box.w > 0 && overlapShare(p.box, track.box) >= 0.5);
    if (again) return;
    const grabbed = grabCrop(track.box);
    if (!grabbed) return;
    const held = lockRef.current;
    setPlaced((prev) => [blankPlaced({ id: track.id, box: track.box, onTable: true, crop: grabbed.crop, thumb: grabbed.thumb, status: held ? "saving" : "reading" }), ...prev]);
    if (held) {
      void fullItem(held.itemId).then((item) => {
        if (item) void logTo(track.id, item, held.milli);
        else patch(track.id, { status: "problem", problem: "That item isn't in the workshop list any more." });
      });
      return;
    }
    void identify(track.id, grabbed.canvas, grabbed.crop, track.box);
  }
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  // A USB barcode scanner at the table (owner, 2026-11-03: "its a usb scanner
  // only used on desktop"): each scan is one placement, no camera needed, and it
  // works with the camera stopped too. The scanner display (/stock/scan) is the
  // same session without the camera.

  function readAgain(id: number) {
    const p = placedById(id);
    if (!p) return;
    const track = trackerRef.current.tracks.find((t) => t.id === id);
    const grabbed = track ? grabCrop(track.box) : null;
    const crop = grabbed?.crop ?? p.crop;
    patch(id, { status: "reading", problem: null, crop, thumb: grabbed?.thumb ?? p.thumb, moveKey: null });
    if (grabbed && track) void identify(id, grabbed.canvas, grabbed.crop, track.box);
    else queueRead(id, crop);
  }

  async function retry(id: number) {
    const p = placedById(id);
    if (!p) return;
    if (!p.itemId) {
      readAgain(id);
      return;
    }
    const item = await fullItem(p.itemId);
    if (item) await logTo(id, item, p.retryMilli ?? p.amountMilli);
  }

  // ── the live loop ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (camera !== "live") return;
    const small = document.createElement("canvas");
    const smallCtx = small.getContext("2d", { willReadFrequently: true });
    let ticks = 0;
    let since = Date.now();
    const timer = setInterval(() => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || !video.videoWidth || !smallCtx) return;
      small.width = ANALYSIS_WIDTH;
      small.height = Math.round((ANALYSIS_WIDTH * video.videoHeight) / video.videoWidth);
      smallCtx.drawImage(video, 0, 0, small.width, small.height);
      const image = smallCtx.getImageData(0, 0, small.width, small.height);
      frameRef.current = image;
      ticks += 1;
      if (Date.now() - since >= 600) {
        setTelemetry({ fps: (ticks * 1000) / (Date.now() - since), onTable: trackerRef.current.tracks.filter((t) => t.settled).length });
        ticks = 0;
        since = Date.now();
      }

      // The empty table: several frames averaged, so sensor noise isn't taken for an object.
      const reading = calibration.current;
      if (reading) {
        const sum = reading.sum && reading.sum.length === image.data.length ? reading.sum : new Float32Array(image.data.length);
        for (let i = 0; i < sum.length; i++) sum[i] = sum[i]! + image.data[i]!;
        reading.sum = sum;
        reading.frames += 1;
        if (reading.frames >= CALIBRATION_FRAMES) {
          const background = new Uint8ClampedArray(sum.length);
          for (let i = 0; i < sum.length; i++) background[i] = sum[i]! / reading.frames;
          backgroundRef.current = background;
          calibration.current = null;
          setCalibrating(false);
          setRunning(true);
        }
        return;
      }

      const background = backgroundRef.current;
      if (runningRef.current && background && background.length === image.data.length) {
        const found = findObjects(image, background);
        const changed = found.changedShare > CAMERA_CHANGED_SHARE;
        setTableChanged(changed);
        if (!changed) {
          const step = stepTracker(trackerRef.current, found, Date.now());
          trackerRef.current = step.state;
          step.settled.forEach((t) => onSettledRef.current(t));
          if (step.gone.length) {
            const ids = new Set(step.gone.map((t) => t.id));
            setPlaced((prev) => prev.map((p) => (ids.has(p.id) ? { ...p, onTable: false } : p)));
          }
          absorbLight(background, image);
        }
      }
    }, ANALYSE_EVERY_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the loop reads everything through refs
  }, [camera]);

  // The overlay runs at the screen's rate, apart from the slower analysis under it.
  useEffect(() => {
    if (camera !== "live") return;
    const canvas = overlayRef.current;
    if (!canvas) return;
    const colours = readOverlayColours(canvas);
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let raf = 0;
    const frame = () => {
      const video = videoRef.current;
      if (video) {
        const reading = calibration.current;
        drawOverlay({
          canvas,
          video,
          tracks: trackerRef.current.tracks,
          describe: (track) => describeTrack(track, placedRef.current.find((p) => p.id === track.id)),
          memory: memory.current,
          colours,
          now: Date.now(),
          running: runningRef.current,
          calibrating: reading ? Math.min(1, reading.frames / CALIBRATION_FRAMES) : null,
          reducedMotion,
        });
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [camera, placedRef]);

  useStatusCues(placed, sound);

  function startTable() {
    if (!frameRef.current) return;
    unlockSound();
    trackerRef.current = emptyTracker();
    memory.current.clear();
    setPlaced((prev) => prev.map((p) => ({ ...p, onTable: false })));
    // ids restart with the tracker: keep this session's rows apart from the new ones
    trackerRef.current.nextId = placedRef.current.reduce((n, p) => Math.max(n, p.id), 0) + 1;
    calibration.current = { sum: null, frames: 0 };
    setTableChanged(false);
    setPaused(false);
    setRunning(false);
    setCalibrating(true);
  }

  function pauseTable() {
    setRunning(false);
    setPaused(true);
  }

  function resumeTable() {
    unlockSound();
    setPaused(false);
    setRunning(true);
  }

  function toggleSound() {
    const next = !sound;
    if (next) unlockSound();
    setSound(next);
    try {
      window.localStorage.setItem(SOUND_KEY, next ? "on" : "off");
    } catch {
      /* only a convenience */
    }
  }

  function toggleFull() {
    const next = !full;
    setFull(next);
    if (next) void rootRef.current?.requestFullscreen?.().catch(() => undefined);
    else if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  }

  useEffect(() => {
    const onChange = () => { if (!document.fullscreenElement) setFull(false); };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  function onShortcut(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target as HTMLElement | null)?.tagName ?? "";
    if (["INPUT", "SELECT", "TEXTAREA"].includes(tag)) return;
    const key = e.key.toLowerCase();
    if (key === " ") {
      if (["BUTTON", "SUMMARY", "A"].includes(tag)) return; // Space presses whatever has focus
      if (running) pauseTable();
      else if (paused) resumeTable();
      else return;
      e.preventDefault();
    } else if (key === "u") {
      session.undoLast();
    } else if (key === "f") {
      toggleFull();
    } else if (key === "m") {
      toggleSound();
    }
  }
  useScanSafeShortcuts(onShortcut);

  // ── the screen ──────────────────────────────────────────────────────────────

  const waiting = useMemo(() => placed.filter((p) => NEEDS_YOU.has(p.status)), [placed]);
  const working = useMemo(() => placed.filter((p) => p.status === "reading" || p.status === "saving").length, [placed]);
  const logged = useMemo(() => placed.filter((p) => p.status === "logged"), [placed]);
  const totals = useMemo(() => sessionTotals(placed), [placed]);
  const shownRows = useMemo(() => placed.filter((p) => p.status === "logged" || p.status === "undone"), [placed]);
  const locations = useMemo(() => matrixLocations(matrix), [matrix]);
  const ready = camera === "live" && !loadError;
  const last = logged[0] ?? null;
  const status = camera !== "live" ? (camera === "starting" ? "Starting" : "No camera") : calibrating ? "Reading table" : running ? "Live" : paused ? "Paused" : "Ready";

  return (
    <div ref={rootRef} data-theme="console" className={cn("flex flex-col gap-2 bg-surface-subtle p-2 text-text", full ? "fixed inset-0 z-[60] h-screen" : "rounded-[6px] lg:h-[calc(100vh-150px)] lg:min-h-[640px]")} data-testid="stock-intake">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-[4px] border border-border bg-surface px-3 py-1.5">
        <span className="inline-flex items-center gap-2 font-mono text-[13px] font-bold uppercase tracking-[0.1em] text-text" data-testid="stock-intake-status">
          <span aria-hidden="true" className={cn("h-2.5 w-2.5 rounded-full", running ? "console-live bg-state-success" : calibrating ? "console-live bg-accent-yellow" : camera === "live" ? "bg-text-muted" : "bg-state-danger")} />
          {status}
        </span>
        {size ? <Readout label="Cam" value={`${size.w}×${size.h}${size.w < FULL_HD_WIDTH ? " · low res" : ""}`} tone={size.w < FULL_HD_WIDTH ? "warn" : undefined} /> : null}
        {telemetry ? <Readout label="Rate" value={`${telemetry.fps.toFixed(1)}/s`} /> : null}
        {telemetry ? <Readout label="On table" value={String(telemetry.onTable)} testId="stock-intake-on-table" /> : null}
        <Readout label="Barcodes" value={hasDetector ? "On" : "Off"} tone={hasDetector ? undefined : "warn"} />
        {matrix ? <Readout label="Bin rules" value={String(matrix.rules.length)} tone={matrix.rules.length ? undefined : "warn"} /> : null}
        <span className="flex-1" />
        {devices.length > 1 ? (
          <label className="flex items-center gap-2">
            <span className="console-label">Camera</span>
            <select
              value={deviceId ?? ""}
              onChange={(e) => { setDeviceId(e.target.value || null); rememberCamera(e.target.value); backgroundRef.current = null; setRunning(false); setPaused(false); }}
              className="h-8 max-w-[220px] rounded-[4px] border border-border-strong bg-surface-subtle px-2 text-sm text-text"
              data-testid="stock-intake-camera"
            >
              {!deviceId ? <option value="">Choose…</option> : null}
              {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>)}
            </select>
          </label>
        ) : null}
        <div className="flex items-center gap-1">
          {running ? <Button type="button" variant="secondary" size="sm" onClick={pauseTable} data-testid="stock-intake-pause"><Pause aria-hidden="true" className="h-4 w-4" /> Pause</Button> : null}
          {running || paused ? <Button type="button" variant="secondary" size="sm" onClick={startTable} data-testid="stock-intake-reset"><RotateCcw aria-hidden="true" className="h-4 w-4" /> Reset table</Button> : null}
          <button type="button" onClick={toggleSound} aria-pressed={sound} aria-label={sound ? "Turn sound off" : "Turn sound on"} title={sound ? "Sound on" : "Sound off"} className="inline-flex h-8 w-8 items-center justify-center rounded-[4px] text-text-muted hover:bg-surface-raised hover:text-text" data-testid="stock-intake-sound">
            {sound ? <Volume2 aria-hidden="true" className="h-4 w-4" /> : <VolumeX aria-hidden="true" className="h-4 w-4" />}
          </button>
          <button type="button" onClick={toggleFull} aria-pressed={full} aria-label={full ? "Leave full screen" : "Full screen"} title={full ? "Leave full screen" : "Full screen"} className="inline-flex h-8 w-8 items-center justify-center rounded-[4px] text-text-muted hover:bg-surface-raised hover:text-text" data-testid="stock-intake-full">
            {full ? <Minimize aria-hidden="true" className="h-4 w-4" /> : <Maximize aria-hidden="true" className="h-4 w-4" />}
          </button>
        </div>
      </header>

      {lock ? (
        <div className="flex items-center gap-2 rounded-[4px] border border-accent-yellow bg-surface px-3 py-1.5 text-sm font-medium text-text" role="status" data-testid="stock-intake-lock">
          <Lock aria-hidden="true" className="h-4 w-4 shrink-0 text-accent-yellow" />
          <span className="min-w-0 flex-1">Everything placed now logs as {signedQuantity(lock.milli, lock.unit)} {lock.name}, without reading it.</span>
          <Button type="button" variant="secondary" size="sm" onClick={() => setLockState(null)}>Stop</Button>
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 gap-2 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-h-0 min-w-0 flex-col gap-2">
          <div className="relative aspect-video w-full overflow-hidden rounded-[4px] border border-border bg-surface-subtle lg:aspect-auto lg:min-h-0 lg:flex-1" data-testid="stock-intake-feed" data-camera={camera} data-running={running}>
            <video ref={videoRef} playsInline muted autoPlay aria-hidden="true" className="absolute inset-0 h-full w-full object-contain" />
            <canvas ref={overlayRef} aria-hidden="true" className="absolute inset-0 h-full w-full font-mono" />
            {camera !== "live" ? (
              <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
                <p className="max-w-sm text-sm font-medium text-text" role="status">
                  <Camera aria-hidden="true" className="mx-auto mb-2 h-7 w-7 text-text-muted" />
                  {camera === "starting" ? "Starting the camera…" : CAMERA_COPY[camera]}
                </p>
              </div>
            ) : calibrating ? (
              <p className="absolute bottom-3 left-3 rounded-[4px] bg-surface px-3 py-1.5 font-mono text-sm font-semibold text-text" role="status">Reading the empty table. Keep it clear…</p>
            ) : paused ? (
              <div className="console-scrim absolute inset-0 flex items-center justify-center p-6 text-center">
                <div className="max-w-sm">
                  <p className="font-display text-xl font-semibold text-text">Paused</p>
                  <p className="mt-1 text-sm text-text-muted">Nothing placed now is counted. Anything moved while paused may count again.</p>
                  <Button type="button" size="md" className="mt-3" onClick={resumeTable} data-testid="stock-intake-resume"><Play aria-hidden="true" className="h-4 w-4" /> Carry on</Button>
                </div>
              </div>
            ) : !running ? (
              <div className="console-scrim absolute inset-0 flex items-center justify-center p-6 text-center">
                <div className="max-w-md">
                  <p className="font-display text-2xl font-semibold text-text">Clear the table, then start</p>
                  <p className="mt-1.5 text-sm text-text-muted">It reads the empty table first and spots anything new against it. A plain mat that contrasts with your stock works best.</p>
                  <Button type="button" size="lg" className="mt-4" disabled={!ready || !matrixAvailable} onClick={startTable} data-testid="stock-intake-start"><Play aria-hidden="true" className="h-4 w-4" /> Start</Button>
                </div>
              </div>
            ) : tableChanged ? (
              <p className="absolute inset-x-3 top-3 rounded-[4px] bg-state-danger px-3 py-2 text-sm font-semibold text-text-inverse" role="alert">
                Most of the picture has changed, so counting has stopped. If the camera moved, clear the table and press Reset table.
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[4px] border border-border bg-surface px-4 py-2.5" data-testid="stock-intake-readout">
            <div className="flex items-baseline gap-2">
              <span className="font-display text-5xl font-semibold leading-none tabular-nums text-state-success" data-testid="stock-intake-logged">{logged.length}</span>
              <span className="console-label">Logged</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="flex items-baseline gap-1.5"><span className={cn("font-mono text-[15px] font-bold tabular-nums", waiting.length ? "text-state-danger" : "text-text-muted")} data-testid="stock-intake-waiting">{waiting.length}</span><span className="console-label">Waiting on you</span></span>
              <span className="flex items-baseline gap-1.5"><span className="font-mono text-[15px] font-bold tabular-nums text-text-muted" data-testid="stock-intake-working">{working}</span><span className="console-label">Working</span></span>
            </div>
            <div key={last?.id ?? "none"} className="console-rise min-w-[200px] flex-1 basis-64">
              <p className="console-label">Goes to</p>
              {last ? (
                <>
                  <p className={cn("truncate font-mono text-2xl font-bold uppercase leading-tight xl:text-3xl", last.location ? "text-accent-yellow" : "text-state-warning")} data-testid="stock-intake-goes-to">{last.location ?? "No location yet"}</p>
                  <p className="truncate text-sm text-text-muted">{amountText(last)} {last.itemName}</p>
                </>
              ) : (
                <p className="font-mono text-2xl font-bold leading-tight text-text-muted" data-testid="stock-intake-goes-to">—</p>
              )}
            </div>
          </div>

          <p className="sr-only" aria-live="polite">{last ? `Logged ${amountText(last)} ${last.itemName ?? ""}. ${last.location ? `Goes to ${last.location}.` : "No location yet."}` : ""}{waiting.length ? ` ${waiting.length} waiting on you.` : ""}</p>

          <div className="hidden flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-text-muted lg:flex">
            <span className="flex items-center gap-1.5"><Key>Space</Key> pause</span>
            <span className="flex items-center gap-1.5"><Key>U</Key> undo last</span>
            <span className="flex items-center gap-1.5"><Key>F</Key> full screen</span>
            <span className="flex items-center gap-1.5"><Key>M</Key> sound</span>
            <span className="flex-1" />
            <span>Keep a small gap between items, labels up, and everything inside the yellow corners.</span>
          </div>
        </div>

        <aside className="min-h-0 min-w-0 space-y-2 overflow-y-auto" aria-label="This session">
          {loadError ? (
            <Block tone="warn" title="Couldn't load what the table needs" role="alert">
              <p>{loadError}</p>
              <Button type="button" variant="secondary" size="sm" className="mt-1" onClick={() => void load()}>Try again</Button>
            </Block>
          ) : null}
          {!matrixAvailable ? (
            <Block tone="warn" title="Needs a database update" role="status" testId="stock-intake-unavailable">
              <p>The camera table needs migration 20261102100000_workshop_stock_location_matrix.sql applied first.</p>
            </Block>
          ) : matrix && !matrix.rules.length ? (
            <Block tone="warn" title="No bin rules yet" role="status">
              <p>Items will log without a location until you set up the <a href="/stock/locations" className="font-semibold underline">location matrix</a>.</p>
            </Block>
          ) : null}
          {!hasDetector ? (
            <p className="flex items-start gap-2 rounded-[4px] border border-border bg-surface p-2.5 text-sm text-text-muted"><ScanBarcode aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" /> This browser can&rsquo;t read barcodes, so every item uses a label read. Chrome reads them instantly, for free.</p>
          ) : null}

          {waiting.map((p) => (
            <NeedsYouCard
              key={p.id}
              placed={p}
              items={items}
              matrix={matrix}
              locations={locations}
              typesEnabled={typesEnabled}
              onPick={(item) => void pickItem(p.id, item)}
              onChooseProduct={(i) => { if (p.readResult) void applyRead(p.id, p.readResult, i); }}
              onCreate={(draft) => void createFromDraft(p.id, draft)}
              onAmount={(milli) => { const item = itemsRef.current.find((x) => x.id === p.itemId); if (item) void logTo(p.id, item, milli); }}
              onRetry={() => void retry(p.id)}
              onReadAgain={p.crop ? () => readAgain(p.id) : undefined}
              onIgnore={() => patch(p.id, { status: "ignored", problem: null })}
            />
          ))}

          {totals.length ? (
            <details className="rounded-[4px] border border-border bg-surface" open data-testid="stock-intake-by-item">
              <summary className="console-label cursor-pointer px-3 py-2">By item · {totals.length}</summary>
              <ul className="divide-y divide-border border-t border-border">
                {totals.map((t) => (
                  <li key={t.itemId} className="flex items-baseline gap-2 px-3 py-1.5 text-sm">
                    <span className="min-w-0 flex-1 truncate text-text">{t.name}</span>
                    <span className={cn("shrink-0 font-mono text-xs", t.location ? "text-text-muted" : "text-state-warning")}>{t.location ?? "No location"}</span>
                    <span className="shrink-0 font-mono font-bold tabular-nums text-state-success">{signedQuantity(t.milli, t.unit)}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {shownRows.length ? (
            <section className="rounded-[4px] border border-border bg-surface" aria-label="Logged this session">
              <p className="console-label px-3 py-2">Log · newest first</p>
              <ul className="divide-y divide-border border-t border-border" data-testid="stock-intake-rows">
                {(showAllRows ? shownRows : shownRows.slice(0, ROWS_SHOWN)).map((p) => (
                  <LoggedRow
                    key={p.id}
                    placed={p}
                    locked={lock?.itemId === p.itemId && lock?.milli === p.amountMilli}
                    locations={locations}
                    onChangeAmount={(milli) => void changeAmount(p.id, milli)}
                    onSetLocation={(text) => void setLocation(p.id, text)}
                    onUndo={() => void undoPlaced(p.id)}
                    onLock={() => { if (p.itemId && p.unit && p.itemName && p.amountMilli !== null) setLockState({ itemId: p.itemId, name: p.itemName, unit: p.unit, milli: p.amountMilli }); }}
                  />
                ))}
              </ul>
              {!showAllRows && shownRows.length > ROWS_SHOWN ? (
                <div className="border-t border-border p-2 text-center">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setShowAllRows(true)}>Show all {shownRows.length}</Button>
                </div>
              ) : null}
            </section>
          ) : null}

          {!placed.length ? (
            <ol className="space-y-3 rounded-[4px] border border-border bg-surface p-3 text-sm text-text-muted" data-testid="stock-intake-howto">
              <li><span className="console-label block text-text">1 · Place it</span> Put an item on the table, label up. A red box locks on.</li>
              <li><span className="console-label block text-text">2 · It reads it</span> A barcode or product code it knows logs by itself and turns green.</li>
              <li><span className="console-label block text-text">3 · Put it away</span> &ldquo;Goes to&rdquo; shows the bin. Anything it isn&rsquo;t sure about stays red and waits here for you.</li>
            </ol>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
