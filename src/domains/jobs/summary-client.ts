import { z } from "zod";
import type { Route } from "next";
import { httpPost, type HttpResult } from "@/lib/http";

/**
 * Client for POST /api/ai-assistant?action=summarise-job&jobId=X (#173).
 *
 * The first UI consumer of the shipped #170 assistant endpoint. The endpoint is
 * flag-dark (`ai_assistant`) and permission-scoped server-side — this client
 * only speaks its exact contract and never widens it.
 *
 * Response contract (verbatim from api/ai-assistant.js):
 *   { summary, generatedAt, model, toolData: { overview, hours, openItems } }
 *
 * P7 (no invented numbers): the endpoint returns `toolData` — the SAME
 * deterministic projections the model was shown — so the UI can render the REAL
 * counts next to the model's prose. The prose never stands as the sole source
 * of a number; `factNumbers()` pulls the verbatim figures for display.
 *
 * Honest failure taxonomy (mirrors the endpoint's status codes):
 *   503 UNCONFIGURED    → "AI isn't configured"
 *   502 PROVIDER_FAILED → "couldn't generate a summary, try again"
 *   403 / 404           → the button doesn't render at all (flag/gate); if hit
 *                         at request time, surface a generic unavailable state.
 * Nothing is ever cached-and-presented-as-fresh; a failed call shows an error.
 */

// ── toolData sub-shapes (mirror api/_lib/ai-tools.js read() returns) ────────

