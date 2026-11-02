"use client";

import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import { Camera, ChevronRight, Pencil } from "lucide-react";
import { PhilDictateButton } from "@/components/phil/ui/PhilDictateButton";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { PhilSkeletonCard } from "@/components/phil/ui/PhilSkeleton";
import { PhilSyncBanner } from "@/components/phil/ui/PhilSyncBanner";
import { resizeImageToDataUrl } from "@/domains/evidence/service";
import {
  PHOTO_MAX_BYTES,
  builderBadge,
  countsLine,
  filterRecentNames,
  lastSuccessfulSend,
  nextAreaName,
  pendingBlocker,
  photoCapHint,
  plural,
} from "@/domains/itp-simple/model";
import {
  ItpAreaResponseSchema,
  ItpPdfResponseSchema,
  ItpPhotoResponseSchema,
  ItpReportResponseSchema,
  ItpSendResponseSchema,
  type ItpArea,
  type ItpPdf,
  type ItpPhoto,
  type ItpReportResponse,
  type ItpSend,
} from "@/domains/itp-simple/schema";
import {
  QUEUE_INITIAL,
  nextToSend,
  queueReducer,
  summarise,
  type PendingPhoto,
} from "@/domains/itp-simple/upload-queue";
import {
  ItpBadge,
  ItpChip,
  ItpInput,
  ItpLabel,
  ItpPrimaryButton,
  ItpSecondaryButton,
  ItpSegmented,
  ItpTextButton,
  type PhotoSource,
} from "./ItpControls";
import { ItpAreaSheet } from "./ItpAreaSheet";
import { ItpDock } from "./ItpDock";
import { ItpLeaveGuard } from "./ItpLeaveGuard";
import { ItpMakePdfSheet } from "./ItpMakePdfSheet";
import { ItpNewAreaSheet } from "./ItpNewAreaSheet";
import { ItpPdfsSheet } from "./ItpPdfsSheet";
import { ItpPendingTile, ItpSavedTile } from "./ItpPhotoTile";
import { ItpPhotoSheet } from "./ItpPhotoSheet";
import { ItpRenamePdfSheet } from "./ItpRenamePdfSheet";
import { ItpReportSheet } from "./ItpReportSheet";
import { ItpSendSheet, type SendError, type SendPhase } from "./ItpSendSheet";
import { itpApi, itpBase } from "./itpApi";
import styles from "./itp.module.css";

/**
 * The ITP builder (boards 3–5, 11–12; handoff 2026-11-02). One report:
 * area cards in capture order, each with its own Photos button and a
 * 3-column grid of tiles; the dock holds the PDF state + New area.
 *
 * The rule behind everything here: never show a state the app can't know,
 * and never lose a photo without saying so.
 *
 *   - Pending photos live in a client queue OUTSIDE the refetched report
 *     and are merged into the render; a refetch can't drop a tile.
 *   - Uploads go one at a time in the order taken; nothing locks. Network
 *     failure → Not sent (amber) + the sync banner; server error → Didn't
 *     save (red) with Retry on the tile. The response decides, not a guess.
 *   - Tapping a name chip / Add area / No name yet creates the area AND
 *     opens the picker in the same tap (the file input is clicked inside
 *     the handler, before the request returns — iOS blocks it otherwise).
 *     The area shows at once; its tiles wait until it has a server id.
 *   - Leave guard on back / route change while anything is unsaved.
 */

type Sheet =
  | { kind: "newArea" }
  | { kind: "area"; areaKey: string }
  | { kind: "photo"; areaId: string; photoId: string }
  | { kind: "itp" }
  | { kind: "makePdf" }
  | { kind: "pdfs" }
  | { kind: "renamePdf"; pdfId: string }
  | { kind: "send"; pdfId: string };

interface LocalArea {
  localId: string;
  name: string;
  /** Set when the server answered with an error; Retry on a tile re-creates. */
  failed?: string;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Couldn't read the photo"));
    reader.readAsDataURL(file);
  });
}

/** JPEG data URL for upload: downscaled to keep the request well under the
 *  serverless body cap on 4G; a photo that won't decode goes up as-is. */
async function toUploadDataUrl(file: File): Promise<string> {
  try {
    return await resizeImageToDataUrl(file, 2048, 0.82);
  } catch {
    return readFileAsDataUrl(file);
  }
}

