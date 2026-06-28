import { DiaryListResponseSchema } from "./schema";
import type { DiaryEntry, DiaryListResponse } from "./types";

/**
 * Browser-side fetch helpers for the site diary (#210). The JobDiary editor uses
 * these; they parse responses through the zod schema so a shape drift surfaces
 * as a thrown error rather than a silent render glitch.
 */

export interface AttendancePrefillRow {
  userId: string;
  userName: string;
  hours: number;
  status: string;
}

/** GET /api/diary?jobId&fromDate&toDate — date-keyed entries in range. */
export async function fetchDiary(
  jobId: string,
  fromDate?: string,
  toDate?: string,
): Promise<DiaryListResponse> {
  const params = new URLSearchParams({ jobId });
  if (fromDate) params.set("fromDate", fromDate);
  if (toDate) params.set("toDate", toDate);
  const res = await fetch(`/api/diary?${params.toString()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Diary API returned ${res.status}`);
  const body = await res.json();
  const parsed = DiaryListResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error("Unexpected diary response shape");
  return parsed.data;
}

/**
 * Pre-fetch the admin-confirmed attendance for ONE day from the documented
 * attendance lookup (GET /api/site-visits). Returns the denormalised rows the
 * POST body carries. Throws on failure so the editor can show a NAMED
 * "attendance pre-fill unavailable" warning instead of a silent empty list (P7).
 */
export async function fetchAttendancePrefill(
  jobId: string,
  date: string,
): Promise<AttendancePrefillRow[]> {
  const params = new URLSearchParams({ jobId, fromDate: date, toDate: date });
  const res = await fetch(`/api/site-visits?${params.toString()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Attendance lookup returned ${res.status}`);
  const body = (await res.json()) as { visits?: AttendancePrefillRow[] };
  const visits = Array.isArray(body.visits) ? body.visits : [];
  return visits.map((v) => ({
    userId: String(v.userId),
    userName: String(v.userName),
    hours: Number(v.hours) || 0,
    status: String(v.status),
  }));
}

export interface CreateDiaryInput {
  date: string;
  happenings: string;
  weatherNote?: string | null;
  delay?: { flagged: boolean; reason?: string | null };
  attendance: AttendancePrefillRow[];
  attendanceSource: { fetchedAt: string | null; adjusted: boolean };
}

/** POST /api/diary?jobId — create the day's entry. */
export async function createDiaryEntry(
  jobId: string,
  input: CreateDiaryInput,
): Promise<DiaryEntry> {
  const res = await fetch(`/api/diary?jobId=${encodeURIComponent(jobId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as { entry?: DiaryEntry; error?: string } | null;
  if (!res.ok) throw new Error(body?.error || `Diary create failed (${res.status})`);
  if (!body?.entry) throw new Error("Diary create returned no entry");
  return body.entry;
}

export interface AmendDiaryInput {
  id: string;
  note?: string | null;
  changes: {
    happenings?: string;
    weatherNote?: string | null;
    delay?: { flagged: boolean; reason?: string | null };
  };
}

/** POST /api/diary?jobId&action=amend — append an amendment to an entry. */
export async function amendDiaryEntry(
  jobId: string,
  input: AmendDiaryInput,
): Promise<DiaryEntry> {
  const res = await fetch(`/api/diary?jobId=${encodeURIComponent(jobId)}&action=amend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as { entry?: DiaryEntry; error?: string } | null;
  if (!res.ok) throw new Error(body?.error || `Diary amend failed (${res.status})`);
  if (!body?.entry) throw new Error("Diary amend returned no entry");
  return body.entry;
}