/** {store,id} reference to the record(s) behind a projection — the citation. */
export const SourceRefSchema = z.object({
  store: z.string(),
  id: z.string().nullable(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const OverviewSchema = z.object({
  job: z
    .object({
      id: z.string(),
      name: z.string().nullable(),
      type: z.string().nullable(),
      status: z.string().nullable(),
      address: z.string().nullable(),
      createdAt: z.string().nullable(),
    })
    .nullable(),
  areas: z.object({ count: z.number() }).nullable(),
  tasks: z
    .object({
      roughIn: z.object({ total: z.number(), complete: z.number() }),
      fitOff: z.object({ total: z.number(), complete: z.number() }),
    })
    .nullable(),
  openSnagCount: z.number().nullable(),
  evidenceCount: z.number().nullable(),
  sources: z.array(SourceRefSchema),
});
export type Overview = z.infer<typeof OverviewSchema>;

const HoursBucketSchema = z.object({ entryCount: z.number(), hours: z.number() });

export const HoursSchema = z.object({
  jobId: z.string(),
  approved: HoursBucketSchema,
  submitted: HoursBucketSchema,
  sources: z.array(SourceRefSchema),
});
export type Hours = z.infer<typeof HoursSchema>;

export const OpenItemsSchema = z.object({
  jobId: z.string(),
  openSnags: z.array(
    z.object({
      id: z.string(),
      description: z.string().nullable(),
      priority: z.string().nullable(),
      area: z.string().nullable().optional(),
      raisedBy: z.string().nullable().optional(),
      createdAt: z.string().nullable().optional(),
    }),
  ),
  openObservations: z.array(
    z.object({
      id: z.string(),
      type: z.string().nullable(),
      title: z.string().nullable(),
      status: z.string().nullable(),
      priority: z.string().nullable(),
      requiresAction: z.boolean().optional(),
      createdAt: z.string().nullable().optional(),
    }),
  ),
  sources: z.array(SourceRefSchema),
});
export type OpenItems = z.infer<typeof OpenItemsSchema>;

export const JobSummaryResponseSchema = z.object({
  summary: z.string(),
  generatedAt: z.string(),
  model: z.string(),
  toolData: z.object({
    overview: OverviewSchema,
    hours: HoursSchema,
    openItems: OpenItemsSchema,
  }),
});
export type JobSummaryResponse = z.infer<typeof JobSummaryResponseSchema>;

/** Call the endpoint. maxTokens/streaming are the endpoint's concern; we POST
 *  the action + jobId in the query string exactly as the handler expects. */
export async function summariseJob(jobId: string): Promise<HttpResult<JobSummaryResponse>> {
  return httpPost(
    `/api/ai-assistant?action=summarise-job&jobId=${encodeURIComponent(jobId)}`,
    {},
    {
      schema: JobSummaryResponseSchema,
      // A model call over a serverless invocation — give it a real budget so a
      // slow-but-succeeding generate isn't reported as a timeout.
      timeoutMs: 30_000,
    },
  );
}

// ── verbatim number extraction (P7) ─────────────────────────────────────────

export interface FactNumber {
  /** short label, e.g. "Rough-in" */
  label: string;
  /** the verbatim value string, e.g. "3 of 8 tasks complete" */
  value: string;
  /** true when the underlying domain is absent — rendered as an honest empty,
   *  never a fabricated zero-as-fact (e.g. "no ITPs" is a real absence). */
  empty?: boolean;
}

/**
 * Pull the REAL numbers from toolData so the UI can render them beside the
 * prose. Every figure here comes straight from the deterministic projection the
 * model was shown — the model's phrasing is never the sole source of a number.
 *
 * Labour is deliberately labelled by its scope: `job_hours` returns approved +
 * submitted (awaiting-approval) buckets, NOT a total-logged ledger (there is no
 * per-job hours index). We never expose an unlabelled "total hours".
 */
export function factNumbers(
  toolData: JobSummaryResponse["toolData"],
  fmtHours: (h: number) => string,
): FactNumber[] {
  const out: FactNumber[] = [];
  const { overview, hours, openItems } = toolData;

  if (overview.tasks) {
    const r = overview.tasks.roughIn;
    const f = overview.tasks.fitOff;
    out.push({
      label: "Rough-in",
      value: r.total > 0 ? `${r.complete} of ${r.total} tasks complete` : "no tasks",
      empty: r.total === 0,
    });
    out.push({
      label: "Fit-off",
      value: f.total > 0 ? `${f.complete} of ${f.total} tasks complete` : "no tasks",
      empty: f.total === 0,
    });
  }
  if (overview.areas) {
    out.push({ label: "Areas", value: `${overview.areas.count}`, empty: overview.areas.count === 0 });
  }

  // Labour — scoped honestly. Approved + awaiting-approval, never "total".
  const app = hours.approved;
  const sub = hours.submitted;
  out.push({
    label: "Hours approved",
    value:
      app.entryCount > 0
        ? `${fmtHours(app.hours)} · ${app.entryCount} ${app.entryCount === 1 ? "entry" : "entries"}`
        : "none approved",
    empty: app.entryCount === 0,
  });
  out.push({
    label: "Hours awaiting approval",
    value:
      sub.entryCount > 0
        ? `${fmtHours(sub.hours)} · ${sub.entryCount} ${sub.entryCount === 1 ? "entry" : "entries"}`
        : "none pending",
    empty: sub.entryCount === 0,
  });

  const snags = openItems.openSnags.length;
  out.push({
    label: "Open snags",
    value: snags > 0 ? `${snags}` : "none open",
    empty: snags === 0,
  });
  const obs = openItems.openObservations.length;
  out.push({
    label: "Open observations",
    value: obs > 0 ? `${obs}` : "none open",
    empty: obs === 0,
  });

  if (overview.evidenceCount != null) {
    out.push({
      label: "Evidence captured",
      value: `${overview.evidenceCount}`,
      empty: overview.evidenceCount === 0,
    });
  }

  return out;
}

// ── citation mapping: {store,id} → a live job-hub anchor ────────────────────

export interface Citation {
  /** the raw source ref from toolData */
  store: string;
  /** human label for the destination panel */
  label: string;
  /** a REAL route the reader can open; null when the store has no hub anchor
   *  (we never fabricate a link — an unmapped source is shown without one). */
  href: Route | null;
}

/**
 * Map the distinct `sources[].store` refs across the whole tool pack to the
 * live job-hub anchors the reader can open. Deterministic + deduplicated so the
 * citation strip is stable. Unknown stores are dropped (no fabricated links).
 */
export function citations(
  toolData: JobSummaryResponse["toolData"],
  jobId: string,
): Citation[] {
  const enc = encodeURIComponent(jobId);
  const seen = new Set<string>();
  const out: Citation[] = [];
  const push = (store: string, label: string, href: Route | null) => {
    // dedupe on the destination so "5 time-entry files" collapse to one chip
    const key = href ?? label;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ store, label, href });
  };

  const allSources = [
    ...toolData.overview.sources,
    ...toolData.hours.sources,
    ...toolData.openItems.sources,
  ];

  for (const s of allSources) {
    const store = s.store;
    if (store === "jobs.json" || store.endsWith("/data.json")) {
      // The per-job record + data.json back the overview/snags — the hub itself.
      push(store, "Job overview", `/v2/jobs/${enc}` as Route);
    } else if (store === "observations.json") {
      push(store, "Observations", `/v2/jobs/${enc}/observations` as Route);
    } else if (store.includes("/time-entries/")) {
      push(store, "Hours approvals", "/hours/approvals" as Route);
    }
    // Unknown store → dropped; no fabricated link.
  }

  return out;
}