let localSeq = 0;
function nextLocalId(prefix: string): string {
  localSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${localSeq}`;
}

export function PhilItpReportBuilder({ jobId, reportId }: { jobId: string; reportId: string }) {
  const base = itpBase(jobId);
  const [data, setData] = useState<ItpReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [queue, dispatch] = useReducer(queueReducer, QUEUE_INITIAL);
  const [localAreas, setLocalAreas] = useState<LocalArea[]>([]);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [sendPhase, setSendPhase] = useState<SendPhase>({ kind: "idle" });
  const [sendError, setSendError] = useState<SendError | null>(null);
  const [leaveHref, setLeaveHref] = useState<string | null>(null);
  const [emptySource, setEmptySource] = useState<PhotoSource>("camera");
  const [emptyName, setEmptyName] = useState("");
  const [deleted, setDeleted] = useState(false);

  const cameraInput = useRef<HTMLInputElement | null>(null);
  const rollInput = useRef<HTMLInputElement | null>(null);
  const pickTarget = useRef<string | null>(null);
  const inFlight = useRef<Set<string>>(new Set());
  const creating = useRef<Set<string>>(new Set());
  const emptyNameRef = useRef<HTMLInputElement | null>(null);
  const emptyNameId = useId();

  // ── Load ────────────────────────────────────────────────────────────
  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoadError(null);
      const r = await itpApi(`${base}&id=${encodeURIComponent(reportId)}`);
      if (!r.ok) {
        if (!silent)
          setLoadError(
            r.kind === "network"
              ? "Check you've got signal, then try again. Photos that already saved are safe."
              : r.message
          );
        setLoading(false);
        return;
      }
      const parsed = ItpReportResponseSchema.safeParse(r.data);
      if (!parsed.success) {
        if (!silent) setLoadError("The app couldn't read the reply — refresh to check.");
        setLoading(false);
        return;
      }
      setData(parsed.data);
      setLoading(false);
    },
    [base, reportId]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const summary = useMemo(() => summarise(queue), [queue]);

  // Resync (stale flags, counts) once a batch has fully landed.
  const prevUnsaved = useRef(0);
  useEffect(() => {
    if (prevUnsaved.current > 0 && summary.unsaved === 0) void load(true);
    prevUnsaved.current = summary.unsaved;
  }, [summary.unsaved, load]);

  // ── Local helpers ───────────────────────────────────────────────────
  const report = data?.report ?? null;
  const areas: ReadonlyArray<ItpArea> = useMemo(() => report?.areas ?? [], [report]);
  const pdfs: ReadonlyArray<ItpPdf> = data?.pdfs ?? [];
  const sends: ReadonlyArray<ItpSend> = data?.sends ?? [];

  function patchReport(fn: (areas: ItpArea[]) => ItpArea[]) {
    setData((prev) =>
      prev ? { ...prev, report: { ...prev.report, areas: fn([...prev.report.areas]) } } : prev
    );
  }
  function patchPdfs(fn: (pdfs: ItpPdf[]) => ItpPdf[]) {
    setData((prev) => (prev ? { ...prev, pdfs: fn([...prev.pdfs]) } : prev));
  }

  const allAreaNames = useMemo(
    () => [...areas.map((a) => a.name), ...localAreas.map((a) => a.name)],
    [areas, localAreas]
  );
  const recentNames = useMemo(
    () => filterRecentNames(data?.recentNames ?? [], allAreaNames),
    [data?.recentNames, allAreaNames]
  );

  // ── Picking photos ──────────────────────────────────────────────────
  /** Open the picker for an area key (server id or local id). Must run
   *  inside a user tap. */
  function openPicker(areaKey: string, source: PhotoSource) {
    pickTarget.current = areaKey;
    const input = source === "roll" ? rollInput.current : cameraInput.current;
    input?.click();
  }

  function onFilesPicked(files: FileList | null) {
    const areaKey = pickTarget.current;
    pickTarget.current = null;
    if (!files || !files.length || !areaKey) return;
    const items: PendingPhoto[] = Array.from(files).map((file) => ({
      localId: nextLocalId("photo"),
      areaId: areaKey,
      file,
      previewUrl: URL.createObjectURL(file),
      state: file.size > PHOTO_MAX_BYTES ? "tooBig" : "waiting",
    }));
    dispatch({ type: "add", items });
  }

  /** Create an area (optimistically) and open the picker in the same tap. */
  function startArea(name: string | null, source: PhotoSource) {
    const clean = (name ?? "").trim() || nextAreaName(allAreaNames);
    const localId = nextLocalId("area");
    setLocalAreas((prev) => [...prev, { localId, name: clean }]);
    setSheet(null);
    setEmptyName("");
    openPicker(localId, source);
    void createArea(localId, clean);
  }

  async function createArea(localId: string, name: string) {
    if (creating.current.has(localId)) return;
    creating.current.add(localId);
    const r = await itpApi(`${base}&action=area`, {
      method: "POST",
      body: JSON.stringify({ reportId, name }),
    });
    creating.current.delete(localId);
    if (!r.ok) {
      setLocalAreas((prev) =>
        prev.map((a) => (a.localId === localId ? { ...a, failed: r.message } : a))
      );
      return;
    }
    const parsed = ItpAreaResponseSchema.safeParse(r.data);
    if (!parsed.success) {
      setLocalAreas((prev) =>
        prev.map((a) =>
          a.localId === localId ? { ...a, failed: "The app couldn't read the reply." } : a
        )
      );
      return;
    }
    const area = parsed.data.area;
    patchReport((list) =>
      list.some((a) => a.id === area.id) ? list : [...list, { ...area, photos: [] }]
    );
    setLocalAreas((prev) => prev.filter((a) => a.localId !== localId));
    dispatch({ type: "reassignArea", from: localId, to: area.id });
    setSheet((s) =>
      s && s.kind === "area" && s.areaKey === localId ? { kind: "area", areaKey: area.id } : s
    );
  }

  // ── Upload driver: one at a time, in order ──────────────────────────
  useEffect(() => {
    const next = nextToSend(queue);
    if (!next) return;
    const local = localAreas.find((a) => a.localId === next.areaId);
    if (local) {
      // Area still being made (or its creation failed → the tiles fail too).
      if (local.failed) {
        for (const i of queue.items) {
          if (i.areaId === local.localId && i.state === "waiting") {
            dispatch({ type: "failed", localId: i.localId, kind: "server", message: local.failed });
          }
        }
      }
      return;
    }
    if (inFlight.current.has(next.localId)) return;
    inFlight.current.add(next.localId);
    dispatch({ type: "start", localId: next.localId });
    (async () => {
      let dataUrl: string;
      try {
        dataUrl = await toUploadDataUrl(next.file);
      } catch {
        dispatch({
          type: "failed",
          localId: next.localId,
          kind: "server",
          message: "Couldn't read the photo",
        });
        inFlight.current.delete(next.localId);
        return;
      }
      const r = await itpApi(`${base}&action=photo`, {
        method: "POST",
        body: JSON.stringify({ areaId: next.areaId, dataUrl }),
      });
      inFlight.current.delete(next.localId);
      if (!r.ok) {
        dispatch({ type: "failed", localId: next.localId, kind: r.kind, message: r.message });
        return;
      }
      const parsed = ItpPhotoResponseSchema.safeParse(r.data);
      if (!parsed.success) {
        dispatch({
          type: "failed",
          localId: next.localId,
          kind: "server",
          message: "The app couldn't read the reply.",
        });
        return;
      }
      const photo = parsed.data.photo;
      patchReport((list) =>
        list.map((a) =>
          a.id === next.areaId && !a.photos.some((p) => p.id === photo.id)
            ? { ...a, photos: [...a.photos, photo] }
            : a
        )
      );
      dispatch({ type: "saved", localId: next.localId });
      URL.revokeObjectURL(next.previewUrl);
    })();
  }, [queue, localAreas, base]);

  function retryItem(item: PendingPhoto) {
    setLocalAreas((prev) =>
      prev.map((a) => (a.localId === item.areaId && a.failed ? { ...a, failed: undefined } : a))
    );
    const local = localAreas.find((a) => a.localId === item.areaId);
    if (local?.failed) void createArea(local.localId, local.name);
    dispatch({ type: "retry", localId: item.localId });
  }
  function retryAll() {
    for (const a of localAreas) {
      if (a.failed) {
        setLocalAreas((prev) =>
          prev.map((x) => (x.localId === a.localId ? { ...x, failed: undefined } : x))
        );
        void createArea(a.localId, a.name);
      }
    }
    dispatch({ type: "retryAll" });
  }

  // ── Leave guard ─────────────────────────────────────────────────────
  const unsaved = summary.unsaved;
  useEffect(() => {
    if (unsaved === 0) return;
    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      const a = target?.closest("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      if (a.target && a.target !== "_self") return;
      const href = a.getAttribute("href") || "";
      if (!href.startsWith("/")) return;
      e.preventDefault();
      e.stopPropagation();
      setLeaveHref(href);
    }
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
    }
    document.addEventListener("click", onClick, true);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [unsaved]);

  // ── Sheet actions ───────────────────────────────────────────────────
  function closeSheet() {
    setSheet(null);
    setArmed(null);
    setSheetError(null);
    setSendError(null);
  }

  async function run<T>(key: string, work: () => Promise<T | null>): Promise<T | null> {
    if (busy) return null;
    setBusy(key);
    setSheetError(null);
    try {
      return await work();
    } finally {
      setBusy(null);
    }
  }

  function fail(r: { kind: "network" | "server"; message: string }, what: string) {
    setSheetError(
      r.kind === "network"
        ? `No signal — ${what} didn't save. Try again when you've got signal.`
        : r.message
    );
  }

  function renameArea(areaKey: string, name: string) {
    const local = localAreas.find((a) => a.localId === areaKey);
    if (local) {
      setLocalAreas((prev) => prev.map((a) => (a.localId === areaKey ? { ...a, name } : a)));
      setSheet(null);
      return;
    }
    void run("area", async () => {
      const r = await itpApi(`${base}&action=area`, {
        method: "PUT",
        body: JSON.stringify({ id: areaKey, name }),
      });
      if (!r.ok) return (fail(r, "the name"), null);
      patchReport((list) => list.map((a) => (a.id === areaKey ? { ...a, name } : a)));
      closeSheet();
      return true;
    });
  }

  function removeArea(areaKey: string) {
    const local = localAreas.find((a) => a.localId === areaKey);
    if (local) {
      setLocalAreas((prev) => prev.filter((a) => a.localId !== areaKey));
      dispatch({ type: "dropArea", areaId: areaKey });
      closeSheet();
      return;
    }
    void run("area", async () => {
      const r = await itpApi(`${base}&action=area`, {
        method: "DELETE",
        body: JSON.stringify({ id: areaKey }),
      });
      if (!r.ok) return (fail(r, "the remove"), null);
      patchReport((list) => list.filter((a) => a.id !== areaKey));
      dispatch({ type: "dropArea", areaId: areaKey });
      closeSheet();
      void load(true);
      return true;
    });
  }

  function saveCaption(photoId: string, areaId: string, caption: string) {
    void run("photo", async () => {
      const r = await itpApi(`${base}&action=photo`, {
        method: "PUT",
        body: JSON.stringify({ id: photoId, caption }),
      });
      if (!r.ok) return (fail(r, "the caption"), null);
      patchReport((list) =>
        list.map((a) =>
          a.id === areaId
            ? { ...a, photos: a.photos.map((p) => (p.id === photoId ? { ...p, caption } : p)) }
            : a
        )
      );
      closeSheet();
      void load(true);
      return true;
    });
  }

  function removePhoto(photoId: string, areaId: string) {
    void run("photo", async () => {
      const r = await itpApi(`${base}&action=photo`, {
        method: "DELETE",
        body: JSON.stringify({ id: photoId }),
      });
      if (!r.ok) return (fail(r, "the remove"), null);
      patchReport((list) =>
        list.map((a) =>
          a.id === areaId ? { ...a, photos: a.photos.filter((p) => p.id !== photoId) } : a
        )
      );
      closeSheet();
      void load(true);
      return true;
    });
  }

  function renameReport(title: string) {
    void run("itp", async () => {
      const r = await itpApi(base, {
        method: "PUT",
        body: JSON.stringify({ id: reportId, title }),
      });
      if (!r.ok) return (fail(r, "the name"), null);
      setData((prev) => (prev ? { ...prev, report: { ...prev.report, title } } : prev));
      closeSheet();
      return true;
    });
  }

  function deleteReport() {
    void run("itp", async () => {
      const r = await itpApi(base, { method: "DELETE", body: JSON.stringify({ id: reportId }) });
      if (!r.ok) return (fail(r, "the delete"), null);
      setDeleted(true);
      closeSheet();
      window.location.assign(`/phil/jobs/${encodeURIComponent(jobId)}/itp-reports`);
      return true;
    });
  }

  function makePdf(input: { areaIds: string[]; name: string | null }) {
    void run("pdf", async () => {
      const r = await itpApi(`${base}&action=pdf`, {
        method: "POST",
        body: JSON.stringify({ reportId, areaIds: input.areaIds, name: input.name }),
      });
      if (!r.ok) return (fail(r, "the PDF"), null);
      const parsed = ItpPdfResponseSchema.safeParse(r.data);
      if (!parsed.success)
        return (setSheetError("The app couldn't read the reply — refresh to check."), null);
      patchPdfs((list) => [parsed.data.pdf, ...list.filter((p) => p.id !== parsed.data.pdf.id)]);
      setSheet({ kind: "send", pdfId: parsed.data.pdf.id });
      return true;
    });
  }

  async function remakePdf(pdfId: string): Promise<ItpPdf | null> {
    const r = await itpApi(`${base}&action=pdf`, {
      method: "POST",
      body: JSON.stringify({ pdfId }),
    });
    if (!r.ok) return (fail(r, "the PDF"), null);
    const parsed = ItpPdfResponseSchema.safeParse(r.data);
    if (!parsed.success)
      return (setSheetError("The app couldn't read the reply — refresh to check."), null);
    patchPdfs((list) => list.map((p) => (p.id === pdfId ? parsed.data.pdf : p)));
    return parsed.data.pdf;
  }

  function makeAgain(pdf: ItpPdf) {
    void run(`pdf:${pdf.id}`, () => remakePdf(pdf.id));
  }

  function renamePdf(pdfId: string, name: string | null) {
    void run(`pdf:${pdfId}`, async () => {
      const r = await itpApi(`${base}&action=pdf`, {
        method: "PUT",
        body: JSON.stringify({ id: pdfId, name }),
      });
      if (!r.ok) return (fail(r, "the name"), null);
      const parsed = ItpPdfResponseSchema.safeParse(r.data);
      if (!parsed.success)
        return (setSheetError("The app couldn't read the reply — refresh to check."), null);
      patchPdfs((list) => list.map((p) => (p.id === pdfId ? parsed.data.pdf : p)));
      setSheet({ kind: "pdfs" });
      return true;
    });
  }

  async function sendPdf(pdfId: string, to: "office" | "email", email?: string, note?: string) {
    const pdf = pdfs.find((p) => p.id === pdfId);
    if (!pdf || sendPhase.kind !== "idle") return;
    setSendError(null);
    setSendPhase(pdf.stale ? { kind: "making", target: to } : { kind: "sending", target: to });
    const r = await itpApi(`${base}&action=send`, {
      method: "POST",
      body: JSON.stringify({ pdfId, to, email, note }),
      timeoutMs: 90000,
    });
    setSendPhase({ kind: "idle" });
    if (!r.ok) {
      const who = to === "office" ? "to the office" : `to ${email}`;
      setSendError(
        r.kind === "network"
          ? {
              title: `Didn't send ${who}`,
              body: "No signal. Nothing's lost — the PDF's still here. Try again when you've got signal.",
              retry: to,
            }
          : {
              title: `Didn't send ${who}`,
              body: r.message,
              retry: to,
            }
      );
      void load(true);
      return;
    }
    const parsed = ItpSendResponseSchema.safeParse(r.data);
    if (!parsed.success) {
      setSendError({
        title: "Sent, but the app couldn't read the reply",
        body: "Refresh to check.",
        retry: null,
      });
      return;
    }
    setData((prev) =>
      prev
        ? {
            ...prev,
            pdfs: prev.pdfs.map((p) => (p.id === pdfId ? parsed.data.pdf : p)),
            sends: [parsed.data.send, ...prev.sends],
            emailSuggestions:
              to === "email" && email && !prev.emailSuggestions.includes(email)
                ? [email, ...prev.emailSuggestions]
                : prev.emailSuggestions,
          }
        : prev
    );
    closeSheet();
  }

  async function savePdfToPhone(pdfId: string) {
    let pdf = pdfs.find((p) => p.id === pdfId);
    if (!pdf || sendPhase.kind !== "idle") return;
    setSendError(null);
    if (pdf.stale) {
      setSendPhase({ kind: "saving" });
      const remade = await remakePdf(pdf.id);
      setSendPhase({ kind: "idle" });
      if (!remade) {
        setSendError({
          title: "Couldn't make the PDF again",
          body: sheetError ?? "Try again.",
          retry: null,
        });
        return;
      }
      pdf = remade;
    }
    try {
      const res = await fetch(pdf.url);
      const blob = await res.blob();
      const file = new File([blob], `${pdf.name.replace(/[^\w\- ]+/g, "").trim() || "ITP"}.pdf`, {
        type: "application/pdf",
      });
      const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
      if (nav.share && nav.canShare?.({ files: [file] })) {
        await nav.share({ files: [file], title: pdf.name });
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setSendError({
        title: "Couldn't save the PDF",
        body: "Open it instead and use your phone's share button.",
        retry: null,
      });
    }
  }

  // ── Render ──────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="space-y-3">
        <PhilSkeletonCard />
        <PhilSkeletonCard />
      </div>
    );
  }

  if (!report || loadError) {
    return (
      <PhilNotice tone="danger" title="Couldn't open this ITP" role="alert">
        <p>
          {loadError ??
            "Check you've got signal, then try again. Photos that already saved are safe."}
        </p>
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            void load();
          }}
          className="mt-2 inline-flex min-h-[44px] items-center font-display text-[16px] font-bold text-state-info"
        >
          Try again
        </button>
      </PhilNotice>
    );
  }

  const savedPhotoCount = areas.reduce((n, a) => n + a.photos.length, 0);
  const areaCount = areas.length + localAreas.length;
  const empty = areaCount === 0 && queue.items.length === 0;
  const badge = builderBadge(
    pdfs,
    (() => {
      const s = lastSuccessfulSend(sends);
      return s ? { kind: s.kind, sentAt: s.sentAt } : null;
    })()
  );
  const blocker = pendingBlocker({
    waitingOrSaving: summary.waiting + summary.saving,
    failed: summary.failed + summary.notSent,
  });
  const capHint = photoCapHint(savedPhotoCount + summary.waiting + summary.saving);

  // View model: server areas, then local ones not yet on the server.
  const cards: Array<{
    key: string;
    id: string | null;
    name: string;
    photos: ItpPhoto[];
    pending: PendingPhoto[];
    failed?: string;
  }> = [
    ...areas.map((a) => ({
      key: a.id,
      id: a.id,
      name: a.name,
      photos: a.photos,
      pending: queue.items.filter((i) => i.areaId === a.id),
    })),
    ...localAreas.map((a) => ({
      key: a.localId,
      id: null,
      name: a.name,
      photos: [],
      pending: queue.items.filter((i) => i.areaId === a.localId),
      failed: a.failed,
    })),
  ];

  const sheetArea =
    sheet?.kind === "area" ? (cards.find((c) => c.key === sheet.areaKey) ?? null) : null;
  const sheetPhoto =
    sheet?.kind === "photo"
      ? (() => {
          const a = areas.find((x) => x.id === sheet.areaId);
          const idx = a ? a.photos.findIndex((p) => p.id === sheet.photoId) : -1;
          return a && idx >= 0
            ? { area: a, photo: a.photos[idx]!, index: idx + 1, total: a.photos.length }
            : null;
        })()
      : null;
  const sheetPdf =
    sheet?.kind === "send" || sheet?.kind === "renamePdf"
      ? (pdfs.find((p) => p.id === sheet.pdfId) ?? null)
      : null;

  const areaNamesFor = (pdf: ItpPdf) =>
    pdf.areaIds
      .map((id) => areas.find((a) => a.id === id)?.name)
      .filter((n): n is string => !!n)
      .join(", ");

  const statusAction =
    summary.notSent > 0 ? (
      <ItpTextButton onClick={retryAll}>Retry all</ItpTextButton>
    ) : pdfs.length ? (
      <ItpSecondaryButton size="sm" disabled={!!blocker} onClick={() => setSheet({ kind: "pdfs" })}>
        PDFs · {pdfs.length}
      </ItpSecondaryButton>
    ) : (
      <ItpSecondaryButton
        size="sm"
        disabled={!!blocker || savedPhotoCount === 0}
        onClick={() => setSheet({ kind: "makePdf" })}
      >
        Make the PDF
      </ItpSecondaryButton>
    );

  const status = (
    <>
      {summary.notSent > 0 ? (
        <ItpBadge tone="warning" key="notsent" className={styles.badgeIn}>
          {plural(summary.notSent, "photo", "photos")} not sent
        </ItpBadge>
      ) : null}
      {summary.failed > 0 ? (
        <ItpBadge tone="danger" key="failed" className={styles.badgeIn}>
          {plural(summary.failed, "photo", "photos")} didn&rsquo;t save
        </ItpBadge>
      ) : null}
      {summary.tooBig > 0 ? (
        <ItpBadge tone="warning" key="toobig" className={styles.badgeIn}>
          {plural(summary.tooBig, "photo", "photos")} over 8 MB
        </ItpBadge>
      ) : null}
      {summary.savingLabel ? (
        <ItpBadge tone="info" key="saving" className={styles.badgeIn}>
          {summary.savingLabel}
        </ItpBadge>
      ) : null}
      {summary.notSent === 0 && summary.failed === 0 && !summary.savingLabel ? (
        <ItpBadge tone={badge.tone} key={badge.label} className={styles.badgeIn}>
          {savedPhotoCount === 0 && !pdfs.length ? "Take a photo first." : badge.label}
        </ItpBadge>
      ) : null}
      {blocker && summary.notSent === 0 && summary.failed === 0 ? (
        <span className="text-[14px] font-semibold text-text-muted">{blocker}</span>
      ) : null}
    </>
  );

  return (
    <div className="flex min-h-full flex-col gap-3" data-testid="itp-builder">
      {/* Hidden pickers: camera, and the camera roll (no capture). */}
      <input
        ref={cameraInput}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          onFilesPicked(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={rollInput}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          onFilesPicked(e.target.files);
          e.target.value = "";
        }}
      />

      {summary.notSent > 0 ? (
        <PhilSyncBanner
          state="offline"
          detail={`No signal. ${plural(summary.notSent, "photo is", "photos are")} still on this phone — keep this screen open.`}
        />
      ) : null}

      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={() => setSheet({ kind: "itp" })}
          aria-label={`${report.title} — rename or delete this ITP`}
          className="flex min-h-[44px] min-w-0 items-center gap-2 text-left focus-visible:outline-brand-navy"
        >
          <h1 className="line-clamp-2 break-words font-display text-[24px] font-extrabold leading-tight tracking-tight text-text">
            {report.title}
          </h1>
          <Pencil aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
        </button>
      </div>
      <p className="-mt-2 text-[16px] text-text-muted">
        {savedPhotoCount === 0 && summary.unsaved === 0
          ? "No photos yet"
          : countsLine(areaCount, savedPhotoCount + summary.unsaved)}
      </p>

      {empty ? (
        <section className="space-y-3 rounded-card border border-border bg-surface p-4">
          <h2 className="font-display text-[18px] font-bold">Where are you?</h2>
          <ItpSegmented value={emptySource} onChange={setEmptySource} />
          {recentNames.length ? (
            <div>
              <ItpLabel className="mb-2">Recent names</ItpLabel>
              <div className="flex flex-wrap gap-2">
                {recentNames.map((n) => (
                  <ItpChip key={n} onClick={() => startArea(n, emptySource)}>
                    {n}
                  </ItpChip>
                ))}
              </div>
            </div>
          ) : null}
          <div className="space-y-2">
            <ItpLabel htmlFor={emptyNameId}>
              {recentNames.length ? "Something else" : "Area name"}
            </ItpLabel>
            <ItpInput
              id={emptyNameId}
              ref={emptyNameRef}
              value={emptyName}
              maxLength={120}
              placeholder="Say or type a name"
              onChange={(e) => setEmptyName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && emptyName.trim()) startArea(emptyName, emptySource);
              }}
            />
            <PhilDictateButton
              value={emptyName}
              onAppend={setEmptyName}
              max={120}
              onFocusField={() => emptyNameRef.current?.focus()}
            />
            {emptyName.trim() ? (
              <ItpSecondaryButton onClick={() => startArea(emptyName, emptySource)}>
                Add area
              </ItpSecondaryButton>
            ) : (
              <p className="text-[14px] font-semibold text-text-muted">Tap a name to start.</p>
            )}
          </div>
        </section>
      ) : null}

      {cards.map((card) => {
        const total = card.photos.length + card.pending.length;
        return (
          <section
            key={card.key}
            className="rounded-card border border-border bg-surface p-4"
            data-testid="itp-area-card"
          >
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => {
                  setArmed(null);
                  setSheet({ kind: "area", areaKey: card.key });
                }}
                className="flex min-h-[44px] min-w-0 flex-1 items-center gap-1 text-left focus-visible:outline-brand-navy"
              >
                <span className="line-clamp-2 break-words font-display text-[18px] font-bold text-text">
                  {card.name}
                </span>
                <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
              </button>
              <ItpSecondaryButton
                size="sm"
                aria-label={`Photos — add to ${card.name}`}
                onClick={() => openPicker(card.key, "camera")}
              >
                <Camera aria-hidden="true" className="h-5 w-5" />
                Photos
              </ItpSecondaryButton>
            </div>
            {card.failed ? (
              <p
                className="mt-2 text-[14px] font-semibold text-state-danger-subtle-text"
                role="status"
              >
                {card.name} didn&rsquo;t save — Retry a photo to try again.
              </p>
            ) : null}
            {total ? (
              <ul className="mt-3 grid grid-cols-3 gap-2">
                {card.photos.map((p, i) => (
                  <li key={p.id}>
                    <ItpSavedTile
                      photo={p}
                      index={i + 1}
                      total={total}
                      areaName={card.name}
                      onOpen={() => {
                        setArmed(null);
                        if (card.id) setSheet({ kind: "photo", areaId: card.id, photoId: p.id });
                      }}
                    />
                  </li>
                ))}
                {card.pending.map((item, i) => (
                  <li key={item.localId}>
                    <ItpPendingTile
                      item={item}
                      index={card.photos.length + i + 1}
                      total={total}
                      areaName={card.name}
                      onRetry={() => retryItem(item)}
                      onClear={() => dispatch({ type: "clear", localId: item.localId })}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        );
      })}

      <ItpDock
        testId="itp-builder-dock"
        status={empty ? undefined : status}
        statusAction={empty ? undefined : statusAction}
        hint={capHint}
        primary={
          empty ? (
            <>
              <ItpPrimaryButton onClick={() => startArea(null, "camera")}>
                <span className="flex flex-col items-center leading-tight">
                  <span>Just take photos</span>
                  <span className="text-[14px] font-semibold opacity-85">Name the area later</span>
                </span>
              </ItpPrimaryButton>
              <div className="flex justify-center">
                <ItpTextButton onClick={() => startArea(null, "roll")}>
                  or pick from camera roll
                </ItpTextButton>
              </div>
            </>
          ) : (
            <ItpPrimaryButton
              onClick={() => {
                setArmed(null);
                setSheet({ kind: "newArea" });
              }}
            >
              New area
            </ItpPrimaryButton>
          )
        }
      />

      {/* ── Sheets ─────────────────────────────────────────────────── */}
      <ItpNewAreaSheet
        open={sheet?.kind === "newArea"}
        onClose={closeSheet}
        recentNames={recentNames}
        onPick={startArea}
      />
      <ItpAreaSheet
        open={sheet?.kind === "area" && !!sheetArea}
        onClose={closeSheet}
        area={
          sheetArea
            ? {
                id: sheetArea.key,
                name: sheetArea.name,
                photoCount: sheetArea.photos.length + sheetArea.pending.length,
              }
            : null
        }
        busy={busy === "area"}
        armed={armed === `area:${sheetArea?.key}`}
        onArm={() => setArmed(`area:${sheetArea?.key}`)}
        onKeep={() => setArmed(null)}
        onAddFromRoll={() => {
          if (!sheetArea) return;
          setSheet(null);
          openPicker(sheetArea.key, "roll");
        }}
        onRename={(name) => sheetArea && renameArea(sheetArea.key, name)}
        onRemove={() => sheetArea && removeArea(sheetArea.key)}
      />
      <ItpPhotoSheet
        open={sheet?.kind === "photo" && !!sheetPhoto}
        onClose={closeSheet}
        photo={sheetPhoto?.photo ?? null}
        areaName={sheetPhoto?.area.name ?? ""}
        index={sheetPhoto?.index ?? 0}
        total={sheetPhoto?.total ?? 0}
        busy={busy === "photo"}
        armed={armed === `photo:${sheetPhoto?.photo.id}`}
        onArm={() => setArmed(`photo:${sheetPhoto?.photo.id}`)}
        onKeep={() => setArmed(null)}
        onSaveCaption={(caption) =>
          sheetPhoto && saveCaption(sheetPhoto.photo.id, sheetPhoto.area.id, caption)
        }
        onRemove={() => sheetPhoto && removePhoto(sheetPhoto.photo.id, sheetPhoto.area.id)}
      />
      <ItpReportSheet
        open={sheet?.kind === "itp" && !deleted}
        onClose={closeSheet}
        title={report.title}
        areaCount={areaCount}
        photoCount={savedPhotoCount}
        sends={sends}
        busy={busy === "itp"}
        armed={armed === "itp"}
        onArm={() => setArmed("itp")}
        onKeep={() => setArmed(null)}
        onRename={renameReport}
        onDelete={deleteReport}
      />
      <ItpMakePdfSheet
        open={sheet?.kind === "makePdf"}
        onClose={closeSheet}
        areas={areas.map((a) => ({ id: a.id, name: a.name, photoCount: a.photos.length }))}
        busy={busy === "pdf"}
        error={sheet?.kind === "makePdf" ? sheetError : null}
        onMake={makePdf}
      />
      <ItpPdfsSheet
        open={sheet?.kind === "pdfs"}
        onClose={closeSheet}
        pdfs={pdfs}
        sends={sends}
        areaNamesFor={areaNamesFor}
        busyPdfId={busy?.startsWith("pdf:") ? busy.slice(4) : null}
        sendBlocker={blocker}
        error={sheet?.kind === "pdfs" ? sheetError : null}
        onRename={(pdf) => setSheet({ kind: "renamePdf", pdfId: pdf.id })}
        onSend={(pdf) => {
          setSendError(null);
          setSheet({ kind: "send", pdfId: pdf.id });
        }}
        onMakeAgain={makeAgain}
        onMakeAnother={() => setSheet({ kind: "makePdf" })}
      />
      <ItpRenamePdfSheet
        open={sheet?.kind === "renamePdf" && !!sheetPdf}
        onClose={closeSheet}
        onBack={() => setSheet({ kind: "pdfs" })}
        pdf={sheetPdf}
        busy={!!sheetPdf && busy === `pdf:${sheetPdf.id}`}
        error={sheet?.kind === "renamePdf" ? sheetError : null}
        onSave={(name) => sheetPdf && renamePdf(sheetPdf.id, name)}
      />
      <ItpSendSheet
        open={sheet?.kind === "send" && !!sheetPdf}
        onClose={() => {
          if (sendPhase.kind !== "idle") return;
          closeSheet();
        }}
        pdf={sheetPdf}
        officeEmail={data?.officeEmail ?? null}
        emailSuggestions={data?.emailSuggestions ?? []}
        blocker={blocker}
        phase={sendPhase}
        error={sendError}
        onSendOffice={() => sheetPdf && void sendPdf(sheetPdf.id, "office")}
        onSendEmail={(email, note) => sheetPdf && void sendPdf(sheetPdf.id, "email", email, note)}
        onSave={() => sheetPdf && void savePdfToPhone(sheetPdf.id)}
      />
      <ItpLeaveGuard
        open={leaveHref !== null}
        count={unsaved}
        onStay={() => setLeaveHref(null)}
        onLeave={() => {
          const href = leaveHref;
          setLeaveHref(null);
          if (href) window.location.assign(href);
        }}
      />
    </div>
  );
}
