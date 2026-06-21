import type { Board } from "./schema";

/**
 * Display helpers for the circuit schedule. PURE — no I/O, no React.
 *
 * The server stamps `board.updated` with an ISO timestamp + `board.updatedBy`
 * on every content change. The UI wants a compact "edited" line. We format the
 * ISO defensively: anything that doesn't parse as a date (e.g. the sample
 * boards' pre-formatted strings, or an empty value) is passed through as-is, so
 * the same components render real and sample data without branching.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Today · 14:20" / "12 Jun · 16:40" from an ISO string; pass-through otherwise. */
export function formatEditedAt(value: string | undefined, now: Date = new Date()): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value; // not ISO — sample/legacy string
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const day = sameDay ? "Today" : `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return `${day} · ${hh}:${mm}`;
}

/** The one-line "edited" caption a board card / header shows. */
export function boardEditedLine(board: Pick<Board, "updated" | "updatedBy">, now?: Date): string {
  const when = formatEditedAt(board.updated, now);
  const who = board.updatedBy && board.updatedBy !== "—" ? board.updatedBy : "";
  if (when && who) return `${when} · ${who}`;
  return when || who;
}
