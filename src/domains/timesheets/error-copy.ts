/**
 * Worker-facing copy for a failed hours write (log / change / fix / split).
 *
 * The API refuses with a one-line `error` string written for the office and
 * for logs ("cannot log more than 14 days in the past", "forbidden — hours can
 * only be logged against a job that is live or finished…"). The field sees
 * those sentences through src/lib/http.ts; this module turns the ones a tired
 * worker will actually hit into site language (P11) and decides whether
 * "trying again is safe" is TRUE for that failure (P7 — a 400 is not a signal
 * problem, and retrying an identical 400 changes nothing).
 *
 * Pure: unit-tested without a DOM.
 */

export type HoursWriteFailure = {
  /** HTTP status, 0 for a network / timeout failure. */
  status: number;
  /** The message src/lib/http.ts produced (server `error` text when it sent one). */
  message: string;
  /** Network-layer class, when status is 0. */
  kind?: "timeout" | "network";
};

export type HoursWriteFailureCopy = {
  /** One plain sentence saying what went wrong. */
  message: string;
  /** True only when a retry can genuinely succeed (signal / server blip) —
   *  the notice then adds the "trying again is safe" line. */
  retrySafe: boolean;
};

function lower(s: string): string {
  return s.toLowerCase();
}

export function hoursWriteFailureCopy(
  failure: HoursWriteFailure,
  fallback = "Couldn’t save your hours. Try again in a moment."
): HoursWriteFailureCopy {
  const status = failure.status || 0;
  const raw = failure.message || "";
  const m = lower(raw);

  if (status === 0) {
    // http.ts already wrote the honest signal copy for bounded field writes.
    return {
      message: raw || "Couldn’t reach the office. Try again when you’ve got signal.",
      retrySafe: true,
    };
  }
  if (status >= 500) {
    return { message: "The office server had a problem and nothing was saved.", retrySafe: true };
  }
  if (status === 401) {
    return { message: "Your sign-in has expired. Sign in again to log hours.", retrySafe: false };
  }
  if (m.includes("14 days") || m.includes("in the past")) {
    return {
      message: "That day is more than two weeks back — the office can add it for you.",
      retrySafe: false,
    };
  }
  if (m.includes("future")) {
    return {
      message: "That day hasn’t happened yet — pick today or an earlier day.",
      retrySafe: false,
    };
  }
  if (m.includes("already exists")) {
    return {
      message: "That day already has hours logged — open it in the week list to change it.",
      retrySafe: false,
    };
  }
  if (m.includes("exported")) {
    return {
      message: "That day has already gone to payroll — ask the office if it needs changing.",
      retrySafe: false,
    };
  }
  if (m.includes("approved")) {
    return {
      message: "That day is already approved — ask the office if it needs changing.",
      retrySafe: false,
    };
  }
  if (status === 403 && (m.includes("job") || m.includes("archived") || m.includes("draft"))) {
    return {
      message:
        "That job is closed or not live yet — pick another job, or ask the office to reopen it.",
      retrySafe: false,
    };
  }
  if (m.includes("must sum") || m.includes("allocation")) {
    return {
      message: "The split doesn’t add up to the day’s total — check the hours per job.",
      retrySafe: false,
    };
  }
  if (status === 403) {
    return { message: "You can’t change this day from here — ask the office.", retrySafe: false };
  }
  if (status === 404) {
    return { message: "That day isn’t here anymore. Pull to refresh.", retrySafe: false };
  }
  if (status === 409) {
    return {
      message: "Someone changed this day while you were editing. Pull to refresh and try again.",
      retrySafe: false,
    };
  }
  // Any other 4xx: the server's sentence is the best truth we have.
  return { message: raw || fallback, retrySafe: false };
}
