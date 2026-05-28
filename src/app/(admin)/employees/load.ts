import { headers } from "next/headers";
import { z } from "zod";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { EmployeeListResponseSchema } from "@/domains/employees/schema";
import type { EmployeeRow } from "@/domains/employees/types";
import type { ActiveJobOption } from "@/components/admin/AddEmployeeDrawer";

/**
 * Server-side data load for /employees (and /employees/[id]). Mirrors the gear
 * register's loader: build an absolute base URL from the request headers,
 * forward the session cookie, fetch the legacy endpoints, and parse through
 * Zod. Degrades to an honest empty/error state when the API or Blob store
 * isn't reachable (e.g. local `next dev` without a Blob token) — the page
 * still renders.
 */

const JobsListSchema = z.object({
  jobs: z.array(
    z
      .object({
        id: z.string(),
        name: z.string().optional(),
        ref: z.string().nullable().optional(),
        status: z.string().nullable().optional(),
      })
      .passthrough()
  ),
});

export interface EmployeesView {
  rows: ReadonlyArray<EmployeeRow>;
  activeJobs: ReadonlyArray<ActiveJobOption>;
  emailConfigured: boolean;
  fetchError: string | null;
}

export async function loadEmployeesView(cookieValue: string | undefined): Promise<EmployeesView> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  const cookieHeader = cookieValue
    ? ({ cookie: `${SESSION_COOKIE}=${cookieValue}` } as const)
    : undefined;

  try {
    const [empRes, jobsRes] = await Promise.all([
      fetch(`${base}/api/employees`, { cache: "no-store", headers: cookieHeader }),
      fetch(`${base}/api/jobs`, { cache: "no-store", headers: cookieHeader }),
    ]);

    if (!empRes.ok) {
      return {
        rows: [],
        activeJobs: [],
        emailConfigured: false,
        fetchError: `Employees API returned ${empRes.status}`,
      };
    }
    const empParsed = EmployeeListResponseSchema.safeParse(await empRes.json());
    if (!empParsed.success) {
      return { rows: [], activeJobs: [], emailConfigured: false, fetchError: "Unexpected employees response shape" };
    }

    let activeJobs: ActiveJobOption[] = [];
    if (jobsRes.ok) {
      const jobsParsed = JobsListSchema.safeParse(await jobsRes.json());
      if (jobsParsed.success) {
        activeJobs = jobsParsed.data.jobs
          .filter((j) => !j.status || j.status === "active")
          .map((j) => ({ id: j.id, name: j.name ?? j.id, ref: j.ref ?? null }));
      }
    }

    return {
      rows: empParsed.data.employees,
      activeJobs,
      emailConfigured: empParsed.data.emailConfigured,
      fetchError: null,
    };
  } catch (err) {
    return {
      rows: [],
      activeJobs: [],
      emailConfigured: false,
      fetchError: err instanceof Error ? err.message : "Network error",
    };
  }
}
