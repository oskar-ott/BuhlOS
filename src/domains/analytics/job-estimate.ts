import type { Job } from "@/domains/jobs/types";

/**
 * The single, honest accessor for a job's estimated labour HOURS — the input
 * the #343 time-overrun flag divides against.
 *
 * Today this ALWAYS returns null: no job carries a labour-hours estimate.
 *   - `JobSchema.labourEstimate` is DOLLARS, not hours (schema.ts comment).
 *   - The quote→job converter (`quoteToJobShape` in api/quotes.js) DROPS the
 *     per-line `estimatedHours` the quote's labour lines carry — the job never
 *     inherits them.
 * So there is no field to read yet, and this deliberately does NOT derive hours
 * from the dollar `labourEstimate` (that needs a rate basis — the #334 estimate
 * basis decision, an owner call this slice defers).
 *
 * It reads a future `estimatedHours` passthrough field if one ever appears
 * (JobSchema is `.passthrough()`), returning it only when it is a finite,
 * positive number — never a guess. The moment the #334 basis decision seeds a
 * real per-job hours estimate, THIS accessor is the one place that starts
 * returning it, and every consumer (the flag, the hub card) lights up with no
 * other change.
 */
export function readEstimatedHours(job: Job): number | null {
  const raw = (job as { estimatedHours?: unknown }).estimatedHours;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
}
