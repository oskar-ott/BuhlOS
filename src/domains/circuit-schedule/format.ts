import type { Board, InstallState } from "./schema";

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

/* ── field install state (Phil) ─────────────────────────────────────────── */

/** Site-language label for a way's install state (P11). */
export const INSTALL_LABELS: Record<InstallState, string> = {
  todo: "To do",
  installed: "Installed",
  tested: "Tested",
};

/** Narrow a stored install value to a known state (default "todo"). */
export function installState(value: string | undefined): InstallState {
  return value === "installed" || value === "tested" ? value : "todo";
}

export interface BoardProgress {
  /** Circuits on the board (a board's "ways" that are filled). */
  total: number;
  /** Installed or beyond (installed + tested). */
  installed: number;
  /** Tested. */
  tested: number;
  /** Still to do. */
  todo: number;
}

/** Loose board shapes — enough to read install progress without coupling to the
 *  full Board type (a real Board satisfies these; so does a passthrough Job
 *  projection). */
type ProgressBoard = { circuits: ReadonlyArray<{ install?: string }> };
type LooseBoard = { circuits?: ReadonlyArray<{ install?: string }> };

/** Real install progress for a board — counts, never a fabricated percent. */
export function boardProgress(board: ProgressBoard): BoardProgress {
  let installed = 0;
  let tested = 0;
  for (const c of board.circuits) {
    const s = installState(c.install);
    if (s === "tested") { tested += 1; installed += 1; }
    else if (s === "installed") { installed += 1; }
  }
  const total = board.circuits.length;
  return { total, installed, tested, todo: total - installed };
}

/** Compact honest progress caption, e.g. "8/12 installed · 3 tested". */
export function boardProgressLine(board: ProgressBoard): string {
  const p = boardProgress(board);
  if (p.total === 0) return "No ways yet";
  const tested = p.tested > 0 ? ` · ${p.tested} tested` : "";
  return `${p.installed}/${p.total} installed${tested}`;
}

export interface ScheduleSummary {
  boards: number;
  ways: number;
  installed: number;
  tested: number;
}

/** Whole-schedule rollup for a job — real counts for the Phil entry card. */
export function scheduleSummary(boards: ReadonlyArray<LooseBoard> | undefined): ScheduleSummary {
  let ways = 0;
  let installed = 0;
  let tested = 0;
  for (const b of boards ?? []) {
    for (const c of b.circuits ?? []) {
      ways += 1;
      const s = installState(c.install);
      if (s === "tested") { tested += 1; installed += 1; }
      else if (s === "installed") { installed += 1; }
    }
  }
  return { boards: (boards ?? []).length, ways, installed, tested };
}

/** One-line schedule summary for the job entry, e.g. "2 boards · 8/24 ways installed". */
export function scheduleSummaryLine(boards: ReadonlyArray<LooseBoard> | undefined): string {
  const s = scheduleSummary(boards);
  if (s.boards === 0) return "No boards yet";
  const boardWord = s.boards === 1 ? "board" : "boards";
  if (s.ways === 0) return `${s.boards} ${boardWord} · no ways yet`;
  return `${s.boards} ${boardWord} · ${s.installed}/${s.ways} ways installed`;
}
