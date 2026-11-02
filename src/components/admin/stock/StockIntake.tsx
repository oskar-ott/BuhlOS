"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, Crop as CropIcon, Download, Lock, Maximize, Minimize, Pause, Play, RotateCcw, ScanBarcode, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { cleanBarcode, findByBarcode } from "@/domains/workshop-stock/barcode";
import { addIdentifier, createItem, editItem, fetchItem, fetchLocationMatrix, fetchStockList, newOperationKey, readIntakeCrop, recordMove, storePhoto, undoMovement } from "@/domains/workshop-stock/client";
import { decideRead } from "@/domains/workshop-stock/flow";
import { errorCopy, formatNumber, parseTypedQuantity, READ_STATUS_COPY, signedQuantity, toQuantityString } from "@/domains/workshop-stock/format";
import { emptyScan, feedScan, identifiersToTeach, itemWords, packNeedsCheck, placedAmount, productWords, sameInARow, sameProduct, sessionTotals, waitingQueue, type NewItemDraft } from "@/domains/workshop-stock/intake";
import { clearSession, loadSession, loadZone, saveSession, saveZone } from "@/domains/workshop-stock/intake-session";
import { addCalibrationFrame, analyseFrame, cropRect, emptyTracker, finishCalibration, newCalibration, sharpness, tableAdvice, type Box, type Calibration, type FoundObjects, type RawFrame, type TableState, type Track } from "@/domains/workshop-stock/intake-tracker";
import { matrixLocations, ruleFor, type LocationMatrix } from "@/domains/workshop-stock/location-matrix";
import type { ReadPhotoResult, ReadProduct, StockItem, StockUnit } from "@/domains/workshop-stock/schema";
import { specsForType } from "@/domains/workshop-stock/types";
import { Block } from "./StockAdminForms";
import { LoggedRow, NeedsYouCard, QueuedCard, type Placed } from "./IntakeCards";
import { drawOverlay, playCue, readOverlayColours, unlockSound, videoArea, type OverlayTag } from "./intake-overlay";

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

type CameraState = "starting" | "live" | "lost" | "denied" | "none" | "error" | "unsupported";

const CAMERA_COPY: Record<Exclude<CameraState, "starting" | "live">, string> = {
  lost: "The camera stopped sending pictures, so nothing is being counted. Reconnecting…",
  denied: "The browser has the camera turned off for BuhlOS. Allow it in the address bar, then reload.",
  none: "No camera found. Plug in the webcam: it starts by itself.",
  error: "The camera didn't start. Another app may be using it. Close that, then reload.",
  unsupported: "This browser can't use a camera. Open this page in Chrome.",
};

