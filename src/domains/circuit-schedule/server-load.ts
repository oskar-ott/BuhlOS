import { headers } from "next/headers";
import { z } from "zod";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { CircuitBoardsResponseSchema, type Board } from "./schema";

/**
 * Server-side loader for the circuit-schedule office page.
 *
 * Calls the legacy /api endpoints with the forwarded session cookie — the same
 * pattern the job hub + Phil job page use. The browser client (`client.ts`)
 * can't be reused here: it issues relative-URL fetches that only resolve in the
 * browser. Both reads are best-effort — a parse miss or a 403 still lets the
 * page render (empty + honest), it never throws the route.
 */

export interface CircuitJob {
  /** Human job number for display (job.ref), falling back to the id. */
  id: string;
  name: string;
  client: string;
  drawing: string;
}

export interface CircuitScheduleLoad {
  job: CircuitJob;
  boards: Board[];
  error: string | null;
}

async function apiBase(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  return host ? `${proto}://${host}` : "http://localhost:3000";
}

function cookieHeader(value: string | undefined): HeadersInit | undefined {
  return value ? { cookie: `${SESSION_COOKIE}=${value}` } : undefined;
}

const JobMetaSchema = z
  .object({
    job: z
      .object({
        id: z.string(),
        name: z.string().optional(),
        ref: z.string().nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export async function loadCircuitSchedule(
  cookieValue: string | undefined,
  jobId: string,
): Promise<CircuitScheduleLoad> {
  const base = await apiBase();
  const init: RequestInit = { cache: "no-store", headers: cookieHeader(cookieValue) };

  // Job meta — best-effort. A miss leaves an honest fallback that still saves
  // (the route param `jobId` is the real id used for writes, not this).
  let job: CircuitJob = { id: jobId, name: jobId, client: "", drawing: "" };
  try {
    const res = await fetch(`${base}/api/jobs?id=${encodeURIComponent(jobId)}`, init);
    if (res.ok) {
      const parsed = JobMetaSchema.safeParse(await res.json());
      if (parsed.success) {
        const j = parsed.data.job;
        job = { id: j.ref || j.id, name: j.name || j.id, client: "", drawing: "" };
      }
    }
  } catch {
    /* keep fallback */
  }

  // Boards.
  try {
    const res = await fetch(`${base}/api/job-circuits?jobId=${encodeURIComponent(jobId)}`, init);
    if (!res.ok) {
      // 403 = a viewer who can see the job but not this endpoint; render empty,
      // no error banner. Other non-OK codes are surfaced.
      return { job, boards: [], error: res.status === 403 ? null : `Could not load schedule (API ${res.status})` };
    }
    const parsed = CircuitBoardsResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { job, boards: [], error: "Could not read the circuit schedule." };
    return { job, boards: parsed.data.boards, error: null };
  } catch {
    return { job, boards: [], error: "Could not reach the circuit schedule." };
  }
}
