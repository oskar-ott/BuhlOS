import type { HttpError, HttpResult } from "@/lib/http";
import { explainHoursProblem, type HoursAction, type HoursProblem } from "./problem";
import type {
  CreateTimeEntryPayload,
  PatchTimeEntryPayload,
  TimeEntry,
  TimeEntryListResponse,
  TimeEntryMutationResponse,
} from "./types";

/**
 * Sending one day from the Hours screen, and trying again after no answer —
 * as pure async orchestration over an injected client, so the "never send
 * twice" rule is pinned by a test with a fake wire (hours-save.test.ts).
 *
 * The rule (docs/phil-hours.md): a save that gets no answer (timeout) is
 * "Not confirmed". Try again RE-READS the day first and only resends when the
 * day isn't there. Every attempt of the same submission carries the same
 * Idempotency-Key, so even a resend the server already applied replays the
 * original result instead of writing a second entry.
 */

export interface SaveWire {
  create(
    payload: CreateTimeEntryPayload,
    idempotencyKey: string
  ): Promise<HttpResult<TimeEntryMutationResponse>>;
  patch(
    date: string,
    payload: PatchTimeEntryPayload,
    idempotencyKey: string
  ): Promise<HttpResult<TimeEntryMutationResponse>>;
  /** The worker's own entries for exactly one day. */
  readDay(date: string): Promise<HttpResult<TimeEntryListResponse>>;
}

export type SaveAttempt =
  | {
      mode: "create";
      date: string;
      payload: CreateTimeEntryPayload;
      key: string;
      action: HoursAction;
    }
  | {
      mode: "patch";
      date: string;
      payload: PatchTimeEntryPayload;
      key: string;
      action: HoursAction;
    };

export type SaveOutcome =
  /** The server confirmed it — `entry` is the server's own copy. */
  | { kind: "saved"; entry: TimeEntry }
  /** The server answered no. Nothing was saved. */
  | { kind: "refused"; problem: HoursProblem; error: HttpError }
  /** No answer in time — it may or may not have gone through. */
  | { kind: "unconfirmed"; problem: HoursProblem; error: HttpError };

export async function sendDay(wire: SaveWire, attempt: SaveAttempt): Promise<SaveOutcome> {
  const result =
    attempt.mode === "create"
      ? await wire.create(attempt.payload, attempt.key)
      : await wire.patch(attempt.date, attempt.payload, attempt.key);
  return outcomeOf(result, attempt.action);
}

function outcomeOf(
  result: HttpResult<TimeEntryMutationResponse>,
  action: HoursAction
): SaveOutcome {
  if (result.ok) return { kind: "saved", entry: result.data.entry };
  const problem = explainHoursProblem(action, result.error);
  const unconfirmed = result.error.status === 0 && result.error.kind === "timeout";
  return unconfirmed
    ? { kind: "unconfirmed", problem, error: result.error }
    : { kind: "refused", problem, error: result.error };
}

/**
 * Does this stored entry already carry what the attempt was sending? For a
 * create, any entry on that date means the day is there (one entry per day).
 * For a change, the hours and jobs must match — the old copy being there is
 * exactly the case that needs a resend.
 */
export function entryMatchesAttempt(entry: TimeEntry, attempt: SaveAttempt): boolean {
  if (entry.date !== attempt.date) return false;
  if (attempt.mode === "create") return true;
  const p = attempt.payload;
  if (typeof p.totalHours === "number" && Math.abs(entry.totalHours - p.totalHours) > 0.01)
    return false;
  if (p.dayType !== undefined && (entry.dayType ?? null) !== (p.dayType ?? null)) return false;
  if (p.allocations) {
    const want = [...p.allocations]
      .map((a) => `${a.jobId ?? ""}:${Math.round(a.hours * 100)}`)
      .sort();
    const have = [...(entry.allocations ?? [])]
      .map((a) => `${a.jobId ?? ""}:${Math.round(a.hours * 100)}`)
      .sort();
    if (want.join("|") !== have.join("|")) return false;
  }
  if (p.status === "submitted" && entry.status !== "submitted" && entry.status !== "approved") {
    return false;
  }
  return true;
}

/**
 * Try again after no answer: read the day; if it's already there as sent,
 * that IS the save (no second send). Only when it isn't does the same
 * attempt — same key — go again. A failed read is reported as unconfirmed
 * again: with no signal, a resend couldn't land either.
 */
export async function retryDay(wire: SaveWire, attempt: SaveAttempt): Promise<SaveOutcome> {
  const read = await wire.readDay(attempt.date);
  if (read.ok) {
    const match = read.data.entries.find((e) => entryMatchesAttempt(e, attempt));
    if (match) return { kind: "saved", entry: match };
    return sendDay(wire, attempt);
  }
  const problem = explainHoursProblem(attempt.action, read.error);
  return { kind: "unconfirmed", problem, error: read.error };
}
