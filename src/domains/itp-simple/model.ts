import type { ItpPdf, ItpReportSummary } from "./schema";

/**
 * ITP builder — pure client model (handoff 2026-11-02). Every string the
 * worker reads that depends on data is made here so it's unit-tested and
 * identical across the list, the builder dock and the sheets. No DOM.
 *
 * The rule behind all of it: never show a state the app can't know.
 */

export const PDF_PHOTO_CAP = 120;
/** From this many photos the dock starts counting towards the PDF cap. */
export const PDF_CAP_WARN_FROM = 100;
export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "4 areas · 12 photos" */
export function countsLine(areaCount: number, photoCount: number): string {
  return `${plural(areaCount, "area", "areas")} · ${plural(photoCount, "photo", "photos")}`;
}

/** `ITP · Fri 30 Oct` — in the DEVICE timezone (the date the worker sees). */
export function datedItpTitle(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `ITP · ${get("weekday")} ${get("day")} ${get("month")}`.replace(/\s+/g, " ").trim();
}

/** "3 Oct" */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short" }).format(new Date(t));
}

/** "8:42 am" */
export function shortTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit" })
    .format(new Date(t))
    .toLowerCase();
}

/** Today → "8:42 am"; otherwise "2 Nov 8:41 am". */
export function shortWhen(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? shortTime(iso) : `${shortDate(iso)} ${shortTime(iso)}`;
}

/** "2 Nov 8:41 am" — always with the date (the PDFs list). */
export function madeWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  return `${shortDate(iso)} ${shortTime(iso)}`.trim();
}

/**
 * The placeholder name for an area taken without one: `Area {n}` where n is
 * the next number NOT in use in this ITP — so two areas are never both
 * "Area 3" after a delete.
 */
export function nextAreaName(existingNames: ReadonlyArray<string>): string {
  const used = new Set<number>();
  for (const n of existingNames) {
    const m = /^Area (\d+)$/i.exec(n.trim());
    if (m) used.add(Number(m[1]));
  }
  let n = 1;
  while (used.has(n)) n += 1;
  return `Area ${n}`;
}

/** Recent-name chips: drop names already in this ITP (case-insensitive),
 *  keep first occurrence order. */
export function filterRecentNames(
  names: ReadonlyArray<string>,
  takenNames: ReadonlyArray<string>
): string[] {
  const taken = new Set(takenNames.map((n) => n.trim().toLowerCase()));
  const out: string[] = [];
  for (const raw of names) {
    const n = raw.trim();
    const key = n.toLowerCase();
    if (!n || taken.has(key)) continue;
    taken.add(key);
    out.push(n);
  }
  return out;
}

/** "All areas" when every area is ticked, else the ticked names. Mirrors
 *  the server (api/_lib/itp-simple-model.js). */
export function defaultPdfName(
  selected: ReadonlyArray<{ name: string }>,
  totalAreaCount: number
): string {
  if (!selected.length || selected.length >= totalAreaCount) return "All areas";
  const joined = selected
    .map((a) => a.name.trim())
    .filter(Boolean)
    .join(", ");
  if (!joined) return "All areas";
  return joined.length > 120 ? `${joined.slice(0, 119).trimEnd()}…` : joined;
}

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";
export interface Badge {
  label: string;
  tone: BadgeTone;
}

/**
 * The one PDF badge, by priority: any PDF out of date › last send › last
 * made › no PDF yet. `when` decides how a timestamp reads (date on the list,
 * time-if-today in the dock).
 */
export function pdfBadge(
  input: {
    staleCount: number;
    lastSend: { kind: "office" | "email"; sentAt: string } | null;
    lastMadeAt: string | null;
  },
  when: (iso: string) => string = shortDate
): Badge {
  if (input.staleCount > 0) {
    return {
      label: input.staleCount === 1 ? "PDF out of date" : `${input.staleCount} PDFs out of date`,
      tone: "warning",
    };
  }
  if (input.lastSend) {
    const stamp = when(input.lastSend.sentAt);
    return {
      label:
        input.lastSend.kind === "office"
          ? `Sent to office ${stamp}`.trim()
          : `Sent ${stamp}`.trim(),
      tone: "success",
    };
  }
  if (input.lastMadeAt) {
    return { label: `PDF made ${when(input.lastMadeAt)}`.trim(), tone: "success" };
  }
  return { label: "No PDF yet", tone: "neutral" };
}

