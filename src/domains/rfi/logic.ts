import type { Rfi, RfiStatus } from "./schema";

/** Pure RFI lifecycle logic (#276). No IO. */

/** Next sequential reference, e.g. "RFI-001". Robust to gaps + malformed refs. */
export function nextReference(existing: Pick<Rfi, "ref">[]): string {
  let max = 0;
  for (const r of existing) {
    const m = /(\d+)\s*$/.exec(r.ref || "");
    if (m) max = Math.max(max, parseInt(m[1]!, 10));
  }
  return `RFI-${String(max + 1).padStart(3, "0")}`;
}

const dateOf = (iso: string) => String(iso || "").slice(0, 10);

/** Overdue = still awaiting an answer (open/sent) AND a past response-due date. */
export function isOverdue(rfi: Pick<Rfi, "status" | "responseDue">, today: string): boolean {
  if (rfi.status === "answered" || rfi.status === "closed") return false;
  const due = dateOf(rfi.responseDue);
  return Boolean(due) && due < dateOf(today);
}

const STATUS_ORDER: Record<RfiStatus, number> = { open: 1, sent: 1, answered: 2, closed: 3 };

/**
 * Register order: overdue first (most-overdue first), then open/sent, then
 * answered, then closed; ties broken by newest-created. Pure + stable; does not
 * mutate the input.
 */
export function sortForRegister<T extends Pick<Rfi, "status" | "responseDue" | "createdAt">>(
  rfis: T[],
  today: string
): T[] {
  return [...rfis].sort((a, b) => {
    const ao = isOverdue(a, today);
    const bo = isOverdue(b, today);
    if (ao !== bo) return ao ? -1 : 1;
    if (ao && bo) {
      const ad = dateOf(a.responseDue);
      const bd = dateOf(b.responseDue);
      if (ad !== bd) return ad < bd ? -1 : 1; // most overdue first
    }
    const sa = STATUS_ORDER[a.status];
    const sb = STATUS_ORDER[b.status];
    if (sa !== sb) return sa - sb;
    return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
  });
}

/** The register's lifecycle — which status moves are legal. */
const TRANSITIONS: Record<RfiStatus, RfiStatus[]> = {
  open: ["sent", "answered", "closed"],
  sent: ["answered", "closed"],
  answered: ["closed"],
  closed: [],
};
export function canTransition(from: RfiStatus, to: RfiStatus): boolean {
  return (TRANSITIONS[from] || []).includes(to);
}