const ANALYSE_EVERY_MS = 150;
const ANALYSIS_WIDTH = 320;
const CLIP_LIMIT_MS = 60_000;
const CROP_LONG_SIDE_MAX = 1568;
const CROP_LONG_SIDE_MIN = 800;
const THUMB_LONG_SIDE = 240;
const READS_AT_ONCE = 4;
const SHARPEST_TRIES = 3;
const SHARPEST_GAP_MS = 220;
const READ_RETRY_MS = 1500;
const STALLED_MS = 3000;
const SLOW_RATE = 4;
const LOW_FRAME_RATE = 10;
const MIN_ZONE = 0.15;
const CALIBRATION_ATTEMPTS = 3;
const SAME_RUN = 3;
const SHORTCUT_DELAY_MS = 60;
const NOTICE_MS = 6000;
const ROWS_SHOWN = 30;
const CALIBRATION_FRAMES = 8;
const FULL_HD_WIDTH = 1920;
const NEEDS_YOU = new Set<string>(["pick", "several", "new", "amount", "problem"]);
const SOUND_KEY = "buhlos.stock.intake.sound";
const NOTE = "Camera table";
const REASON_UNDO = "Logged by mistake at the camera table";
const REASON_AMOUNT = "Amount corrected at the camera table";
const CAMERA_KEY = "buhlos.stock.intake.camera";
const BUILT_IN_CAMERA = /facetime|built-?in|macbook|integrated/i;
const UNREADABLE = "Couldn't read a label on this. Turn it label up and it reads again by itself, or search below.";

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function sharpnessOf(canvas: HTMLCanvasElement): number {
  const small = document.createElement("canvas");
  const scale = Math.min(1, 240 / Math.max(canvas.width, canvas.height));
  small.width = Math.max(8, Math.round(canvas.width * scale));
  small.height = Math.max(8, Math.round(canvas.height * scale));
  const ctx = small.getContext("2d", { willReadFrequently: true });
  if (!ctx) return 0;
  ctx.drawImage(canvas, 0, 0, small.width, small.height);
  return sharpness(ctx.getImageData(0, 0, small.width, small.height));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function blankPlaced(id: number, box: Box): Placed {
  return {
    id, at: Date.now(), box, onTable: true, crop: "", thumb: null, status: "reading",
    barcode: null, product: null, readResult: null, choices: [], problem: null, note: null, busy: false, itemId: null, itemName: null, unit: null, location: null,
    amountMilli: null, fromLabel: false, recordedMilli: null, movementId: null, moveKey: null, photoId: null, retryMilli: null, unread: false, askMilli: null,
  };
}

interface DetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
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
  const tag = `#${track.id}`;
  switch (placed.status) {
    case "reading": return { tone: "reading", title: `${tag} READING ${Math.max(0, Math.floor((Date.now() - placed.at) / 1000))}s`, detail: null };
    case "saving": return { tone: "reading", title: `${tag} LOGGING`, detail: null };
    case "logged": return { tone: "logged", title: `✓ ${amountText(placed)} ${placed.itemName ?? ""}`.trim(), detail: placed.location ?? "NO LOCATION" };
    case "pick": return { tone: "needs", title: `${tag} WHICH ITEM?`, detail: null };
    case "several": return { tone: "needs", title: `${tag} WHICH PRODUCT?`, detail: null };
    case "new": return { tone: "needs", title: `${tag} NEW ITEM`, detail: null };
    case "amount": return { tone: "needs", title: `${tag} HOW MUCH?`, detail: null };
    case "problem": return { tone: "needs", title: placed.unread ? `${tag} TURN LABEL UP` : `${tag} NEEDS YOU`, detail: null };
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

function ZoneDraft({ box }: { box: { left: number; top: number; width: number; height: number } }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.left = `${box.left}px`;
    el.style.top = `${box.top}px`;
    el.style.width = `${box.width}px`;
    el.style.height = `${box.height}px`;
  }, [box]);
  return <div ref={ref} aria-hidden="true" className="absolute border-2 border-accent-yellow" />;
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
  const [unsteady, setUnsteady] = useState(false);
  const [recordingClip, setRecordingClip] = useState(false);
  const clipRef = useRef<MediaRecorder | null>(null);
  const [placed, setPlacedState] = useState<Placed[]>([]);
  const [lock, setLockState] = useState<{ itemId: string; name: string; unit: StockUnit; milli: number } | null>(null);
  const [items, setItemsState] = useState<StockItem[]>([]);
  const [matrix, setMatrix] = useState<LocationMatrix | null>(null);
  const [matrixAvailable, setMatrixAvailable] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasDetector, setHasDetector] = useState(true);
  const [showAllRows, setShowAllRows] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [full, setFull] = useState(false);
  const [sound, setSound] = useState(true);
  const [typesEnabled, setTypesEnabled] = useState(false);
  const [telemetry, setTelemetry] = useState<{ fps: number; onTable: number; analysisMs: number } | null>(null);
  const [frameRate, setFrameRate] = useState<number | null>(null);
  const [cameraNonce, setCameraNonce] = useState(0);
  const [exposure, setExposure] = useState<"locked" | "auto" | null>(null);
  const [advice, setAdvice] = useState<string | null>(null);
  const [zone, setZoneState] = useState<Box | null>(null);
  const [drawingZone, setDrawingZone] = useState(false);
  const [zoneDraft, setZoneDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [readerOff, setReaderOff] = useState<"not_configured" | "daily_limit" | null>(null);
  const [reads, setReads] = useState<{ barcodes: number; labels: number; medianMs: number | null }>({ barcodes: 0, labels: 0, medianMs: null });
  const [focusId, setFocusId] = useState<number | null>(null);
  const [nextScan, setNextScan] = useState<{ barcode: string; item: StockItem | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restored, setRestored] = useState(0);
  const [sameDismissed, setSameDismissed] = useState<string | null>(null);
  const [evidence, setEvidence] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const calibration = useRef<Calibration | null>(null);
  const calibrationAttempts = useRef(0);
  const nextTrackerId = useRef(1);
  const tableRef = useRef<TableState | null>(null);
  const zoneRef = useRef<Box | null>(null);
  const armsRef = useRef<FoundObjects["armCells"] | null>(null);
  const atEdgeRef = useRef<Box[]>([]);
  const highlightRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const readTimes = useRef<number[]>([]);
  const confirmedPacks = useRef(new Set<string>());
  const scanRef = useRef(emptyScan());
  const shortcutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextScanRef = useRef(nextScan);
  nextScanRef.current = nextScan;
  const evidenceRef = useRef(false);
  const loadedRef = useRef(false);
  const memory = useRef(new Map<number, { x: number; y: number; w: number; h: number; loggedAt: number | null }>());
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const seenStatus = useRef(new Map<number, string>());
  const placedRef = useRef<Placed[]>([]);
  const itemsRef = useRef<StockItem[]>([]);
  const matrixRef = useRef<LocationMatrix | null>(null);
  const lockRef = useRef(lock);
  lockRef.current = lock;
  const runningRef = useRef(false);
  runningRef.current = running;
  const frameRef = useRef<RawFrame | null>(null);
  const detectorRef = useRef<DetectorLike | null>(null);
  const readQueue = useRef<Array<() => Promise<void>>>([]);
  const readsActive = useRef(0);
  const assigning = useRef(new Set<string>());

  const setPlaced = useCallback((update: (prev: Placed[]) => Placed[]) => {
    placedRef.current = update(placedRef.current);
    setPlacedState(placedRef.current);
  }, []);
  const patch = useCallback((id: number, change: Partial<Placed>) => {
    setPlaced((prev) => prev.map((p) => (p.id === id ? { ...p, ...change } : p)));
  }, [setPlaced]);
  const placedById = (id: number) => placedRef.current.find((p) => p.id === id);
  const mergeItem = useCallback((incoming: StockItem): StockItem => {
    const known = itemsRef.current.find((i) => i.id === incoming.id);
    // Saves overlap in a burst: an answer from before a location was set mustn't take it away again.
    const item = known && known.metaRevision > incoming.metaRevision ? { ...incoming, location: known.location, metaRevision: known.metaRevision } : incoming;
    itemsRef.current = known ? itemsRef.current.map((i) => (i.id === item.id ? item : i)) : [...itemsRef.current, item];
    setItemsState(itemsRef.current);
    return item;
  }, []);
  const say = useCallback((text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((now) => (now === text ? null : now)), NOTICE_MS);
  }, []);

  // ── what's on the list, and where things go ─────────────────────────────────

  const load = useCallback(async () => {
    setLoadError(null);
    const [list, locations] = await Promise.all([fetchStockList(), fetchLocationMatrix()]);
    if (!list.ok) {
      setLoadError(errorCopy(list.error.status, list.error.body, "The server didn't answer, so nothing can be matched yet."));
      return;
    }
    itemsRef.current = list.data.items;
    setItemsState(list.data.items);
    setTypesEnabled(list.data.capabilities.types === true);
    setReaderOff((now) => (list.data.capabilities.photoRead === false ? "not_configured" : now));
    if (!locations.ok) {
      // Starting without it would log everything with no location and no warning.
      setLoadError(errorCopy(locations.error.status, locations.error.body, "The location matrix didn't load, so items couldn't be given a location."));
      return;
    }
    setMatrixAvailable(locations.data.available);
    matrixRef.current = locations.data.matrix;
    setMatrix(locations.data.matrix);
    loadedRef.current = true;
    setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    detectorRef.current = makeDetector();
    setHasDetector(Boolean(detectorRef.current));
    setDeviceId(rememberedCamera());
    const wanted = new URLSearchParams(window.location.search).has("evidence");
    evidenceRef.current = wanted;
    setEvidence(wanted);
    const rows = loadSession();
    if (rows.length) {
      for (const r of rows) seenStatus.current.set(r.id, r.status);
      placedRef.current = rows.map((r) => ({ ...blankPlaced(r.id, { x: 0, y: 0, w: 0, h: 0 }), ...r, onTable: false }));
      setPlacedState(placedRef.current);
      setRestored(rows.filter((r) => r.status === "logged").length);
    }
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
      const dims = { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } };
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
      streamRef.current = stream;
      stream.getVideoTracks()[0]?.addEventListener("ended", () => { if (alive) onLostRef.current(); });
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
      setFrameRate(settings?.frameRate ?? null);
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
      streamRef.current = null;
      stream?.getTracks().forEach((t) => t.stop());
      if (video) video.srcObject = null;
    };
  }, [deviceId, cameraNonce]);

  // A webcam plugged in, or back after being knocked out, starts by itself.
  useEffect(() => {
    const onChange = () => setCamera((now) => {
      if (now === "none" || now === "lost" || now === "error") setCameraNonce((n) => n + 1);
      return now;
    });
    navigator.mediaDevices?.addEventListener?.("devicechange", onChange);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", onChange);
  }, []);

  useEffect(() => {
    const z = loadZone(deviceId);
    zoneRef.current = z;
    setZoneState(z);
    if (tableRef.current) tableRef.current.zone = z;
  }, [deviceId]);

  function onCameraLost() {
    setRunning((was) => {
      if (was) setPaused(true);
      return false;
    });
    setCamera("lost");
    setTimeout(() => setCameraNonce((n) => n + 1), 1500);
  }
  const onLostRef = useRef(onCameraLost);
  onLostRef.current = onCameraLost;

  /**
   * Auto-exposure and white balance shift the whole picture every time something
   * dark or bright lands. Where the webcam lets the browser hold them, hold them
   * while counting. Not every webcam does; the tracker copes either way, and the
   * top bar says which it is.
   */
  async function holdExposure(hold: boolean) {
    const track = streamRef.current?.getVideoTracks()[0];
    const caps = (track?.getCapabilities?.() ?? {}) as { exposureMode?: string[]; whiteBalanceMode?: string[] };
    const mode = hold ? "manual" : "continuous";
    const wanted: Record<string, string> = {};
    if (caps.exposureMode?.includes(mode)) wanted.exposureMode = mode;
    if (caps.whiteBalanceMode?.includes(mode)) wanted.whiteBalanceMode = mode;
    if (!track || !Object.keys(wanted).length) {
      setExposure("auto");
      return;
    }
    try {
      await track.applyConstraints({ advanced: [wanted as MediaTrackConstraintSet] });
      setExposure(hold ? "locked" : "auto");
    } catch {
      setExposure("auto");
    }
  }

  // ── logging ─────────────────────────────────────────────────────────────────

  async function fullItem(id: string): Promise<StockItem | null> {
    const known = itemsRef.current.find((i) => i.id === id);
    if (known) return known;
    const r = await fetchItem(id);
    if (!r.ok) return null;
    mergeItem(r.data.item);
    return r.data.item;
  }

  /** An item with no location yet takes the matrix's. One that has one keeps it. */
  async function assignLocation(id: number, item: StockItem) {
    if (item.location || assigning.current.has(item.id)) return;
    const match = ruleFor(`${itemWords(item)} ${productWords(placedById(id)?.product)}`, matrixRef.current);
    if (!match) return;
    assigning.current.add(item.id);
    let r = await editItem(item.id, { expectedRevision: item.metaRevision, location: match.location });
    if (!r.ok && r.error.status === 409) {
      // Someone else's edit, or another save from this burst: once more from the latest.
      const fresh = await fetchItem(item.id);
      if (fresh.ok) {
        const latest = mergeItem(fresh.data.item);
        if (latest.location) {
          assigning.current.delete(item.id);
          setPlaced((prev) => prev.map((p) => (p.itemId === item.id ? { ...p, location: latest.location } : p)));
          return;
        }
        r = await editItem(item.id, { expectedRevision: latest.metaRevision, location: match.location });
      }
    }
    assigning.current.delete(item.id);
    if (!r.ok) {
      patch(id, { note: `Logged, but the location didn't save: ${errorCopy(r.error.status, r.error.body, "try it on the item")}` });
      return;
    }
    mergeItem(r.data.item);
    setPlaced((prev) => prev.map((p) => (p.itemId === item.id ? { ...p, location: match.location } : p)));
  }

  async function logTo(id: number, item: StockItem, chosenMilli: number | null = null) {
    const p = placedById(id);
    if (!p) return;
    const printed = chosenMilli === null ? placedAmount(item.baseUnit, p.product) : null;
    const milli = chosenMilli ?? printed?.milli ?? null;
    const named = { itemId: item.id, itemName: item.name, unit: item.baseUnit, location: item.location };
    if (milli === null) {
      patch(id, { ...named, status: "amount", problem: null });
      return;
    }
    if (printed?.fromLabel) {
      const earlier = placedRef.current.filter((x) => x.itemId === item.id && x.fromLabel && x.status === "logged" && x.amountMilli !== null).map((x) => x.amountMilli!);
      if (packNeedsCheck(printed.milli, item.id, confirmedPacks.current, earlier)) {
        patch(id, { ...named, status: "amount", askMilli: printed.milli, problem: null });
        return;
      }
    }
    const key = p.moveKey ?? newOperationKey();
    patch(id, { ...named, status: "saving", moveKey: key, amountMilli: milli, fromLabel: Boolean(printed?.fromLabel) || p.askMilli === milli, askMilli: null, unread: false, problem: null });
    const r = await recordMove({ itemId: item.id, kind: "add", quantity: toQuantityString(milli), note: NOTE }, key);
    if (!r.ok) {
      patch(id, { status: "problem", problem: errorCopy(r.error.status, r.error.body, "That didn't save. Try again.") });
      return;
    }
    const saved = mergeItem(r.data.item);
    patch(id, { status: "logged", movementId: r.data.movement.id, moveKey: null, location: saved.location, recordedMilli: saved.balanceMilli, ...(evidenceRef.current ? {} : { crop: "" }) });
    void assignLocation(id, saved);
  }

  /** The label asked a person about a pack size, and they've answered: the same size on the same item no longer asks. */
  function confirmAmount(id: number, milli: number) {
    const p = placedById(id);
    const item = itemsRef.current.find((x) => x.id === p?.itemId);
    if (!p || !item) return;
    const asked = p.askMilli;
    if (asked !== null && asked === milli) confirmedPacks.current.add(`${item.id}:${milli}`);
    void logTo(id, item, milli);
    if (asked === null || asked !== milli) return;
    for (const other of placedRef.current) {
      if (other.id !== id && other.status === "amount" && other.itemId === item.id && other.askMilli === milli) void logTo(other.id, item, milli);
    }
  }

  async function teach(item: StockItem, barcode: string | null, product: ReadProduct | null, opts: { barcodeOnly?: boolean } = {}): Promise<StockItem> {
    let current = item;
    for (const t of identifiersToTeach(current, barcode, product, opts)) {
      // Not vital if it can't: the code may belong to another item, and then a person decides next time.
      const taught = await addIdentifier({ itemId: current.id, ...t });
      if (taught.ok) current = mergeItem(taught.data.item);
    }
    return current;
  }

  /** "One tap, then automatic": anything waiting with the same code goes to the item just settled on. */
  function settleWaiting(from: number, item: StockItem) {
    const source = placedById(from);
    if (!source) return;
    for (const other of placedRef.current) {
      if (other.id === from || (other.status !== "new" && other.status !== "pick")) continue;
      if (sameProduct(source, other)) void logTo(other.id, item);
    }
  }

  async function pickItem(id: number, picked: Pick<StockItem, "id">) {
    const item = await fullItem(picked.id);
    if (!item) {
      patch(id, { status: "problem", problem: "That item isn't in the workshop list any more." });
      return;
    }
    const p = placedById(id);
    // Whatever was printed on it, so the next one logs itself.
    const current = await teach(item, p?.barcode ?? null, p?.product ?? null);
    await logTo(id, current);
    settleWaiting(id, current);
  }

  async function createFromDraft(id: number, draft: NewItemDraft) {
    const p = placedById(id);
    if (!p) return;
    const milli = parseTypedQuantity(draft.amount, draft.unit);
    if (!draft.name.trim() || milli === null) {
      patch(id, { problem: !draft.name.trim() ? "Give it a name." : "Enter how many to add." });
      return;
    }
    const key = p.moveKey ?? newOperationKey();
    patch(id, { busy: true, problem: null, moveKey: key });
    let photoId = p.photoId;
    if (!photoId && p.crop) {
      const stored = await storePhoto(p.crop, p.thumb);
      if (stored.ok) {
        photoId = stored.data.photoId;
        patch(id, { photoId });
      }
    }
    const product = p.product;
    const r = await createItem({
      name: draft.name.trim(),
      brand: product?.brand ?? null,
      manufacturerCode: product?.manufacturerCode ?? null,
      supplierSku: product?.supplierSku ?? null,
      supplierName: product?.supplierName ?? null,
      barcode: p.barcode ?? product?.barcode ?? null,
      variant: product?.variantDetails.join(" ").slice(0, 160) || null,
      colourFinish: product?.colourFinish ?? null,
      baseUnit: draft.unit,
      location: draft.location.trim() || null,
      photoId,
      category: draft.category,
      specs: draft.category ? specsForType(draft.category, draft.specs) : undefined,
      openingQuantity: toQuantityString(milli),
      note: NOTE,
    }, key);
    if (!r.ok) {
      patch(id, { busy: false, problem: errorCopy(r.error.status, r.error.body, "That didn't save. Try again.") });
      return;
    }
    mergeItem(r.data.item);
    patch(id, { busy: false, status: "logged", unread: false, ...(evidenceRef.current ? {} : { crop: "" }), itemId: r.data.item.id, itemName: r.data.item.name, unit: r.data.item.baseUnit, location: r.data.item.location, amountMilli: milli, fromLabel: false, movementId: r.data.movement.id, moveKey: null, recordedMilli: r.data.item.balanceMilli, problem: null });
    settleWaiting(id, r.data.item);
  }

  /** A logged item no rule placed: the row sets its location, and every row of that item follows. */
  async function setLocation(id: number, location: string) {
    const p = placedById(id);
    if (!p || !p.itemId) return;
    const item = await fullItem(p.itemId);
    if (!item) return;
    patch(id, { busy: true, problem: null });
    const r = await editItem(item.id, { expectedRevision: item.metaRevision, location });
    if (!r.ok) {
      patch(id, { busy: false, problem: errorCopy(r.error.status, r.error.body, "The location didn't save. Try again.") });
      return;
    }
    mergeItem(r.data.item);
    patch(id, { busy: false });
    setPlaced((prev) => prev.map((x) => (x.itemId === item.id ? { ...x, location: r.data.item.location } : x)));
  }

  async function changeAmount(id: number, milli: number) {
    const p = placedById(id);
    if (!p || !p.movementId || !p.itemId) return;
    patch(id, { busy: true, problem: null });
    const undone = await undoMovement({ movementId: p.movementId, reason: REASON_AMOUNT }, newOperationKey());
    if (!undone.ok) {
      patch(id, { busy: false, problem: errorCopy(undone.error.status, undone.error.body, "The amount wasn't changed. Try again.") });
      return;
    }
    mergeItem(undone.data.item);
    patch(id, { busy: false, movementId: null });
    await logTo(id, undone.data.item, milli);
    if (placedById(id)?.status === "problem") patch(id, { retryMilli: milli });
  }

  async function undoPlaced(id: number) {
    const p = placedById(id);
    if (!p || !p.movementId) return;
    patch(id, { busy: true, problem: null });
    const r = await undoMovement({ movementId: p.movementId, reason: REASON_UNDO }, newOperationKey());
    if (!r.ok) {
      patch(id, { busy: false, problem: errorCopy(r.error.status, r.error.body, "That wasn't undone. Try again.") });
      return;
    }
    mergeItem(r.data.item);
    patch(id, { busy: false, status: "undone", movementId: null, recordedMilli: r.data.item.balanceMilli });
  }

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
        if (outcome.status === "not_configured" || outcome.status === "daily_limit") setReaderOff(outcome.status);
        if (barcode) patch(id, { status: "new", product: null, problem: null });
        else if (outcome.status === "unreadable") patch(id, { status: "problem", unread: true, problem: UNREADABLE });
        else patch(id, { status: "problem", problem: `${READ_STATUS_COPY[outcome.status].title}. ${READ_STATUS_COPY[outcome.status].body}` });
        return;
      case "pick-product":
        patch(id, { status: "several", readResult: result });
        return;
      case "exact": {
        const product: ReadProduct | null = result.reading?.products[outcome.productIndex] ?? null;
        patch(id, { product });
        const item = await fullItem(outcome.item.id);
        // Matched on a printed code: keep the barcode too, and the next one is free and instant.
        if (item) await logTo(id, await teach(item, barcode, product, { barcodeOnly: true }));
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
    readQueue.current.push(async () => {
      if (placedById(id)?.status !== "reading") return;
      const started = performance.now();
      let r = await readIntakeCrop(crop);
      const passing = !r.ok ? r.error.status === 0 || r.error.status >= 500 : r.data.readStatus === "unavailable";
      if (passing) {
        // Most failures here pass in a moment: once more before bothering anyone.
        await wait(READ_RETRY_MS);
        if (placedById(id)?.status !== "reading") return;
        r = await readIntakeCrop(crop);
      }
      if (placedById(id)?.status !== "reading") return; // a person or a scanner got there first
      if (!r.ok) {
        patch(id, { status: "problem", problem: errorCopy(r.error.status, r.error.body, "The label reader didn't answer. Try again.") });
        return;
      }
      if (r.data.readStatus === "ok" || r.data.readStatus === "unreadable") {
        readTimes.current.push(performance.now() - started);
        setReads((now) => ({ ...now, labels: now.labels + 1, medianMs: median(readTimes.current) }));
      }
      await applyRead(id, r.data, null);
    });
    pumpReads();
  }

  async function detectBarcode(canvas: HTMLCanvasElement): Promise<string | null> {
    try {
      const found = await detectorRef.current?.detect(canvas);
      return found?.map((b) => cleanBarcode(b.rawValue)).find(Boolean) ?? null;
    } catch {
      return null; // a crop the detector couldn't read: the label reader still can
    }
  }

  /**
   * A webcam often hunts for focus just after a hand leaves. Barcodes are free and
   * exact, so a few frames are tried before paying for a label read, and whichever
   * frame came out sharpest is the one that gets read.
   */
  async function identify(id: number, first: HTMLCanvasElement) {
    let best = first;
    let bestScore = sharpnessOf(first);
    let barcode: string | null = null;
    for (let attempt = 0; attempt < SHARPEST_TRIES; attempt++) {
      let canvas: HTMLCanvasElement | null = first;
      if (attempt > 0) {
        await wait(SHARPEST_GAP_MS);
        if (placedById(id)?.status !== "reading") return;
        const track = tableRef.current?.tracker.tracks.find((t) => t.id === id);
        canvas = track && !track.disturbed && !track.touching ? grabCanvas(track.box) : null;
        if (!canvas) break;
        const score = sharpnessOf(canvas);
        if (score > bestScore) {
          best = canvas;
          bestScore = score;
        }
      }
      barcode = await detectBarcode(canvas);
      if (barcode) break;
    }
    if (placedById(id)?.status !== "reading") return;
    const crop = best.toDataURL("image/jpeg", 0.85);
    patch(id, { barcode, crop, thumb: thumbOf(best) });
    if (barcode) {
      setReads((now) => ({ ...now, barcodes: now.barcodes + 1 }));
      const hits = findByBarcode(itemsRef.current, barcode);
      if (hits.length === 1) {
        await logTo(id, hits[0]!.item);
        return;
      }
      if (hits.length > 1) {
        patch(id, { status: "pick", choices: hits.map((h) => h.item) });
        return;
      }
      // Another of the same is already waiting on a person: no need to pay to read it twice.
      const twin = placedRef.current.find((p) => p.id !== id && p.status === "new" && sameProduct({ barcode }, p));
      if (twin) {
        patch(id, { status: "new", product: twin.product });
        return;
      }
    }
    queueRead(id, crop);
  }

  function grabCanvas(box: Box): HTMLCanvasElement | null {
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
    return canvas;
  }

  function thumbOf(canvas: HTMLCanvasElement): string {
    const thumbCanvas = document.createElement("canvas");
    const thumbScale = Math.min(1, THUMB_LONG_SIDE / Math.max(canvas.width, canvas.height));
    thumbCanvas.width = Math.max(8, Math.round(canvas.width * thumbScale));
    thumbCanvas.height = Math.max(8, Math.round(canvas.height * thumbScale));
    thumbCanvas.getContext("2d")?.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
    return thumbCanvas.toDataURL("image/jpeg", 0.7);
  }

  function onSettled(track: Track) {
    const canvas = grabCanvas(track.box);
    if (!canvas) return;
    const held = lockRef.current;
    const scanned = nextScanRef.current;
    setPlaced((prev) => [{ ...blankPlaced(track.id, track.box), thumb: thumbOf(canvas), status: held || scanned?.item ? "saving" : "reading", barcode: scanned?.barcode ?? null }, ...prev]);
    if (held) {
      void fullItem(held.itemId).then((item) => {
        if (item) void logTo(track.id, item, held.milli);
        else patch(track.id, { status: "problem", problem: "That item isn't in the workshop list any more." });
      });
      return;
    }
    if (scanned) {
      setNextScan(null);
      if (scanned.item) {
        void logTo(track.id, scanned.item);
        return;
      }
      const crop = canvas.toDataURL("image/jpeg", 0.85);
      patch(track.id, { crop });
      queueRead(track.id, crop);
      return;
    }
    void identify(track.id, canvas);
  }
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  function readAgain(id: number) {
    const p = placedById(id);
    if (!p) return;
    const track = tableRef.current?.tracker.tracks.find((t) => t.id === id);
    const canvas = track ? grabCanvas(track.box) : null;
    patch(id, { status: "reading", problem: null, unread: false, moveKey: null });
    if (canvas) void identify(id, canvas);
    else queueRead(id, p.crop);
  }

  /** A hand scanner: the code it just read goes to whatever is waiting, the next thing placed, or straight on the record. */
  function onScan(raw: string) {
    if (!loadedRef.current) {
      say("The stock list is still loading. Scan that again in a moment.");
      return;
    }
    const barcode = cleanBarcode(raw);
    if (!barcode) {
      say(`${raw} isn't a barcode it can check.`);
      return;
    }
    const hits = findByBarcode(itemsRef.current, barcode);
    const open = [...placedRef.current].reverse().find((p) => p.status === "new" || p.status === "pick" || p.status === "problem" || p.status === "reading");
    if (open) {
      patch(open.id, { barcode });
      if (hits.length === 1) void teach(hits[0]!.item, barcode, open.product, { barcodeOnly: true }).then((item) => logTo(open.id, item));
      else if (hits.length > 1) patch(open.id, { status: "pick", choices: hits.map((h) => h.item), unread: false, problem: null });
      else say(`Barcode ${barcode} isn't on the list yet. It will save with #${open.id}.`);
      if (hits.length === 0 && open.status === "problem") patch(open.id, { status: "new", unread: false, problem: null });
      return;
    }
    if (runningRef.current) {
      setNextScan({ barcode, item: hits.length === 1 ? hits[0]!.item : null });
      return;
    }
    // Nothing on the camera: the scanner is doing the counting.
    const id = nextTrackerId.current++;
    setPlaced((prev) => [{ ...blankPlaced(id, { x: 0, y: 0, w: 0, h: 0 }), onTable: false, barcode }, ...prev]);
    setReads((now) => ({ ...now, barcodes: now.barcodes + 1 }));
    if (hits.length === 1) void logTo(id, hits[0]!.item);
    else if (hits.length > 1) patch(id, { status: "pick", choices: hits.map((h) => h.item) });
    else patch(id, { status: "new" });
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
    // The default just samples the big picture, which keeps three times the noise (measured in Chromium).
    if (smallCtx) smallCtx.imageSmoothingQuality = "medium";
    let ticks = 0;
    let spent = 0;
    let since = Date.now();
    let lastVideoTime = -1;
    let lastVideoAt = Date.now();
    const timer = setInterval(() => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || !video.videoWidth || !smallCtx) return;
      const smallHeight = Math.round((ANALYSIS_WIDTH * video.videoHeight) / video.videoWidth);
      if (small.width !== ANALYSIS_WIDTH || small.height !== smallHeight) {
        small.width = ANALYSIS_WIDTH;
        small.height = smallHeight;
      }
      const started = performance.now();
      smallCtx.drawImage(video, 0, 0, small.width, small.height);
      const image = smallCtx.getImageData(0, 0, small.width, small.height);
      frameRef.current = image;
      ticks += 1;

      // A webcam knocked out or asleep can leave the last picture frozen on screen.
      if (video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        lastVideoAt = Date.now();
      } else if (Date.now() - lastVideoAt > STALLED_MS && !document.hidden) {
        lastVideoAt = Date.now();
        onLostRef.current();
        return;
      }

      // The empty table: several frames averaged, so sensor noise isn't taken for an object.
      const reading = calibration.current;
      if (reading) {
        addCalibrationFrame(reading, image);
        if (reading.frames >= CALIBRATION_FRAMES) {
          if (reading.moved && calibrationAttempts.current + 1 < CALIBRATION_ATTEMPTS) {
            calibrationAttempts.current += 1;
            calibration.current = newCalibration();
            return;
          }
          const read = finishCalibration(reading);
          calibration.current = null;
          setCalibrating(false);
          if (read) {
            tableRef.current = { background: read.background, threshold: read.threshold, zone: zoneRef.current, tracker: { ...emptyTracker(), nextId: nextTrackerId.current } };
            setAdvice(tableAdvice(read.check)?.text ?? null);
            setRunning(true);
          }
        }
        return;
      }

      const table = tableRef.current;
      if (runningRef.current && table) {
        if (table.background.length !== image.data.length) {
          // The camera came back at another size: its picture of the empty table no longer fits.
          tableRef.current = null;
          setRunning(false);
          setPaused(false);
          return;
        }
        table.tracker.nextId = Math.max(table.tracker.nextId, nextTrackerId.current);
        const result = analyseFrame(table, image, Date.now());
        nextTrackerId.current = Math.max(nextTrackerId.current, table.tracker.nextId);
        setTableChanged(result.stopped);
        setUnsteady(Boolean(result.step?.unsteady));
        armsRef.current = result.found.armCells ?? null;
        if (result.step) {
          atEdgeRef.current = result.step.atEdge;
          result.step.settled.forEach((t) => onSettledRef.current(t));
          if (result.step.gone.length) {
            const gone = new Set(result.step.gone.map((t) => t.id));
            const swapped = new Set(result.step.replaced.map((t) => t.id));
            setPlaced((prev) => prev.map((p) => {
              // Turned over to show its label: it's about to be read again, as new.
              if (swapped.has(p.id) && p.status === "problem" && p.unread) return { ...p, onTable: false, status: "ignored" };
              if (gone.has(p.id)) return { ...p, onTable: false, status: p.status === "problem" && p.unread ? "missed" : p.status };
              return p;
            }));
          }
        }
      }
      spent += performance.now() - started;
      if (Date.now() - since >= 600) {
        setTelemetry({ fps: (ticks * 1000) / (Date.now() - since), onTable: tableRef.current?.tracker.tracks.filter((t) => t.settled).length ?? 0, analysisMs: ticks ? spent / ticks : 0 });
        ticks = 0;
        spent = 0;
        since = Date.now();
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
          tracks: tableRef.current?.tracker.tracks ?? [],
          describe: (track) => describeTrack(track, placedRef.current.find((p) => p.id === track.id)),
          memory: memory.current,
          colours,
          now: Date.now(),
          running: runningRef.current,
          calibrating: reading ? Math.min(1, reading.frames / CALIBRATION_FRAMES) : null,
          reducedMotion,
          zone: zoneRef.current,
          armCells: armsRef.current ?? null,
          atEdge: atEdgeRef.current,
          highlight: highlightRef.current,
        });
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [camera]);

  // Sound, so the person at the table doesn't have to look up.
  useEffect(() => {
    for (const p of placed) {
      const before = seenStatus.current.get(p.id);
      if (before === p.status) continue;
      seenStatus.current.set(p.id, p.status);
      if (!soundRef.current) continue;
      if (p.status === "logged") playCue("logged");
      else if (NEEDS_YOU.has(p.status) && !NEEDS_YOU.has(before ?? "")) playCue("needs");
    }
  }, [placed]);

  async function startTable() {
    unlockSound();
    setTableChanged(false);
    setUnsteady(false);
    setPaused(false);
    setRunning(false);
    setCalibrating(true);
    setAdvice(null);
    memory.current.clear();
    atEdgeRef.current = [];
    armsRef.current = null;
    setPlaced((prev) => prev.map((p) => ({ ...p, onTable: false, status: p.status === "problem" && p.unread ? "missed" : p.status })));
    // ids carry on, so this session's rows stay apart from the new ones
    nextTrackerId.current = Math.max(nextTrackerId.current, placedRef.current.reduce((n, p) => Math.max(n, p.id), 0) + 1);
    tableRef.current = null;
    // Let the camera find the right exposure for the empty table, then hold it there.
    if (exposure === "locked") {
      await holdExposure(false);
      await wait(800);
    }
    await holdExposure(true);
    calibrationAttempts.current = 0;
    calibration.current = newCalibration();
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

  /** The card a key acts on: the one open at the top of the queue. */
  function currentCard(): Placed | null {
    const queue = waitingQueue(placedRef.current.filter((p) => NEEDS_YOU.has(p.status)));
    return queue.find((g) => g.lead.id === focusId)?.lead ?? queue[0]?.lead ?? null;
  }

  function runShortcut(key: string) {
    const card = currentCard();
    if (key === "u") {
      const last = placedRef.current.find((p) => p.status === "logged");
      if (last) void undoPlaced(last.id);
    } else if (key === "f") {
      toggleFull();
    } else if (key === "m") {
      toggleSound();
    } else if (key === "x") {
      if (card) patch(card.id, { status: "ignored", problem: null });
    } else if (key === "r") {
      if (card) readAgain(card.id);
    } else if (key === "enter") {
      if (card?.status === "new" || card?.status === "amount") (document.getElementById(`stock-intake-form-${card.id}`) as HTMLFormElement | null)?.requestSubmit();
    } else if (/^[1-9]$/.test(key) && card) {
      const n = Number(key) - 1;
      if (card.status === "pick" && card.choices[n]) void pickItem(card.id, card.choices[n]!);
      if (card.status === "several" && card.readResult?.reading?.products[n]) void applyRead(card.id, card.readResult, n);
    }
  }

  function onShortcut(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target as HTMLElement | null)?.tagName ?? "";
    if (["INPUT", "SELECT", "TEXTAREA"].includes(tag)) return;
    const fed = feedScan(scanRef.current, e.key, performance.now());
    scanRef.current = fed.buffer;
    // A scanner types far faster than a person: a shortcut only runs if no more keys follow.
    if (shortcutTimer.current) {
      clearTimeout(shortcutTimer.current);
      shortcutTimer.current = null;
    }
    if (fed.code) {
      e.preventDefault();
      onScan(fed.code);
      return;
    }
    const key = e.key.toLowerCase();
    if (key === " ") {
      if (["BUTTON", "SUMMARY", "A"].includes(tag)) return; // Space presses whatever has focus
      if (running) pauseTable();
      else if (paused) resumeTable();
      else return;
      e.preventDefault();
      return;
    }
    if (key === "enter" && ["BUTTON", "SUMMARY", "A"].includes(tag)) return;
    shortcutTimer.current = setTimeout(() => runShortcut(key), SHORTCUT_DELAY_MS);
  }
  const onShortcutRef = useRef(onShortcut);
  onShortcutRef.current = onShortcut;
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onShortcutRef.current(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // ── the screen ──────────────────────────────────────────────────────────────

  const waiting = useMemo(() => placed.filter((p) => NEEDS_YOU.has(p.status)), [placed]);
  const queue = useMemo(() => waitingQueue(waiting), [waiting]);
  const openGroup = queue.find((g) => g.lead.id === focusId) ?? queue[0] ?? null;
  const missed = useMemo(() => placed.filter((p) => p.status === "missed").length, [placed]);
  const run = useMemo(() => sameInARow(placed), [placed]);
  const working = useMemo(() => placed.filter((p) => p.status === "reading" || p.status === "saving").length, [placed]);
  const logged = useMemo(() => placed.filter((p) => p.status === "logged"), [placed]);
  const totals = useMemo(() => sessionTotals(placed), [placed]);
  const shownRows = useMemo(() => placed.filter((p) => p.status === "logged" || p.status === "undone" || p.status === "missed"), [placed]);
  const locations = useMemo(() => matrixLocations(matrix), [matrix]);
  // Started before the list has loaded, every known item would look new.
  const ready = camera === "live" && !loadError && loaded;
  const last = logged[0] ?? null;
  const offerSame = !lock && run >= SAME_RUN && last?.itemId && sameDismissed !== `${last.itemId}:${last.amountMilli}` ? last : null;

  // What the screen shows survives a reload: the stock is safe either way, but Undo and the totals wouldn't be.
  useEffect(() => {
    saveSession(placed.filter((p): p is Placed & { status: "logged" | "undone" } => p.status === "logged" || p.status === "undone").map((p) => ({
      id: p.id, at: p.at, status: p.status, itemId: p.itemId, itemName: p.itemName, unit: p.unit, location: p.location, amountMilli: p.amountMilli,
      fromLabel: p.fromLabel, recordedMilli: p.recordedMilli, movementId: p.movementId, thumb: p.thumb,
    })));
  }, [placed]);

  // A reload now would lose what's in flight and what's waiting on a person.
  const unsettled = working + waiting.length;
  useEffect(() => {
    if (!unsettled) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsettled]);

  function clearLog() {
    clearSession();
    setRestored(0);
    setPlaced((prev) => prev.filter((p) => NEEDS_YOU.has(p.status) || p.status === "reading" || p.status === "saving"));
  }

  function zonePoint(e: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const canvas = overlayRef.current;
    const video = videoRef.current;
    if (!canvas || !video?.videoWidth) return null;
    const rect = canvas.getBoundingClientRect();
    const picture = videoArea(rect.width, rect.height, video.videoWidth, video.videoHeight);
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left - picture.x) / picture.w)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top - picture.y) / picture.h)),
    };
  }

  function setZone(next: Box | null) {
    zoneRef.current = next;
    setZoneState(next);
    saveZone(deviceId, next);
    if (tableRef.current) tableRef.current.zone = next;
  }

  function finishZone() {
    if (zoneDraft) {
      const w = Math.abs(zoneDraft.x1 - zoneDraft.x0);
      const h = Math.abs(zoneDraft.y1 - zoneDraft.y0);
      if (w >= MIN_ZONE && h >= MIN_ZONE) setZone({ x: Math.min(zoneDraft.x0, zoneDraft.x1), y: Math.min(zoneDraft.y0, zoneDraft.y1), w, h });
      else say("That area is too small. Drag across the part of the picture the table fills.");
    }
    setZoneDraft(null);
    setDrawingZone(false);
  }

  function downloadEvidence() {
    const rows = placedRef.current.filter((p) => p.crop && (p.status === "logged" || p.status === "ignored")).map((p) => {
      const item = itemsRef.current.find((i) => i.id === p.itemId);
      return { crop: p.crop, status: p.status, barcode: p.barcode, read: p.product, itemName: p.itemName, codes: item?.identifiers.map((i) => ({ kind: i.kind, value: i.value })) ?? [], amountMilli: p.amountMilli };
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([JSON.stringify(rows)], { type: "application/json" }));
    link.download = `camera-table-crops-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }
  /** `?evidence=1` only: a clip of what the webcam really sends, saved to this computer, to test the counting against. */
  function toggleClip() {
    const open = clipRef.current;
    if (open) {
      open.stop();
      return;
    }
    const stream = streamRef.current;
    if (!stream || typeof MediaRecorder === "undefined") return;
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm", videoBitsPerSecond: 12_000_000 });
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = () => {
      clipRef.current = null;
      setRecordingClip(false);
      window.clearTimeout(limit);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob(chunks, { type: "video/webm" }));
      link.download = `camera-table-clip-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.webm`;
      link.click();
      URL.revokeObjectURL(link.href);
    };
    const limit = window.setTimeout(() => recorder.stop(), CLIP_LIMIT_MS);
    clipRef.current = recorder;
    recorder.start(1000);
    setRecordingClip(true);
  }
  const status = camera !== "live" ? (camera === "starting" ? "Starting" : camera === "lost" ? "Camera lost" : "No camera") : calibrating ? "Reading table" : running ? "Live" : paused ? "Paused" : "Ready";

  return (
    <div ref={rootRef} data-theme="console" className={cn("flex flex-col gap-2 bg-surface-subtle p-2 text-text", full ? "fixed inset-0 z-[60] h-screen" : "rounded-[6px] lg:h-[calc(100vh-150px)] lg:min-h-[640px]")} data-testid="stock-intake">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-[4px] border border-border bg-surface px-3 py-1.5">
        <span className="inline-flex items-center gap-2 font-mono text-[13px] font-bold uppercase tracking-[0.1em] text-text" data-testid="stock-intake-status">
          <span aria-hidden="true" className={cn("h-2.5 w-2.5 rounded-full", running ? "console-live bg-state-success" : calibrating ? "console-live bg-accent-yellow" : camera === "live" ? "bg-text-muted" : "bg-state-danger")} />
          {status}
        </span>
        {size ? <Readout label="Cam" value={`${size.w}×${size.h}${frameRate ? ` ${Math.round(frameRate)}fps` : ""}${size.w < FULL_HD_WIDTH ? " · low res" : ""}`} tone={size.w < FULL_HD_WIDTH || (frameRate !== null && frameRate < LOW_FRAME_RATE) ? "warn" : undefined} /> : null}
        {telemetry && running && telemetry.fps < SLOW_RATE ? <Readout label="Rate" value={`${telemetry.fps.toFixed(1)}/s slow`} tone="warn" /> : null}
        {telemetry ? <Readout label="On table" value={String(telemetry.onTable)} testId="stock-intake-on-table" /> : null}
        <Readout label="Barcodes" value={hasDetector ? String(reads.barcodes) : "Off"} tone={hasDetector ? undefined : "warn"} testId="stock-intake-barcodes" />
        <Readout label="Label reads" value={readerOff ? "Off" : `${reads.labels}${reads.medianMs !== null ? ` · ${(reads.medianMs / 1000).toFixed(1)}s` : ""}`} tone={readerOff ? "warn" : undefined} testId="stock-intake-label-reads" />
        {exposure ? <Readout label="Exposure" value={exposure === "locked" ? "Held" : "Auto"} testId="stock-intake-exposure" /> : null}
        {matrix ? <Readout label="Bin rules" value={String(matrix.rules.length)} tone={matrix.rules.length ? undefined : "warn"} /> : null}
        <span className="flex-1" />
        {devices.length > 1 ? (
          <label className="flex items-center gap-2">
            <span className="console-label">Camera</span>
            <select
              value={deviceId ?? ""}
              onChange={(e) => { setDeviceId(e.target.value || null); rememberCamera(e.target.value); tableRef.current = null; setRunning(false); setPaused(false); }}
              className="h-8 max-w-[220px] rounded-[4px] border border-border-strong bg-surface-subtle px-2 text-sm text-text"
              data-testid="stock-intake-camera"
            >
              {!deviceId ? <option value="">Choose…</option> : null}
              {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>)}
            </select>
          </label>
        ) : null}
        <div className="flex items-center gap-1">
          {camera === "live" ? <Button type="button" variant="secondary" size="sm" onClick={() => { setZoneDraft(null); setDrawingZone((now) => !now); }} aria-pressed={drawingZone} data-testid="stock-intake-zone"><CropIcon aria-hidden="true" className="h-4 w-4" /> Table area</Button> : null}
          {running ? <Button type="button" variant="secondary" size="sm" onClick={pauseTable} data-testid="stock-intake-pause"><Pause aria-hidden="true" className="h-4 w-4" /> Pause</Button> : null}
          {evidence && camera === "live" ? <Button type="button" variant="secondary" size="sm" onClick={toggleClip} data-testid="stock-intake-clip">{recordingClip ? "Stop and save clip" : "Record clip"}</Button> : null}
          {running || paused ? <Button type="button" variant="secondary" size="sm" onClick={() => void startTable()} data-testid="stock-intake-reset"><RotateCcw aria-hidden="true" className="h-4 w-4" /> Reset table</Button> : null}
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

      {nextScan ? (
        <div className="flex items-center gap-2 rounded-[4px] border border-accent-yellow bg-surface px-3 py-1.5 text-sm font-medium text-text" role="status" data-testid="stock-intake-next-scan">
          <ScanBarcode aria-hidden="true" className="h-4 w-4 shrink-0 text-accent-yellow" />
          <span className="min-w-0 flex-1">Scanned {nextScan.item?.name ?? `barcode ${nextScan.barcode}`}. Put it on the table and it logs without a read.</span>
          <Button type="button" variant="secondary" size="sm" onClick={() => setNextScan(null)}>Cancel</Button>
        </div>
      ) : null}

      {offerSame ? (
        <div className="flex items-center gap-2 rounded-[4px] border border-border-strong bg-surface px-3 py-1.5 text-sm text-text" role="status" data-testid="stock-intake-same-offer">
          <Lock aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
          <span className="min-w-0 flex-1">{run} in a row of {offerSame.itemName}. If the rest are the same, skip reading them.</span>
          <Button type="button" variant="secondary" size="sm" onClick={() => { if (offerSame.itemId && offerSame.unit && offerSame.itemName && offerSame.amountMilli !== null) setLockState({ itemId: offerSame.itemId, name: offerSame.itemName, unit: offerSame.unit, milli: offerSame.amountMilli }); }} data-testid="stock-intake-same-lock">All the same</Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setSameDismissed(`${offerSame.itemId}:${offerSame.amountMilli}`)}>No</Button>
        </div>
      ) : null}

      {notice ? <p className="rounded-[4px] border border-border bg-surface px-3 py-1.5 text-sm text-text" role="status" data-testid="stock-intake-notice">{notice}</p> : null}

      <div className="grid min-h-0 flex-1 gap-2 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-h-0 min-w-0 flex-col gap-2">
          <div className="relative aspect-video w-full overflow-hidden rounded-[4px] border border-border bg-surface-subtle lg:aspect-auto lg:min-h-0 lg:flex-1" data-testid="stock-intake-feed" data-camera={camera} data-running={running} data-analysis-ms={telemetry ? telemetry.analysisMs.toFixed(1) : undefined}>
            <video ref={videoRef} playsInline muted autoPlay aria-hidden="true" className="absolute inset-0 h-full w-full object-contain" />
            <canvas ref={overlayRef} aria-hidden="true" className="absolute inset-0 h-full w-full font-mono" />
            {drawingZone ? (
              <div
                className="absolute inset-0 z-10 cursor-crosshair touch-none"
                data-testid="stock-intake-zone-draw"
                onPointerDown={(e) => { const at = zonePoint(e); if (at) { e.currentTarget.setPointerCapture(e.pointerId); setZoneDraft({ x0: at.x, y0: at.y, x1: at.x, y1: at.y }); } }}
                onPointerMove={(e) => { const at = zonePoint(e); if (at && zoneDraft) setZoneDraft({ ...zoneDraft, x1: at.x, y1: at.y }); }}
                onPointerUp={finishZone}
              >
                <p className="absolute left-3 top-3 rounded-[4px] bg-surface px-3 py-1.5 text-sm font-semibold text-text">Drag across the part of the picture the table fills. Anything outside it is ignored.
                  {zone ? <button type="button" className="ml-2 underline" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()} onClick={() => { setZone(null); setDrawingZone(false); }} data-testid="stock-intake-zone-clear">Use the whole picture</button> : null}
                </p>
                {zoneDraft && videoRef.current?.videoWidth && overlayRef.current ? (() => {
                  const c = overlayRef.current!;
                  const a = videoArea(c.clientWidth, c.clientHeight, videoRef.current!.videoWidth, videoRef.current!.videoHeight);
                  const box = { left: a.x + Math.min(zoneDraft.x0, zoneDraft.x1) * a.w, top: a.y + Math.min(zoneDraft.y0, zoneDraft.y1) * a.h, width: Math.abs(zoneDraft.x1 - zoneDraft.x0) * a.w, height: Math.abs(zoneDraft.y1 - zoneDraft.y0) * a.h };
                  return <ZoneDraft box={box} />;
                })() : null}
              </div>
            ) : null}
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
                  <p className="mt-1.5 text-sm text-text-muted">It reads the empty table first and spots anything new against it. A plain, mid-coloured mat works best: white stock vanishes on white, black on black. Bring the camera as close as the table allows, so small print stays sharp.</p>
                  <Button type="button" size="lg" className="mt-4" disabled={!ready || !matrixAvailable} onClick={() => void startTable()} data-testid="stock-intake-start"><Play aria-hidden="true" className="h-4 w-4" /> Start</Button>
                </div>
              </div>
            ) : tableChanged ? (
              <p className="absolute inset-x-3 top-3 rounded-[4px] bg-state-danger px-3 py-2 text-sm font-semibold text-text-inverse" role="alert">
                Most of the picture has changed, so counting has stopped. If the camera moved, clear the table and press Reset table.
              </p>
            ) : unsteady ? (
              <p className="absolute inset-x-3 top-3 rounded-[4px] bg-state-warning px-3 py-2 text-sm font-semibold text-text-inverse" role="status" data-testid="stock-intake-unsteady">
                The picture isn&rsquo;t steady, so nothing new counts until it stops changing. If it stays like this, check the light or turn off auto-focus.
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
              {missed ? <span className="flex items-baseline gap-1.5"><span className="font-mono text-[15px] font-bold tabular-nums text-state-warning" data-testid="stock-intake-missed">{missed}</span><span className="console-label">Not logged</span></span> : null}
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
            <span className="flex items-center gap-1.5"><Key>Enter</Key> add</span>
            <span className="flex items-center gap-1.5"><Key>1–9</Key> pick</span>
            <span className="flex items-center gap-1.5"><Key>X</Key> ignore</span>
            <span className="flex items-center gap-1.5"><Key>R</Key> read again</span>
            <span className="flex items-center gap-1.5"><Key>F</Key> full screen</span>
            <span className="flex items-center gap-1.5"><Key>M</Key> sound</span>
            <span className="flex-1" />
            <span>Keep a small gap between items, labels up, inside the yellow corners.</span>
          </div>
        </div>

        <aside className="min-h-0 min-w-0 space-y-2 overflow-y-auto" aria-label="This session">
          {loadError ? (
            <Block tone="warn" title="Couldn't load what the table needs" role="alert">
              <p>{loadError}</p>
              <Button type="button" variant="secondary" size="sm" className="mt-1" onClick={() => void load()}>Try again</Button>
            </Block>
          ) : null}
          {advice ? (
            <Block tone="warn" title="The table could be better" role="status" testId="stock-intake-advice">
              <p>{advice}</p>
            </Block>
          ) : null}
          {readerOff ? (
            <Block tone="warn" title={READ_STATUS_COPY[readerOff].title} role="status" testId="stock-intake-reader-off">
              <p>{hasDetector ? "Items with a barcode the list knows still log by themselves. Everything else waits for you to pick it." : "Everything waits for you to pick it from the list."}</p>
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

          {openGroup ? (
            <NeedsYouCard
              key={openGroup.lead.id}
              placed={openGroup.lead}
              repeats={openGroup.repeats.length}
              items={items}
              matrix={matrix}
              locations={locations}
              typesEnabled={typesEnabled}
              onPick={(item) => void pickItem(openGroup.lead.id, item)}
              onChooseProduct={(i) => { if (openGroup.lead.readResult) void applyRead(openGroup.lead.id, openGroup.lead.readResult, i); }}
              onCreate={(draft) => void createFromDraft(openGroup.lead.id, draft)}
              onAmount={(milli) => confirmAmount(openGroup.lead.id, milli)}
              onRetry={() => void retry(openGroup.lead.id)}
              onReadAgain={() => readAgain(openGroup.lead.id)}
              onIgnore={() => {
                const ids = new Set([openGroup.lead.id, ...openGroup.repeats.map((r) => r.id)]);
                setPlaced((prev) => prev.map((p) => (ids.has(p.id) ? { ...p, status: "ignored", problem: null } : p)));
              }}
              onHover={(on) => { highlightRef.current = on ? openGroup.lead.id : null; }}
            />
          ) : null}
          {queue.filter((g) => g !== openGroup).map((g) => (
            <QueuedCard key={g.lead.id} placed={g.lead} repeats={g.repeats.length} onOpen={() => setFocusId(g.lead.id)} onHover={(on) => { highlightRef.current = on ? g.lead.id : null; }} />
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
              <div className="flex items-center gap-2 px-3 py-1">
                <p className="console-label flex-1">Log · newest first{restored ? ` · ${restored} from before the reload` : ""}</p>
                {evidence ? <button type="button" onClick={downloadEvidence} className="inline-flex h-8 items-center gap-1 rounded-[4px] px-2 text-xs font-semibold text-text-muted hover:bg-surface-raised hover:text-text" data-testid="stock-intake-evidence"><Download aria-hidden="true" className="h-3.5 w-3.5" /> Crops</button> : null}
                <button type="button" onClick={clearLog} title="Clears this screen's list. The stock stays as recorded." className="h-8 rounded-[4px] px-2 text-xs font-semibold text-text-muted hover:bg-surface-raised hover:text-text" data-testid="stock-intake-clear-log">Clear list</button>
              </div>
              <ul className="divide-y divide-border border-t border-border" data-testid="stock-intake-rows">
                {(showAllRows ? shownRows : shownRows.slice(0, ROWS_SHOWN)).map((p) => (
                  <LoggedRow
                    key={p.id}
                    placed={p}
                    locked={lock?.itemId === p.itemId && lock?.milli === p.amountMilli}
                    offerLocation={shownRows.find((x) => x.status === "logged" && x.itemId === p.itemId)?.id === p.id}
                    locations={locations}
                    onChangeAmount={(milli) => void changeAmount(p.id, milli)}
                    onSetLocation={(text) => void setLocation(p.id, text)}
                    onUndo={() => void undoPlaced(p.id)}
                    onReadAgain={() => readAgain(p.id)}
                    onIgnore={() => patch(p.id, { status: "ignored", problem: null })}
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