export function listBadge(r: ItpReportSummary): Badge {
  return pdfBadge({ staleCount: r.staleCount, lastSend: r.lastSend, lastMadeAt: r.lastMadeAt });
}

/** Builder dock badge from the live PDFs + sends. */
export function builderBadge(
  pdfs: ReadonlyArray<ItpPdf>,
  lastSend: { kind: "office" | "email"; sentAt: string } | null,
  now: Date = new Date()
): Badge {
  const staleCount = pdfs.filter((p) => p.stale).length;
  const lastMadeAt = pdfs.length ? pdfs[0]!.madeAt : null;
  return pdfBadge({ staleCount, lastSend, lastMadeAt }, (iso) => shortWhen(iso, now));
}

/** Per-PDF badge in the PDFs sheet. */
export function pdfRowBadge(
  pdf: ItpPdf,
  lastSend: { kind: "office" | "email"; sentAt: string } | null,
  now: Date = new Date()
): Badge {
  if (pdf.stale) return { label: "Out of date", tone: "warning" };
  if (lastSend) {
    const stamp = shortWhen(lastSend.sentAt, now);
    return {
      label: lastSend.kind === "office" ? `Sent to office ${stamp}` : `Sent ${stamp}`,
      tone: "success",
    };
  }
  return { label: "Not sent", tone: "warning" };
}

/** From 100 photos the dock counts towards the one-PDF cap. */
export function photoCapHint(totalPhotos: number): string | null {
  if (totalPhotos < PDF_CAP_WARN_FROM) return null;
  return `${totalPhotos} of ${PDF_PHOTO_CAP} photos — one PDF holds ${PDF_PHOTO_CAP}`;
}

/**
 * Why Make PDF is greyed in the Make-a-PDF sheet, or null when it can go.
 */
export function makePdfBlocker(
  selected: ReadonlyArray<{ name: string; photoCount: number }>
): string | null {
  if (!selected.length) return "Tick at least one area.";
  const big = selected.find((a) => a.photoCount > PDF_PHOTO_CAP);
  if (big) {
    return `${big.name} has ${big.photoCount} photos — one PDF holds ${PDF_PHOTO_CAP}. Remove some from ${big.name}.`;
  }
  const total = selected.reduce((n, a) => n + a.photoCount, 0);
  if (total > PDF_PHOTO_CAP) {
    return `${total} photos — one PDF holds ${PDF_PHOTO_CAP}. Untick some areas. Make a second PDF for the rest.`;
  }
  return null;
}

/** Why Send / Make the PDF is greyed while photos are pending or failed. */
export function pendingBlocker(input: { waitingOrSaving: number; failed: number }): string | null {
  if (input.failed > 0) {
    return `${plural(input.failed, "photo", "photos")} didn't save — Retry or remove ${
      input.failed === 1 ? "it" : "them"
    } first.`;
  }
  if (input.waitingOrSaving > 0) {
    return `Waiting on ${plural(input.waitingOrSaving, "photo", "photos")}`;
  }
  return null;
}

export function isEmailAddress(s: string): boolean {
  const v = s.trim();
  if (v.length < 6 || v.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

/** The last successful send across a report's sends, newest first input. */
export function lastSuccessfulSend<T extends { result: "sent" | "failed"; sentAt: string }>(
  sends: ReadonlyArray<T>
): T | null {
  let best: T | null = null;
  for (const s of sends) {
    if (s.result !== "sent") continue;
    if (!best || Date.parse(s.sentAt) > Date.parse(best.sentAt)) best = s;
  }
  return best;
}
