import { headers } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { JobDetailResponseSchema } from "@/domains/jobs/schema";
import { CircuitScheduleResponseSchema } from "./schema";
import type { Circuit, Switchboard } from "./types";
import type { Job } from "@/domains/jobs/types";

/**
 * Server-side loaders for the circuit schedule pages (admin + print).
 *
 * Both call the legacy /api endpoints with the forwarded session cookie, the
 * same pattern the job hub and Phil job page use. Kept here so the two pages
 * share one definition rather than each re-deriving the base URL + parse.
 */

async function apiBase(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  return host ? `${proto}://${host}` : "http://localhost:3000";
}

function cookieHeader(cookieValue: string | undefined): HeadersInit | undefined {
  return cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined;
}

export type JobLoad =
  | { kind: "ok"; job: Job }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "error" };

export async function loadJob(cookieValue: string | undefined, jobId: string): Promise<JobLoad> {
  const base = await apiBase();
  try {
    const res = await fetch(`${base}/api/jobs?id=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
      headers: cookieHeader(cookieValue),
    });
    if (res.status === 404) return { kind: "not_found" };
    if (res.status === 403) return { kind: "forbidden" };
    if (!res.ok) return { kind: "error" };
    const parsed = JobDetailResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { kind: "error" };
    return { kind: "ok", job: parsed.data.job };
  } catch {
    return { kind: "error" };
  }
}

export interface ScheduleLoad {
  switchboards: Switchboard[];
  circuits: Circuit[];
  error: string | null;
}

export async function loadSchedule(
  cookieValue: string | undefined,
  jobId: string
): Promise<ScheduleLoad> {
  const base = await apiBase();
  try {
    const res = await fetch(`${base}/api/job-circuits?jobId=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
      headers: cookieHeader(cookieValue),
    });
    if (!res.ok) {
      return { switchboards: [], circuits: [], error: res.status === 403 ? null : `API ${res.status}` };
    }
    const parsed = CircuitScheduleResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { switchboards: [], circuits: [], error: "Unexpected response shape" };
    return { switchboards: parsed.data.switchboards, circuits: parsed.data.circuits, error: null };
  } catch (err) {
    return { switchboards: [], circuits: [], error: err instanceof Error ? err.message : "network error" };
  }
}
