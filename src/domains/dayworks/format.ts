import type { Daywork, DayworkStatus } from "./types";

/** Display helpers for the daywork register — pure, no state. Site language
 *  (P11): plain words a supervisor and a worker both read. */

export function dayworkStatusLabel(status: DayworkStatus): string {
  switch (status) {
    case "unsigned":
      return "Unsigned";
    case "signed":
      return "Signed";
    case "invoiced":
      return "Invoiced";
  }
}

/** Total labour hours on a docket. */
export function dayworkLabourHours(docket: Pick<Daywork, "labourLines">): number {
  return docket.labourLines.reduce((sum, l) => sum + l.hours, 0);
}

/** A one-line summary of who/what for a register row. */
export function dayworkLineSummary(docket: Pick<Daywork, "labourLines" | "materialLines">): string {
  const hours = dayworkLabourHours(docket);
  const parts: string[] = [];
  if (docket.labourLines.length > 0) parts.push(`${hours}h labour`);
  if (docket.materialLines.length > 0) parts.push(`${docket.materialLines.length} material lines`);
  return parts.join(" · ") || "No lines";
}
