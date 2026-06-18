/**
 * Pure mapping: a won quote + its structure/materials sections → the input the
 * sanctioned job creator (api/_lib/job-create.js `createJob`) accepts, plus the
 * cleaned materials seed for the live job's materials-list (#244).
 *
 * NO I/O. The api/quotes.js handler reads the legacy quote + sections from
 * blob storage and hands the plain objects here; this module only reshapes
 * them. Keeping it pure means the legacy section→area/stage mapping is unit-
 * tested in isolation against legacy-shaped fixtures, independent of the
 * serverless handler.
 *
 * Source store note: the quote here is the LEGACY `quotes.json` record that
 * handleConvert already reads (fields `jobType`, `siteAddress`, plus
 * `structure.areaGroups[].areas[].workPackages`). This is NOT the v2
 * quotes-v2.json builder shape — conversion deliberately stays on the legacy
 * store that the convert handler owns.
 *
 * Mapping (legacy parity, with one deliberate v2 alignment):
 *   - structure.areaGroups → job areaGroups, fresh g_/a_ ids.
 *   - rough-in / fit-off tasks: unioned (deduped) across every area's work
 *     packages into the job-level roughInTasks / fitOffTasks lists — exactly
 *     what the live tradie task UI consumes.
 *   - DELIBERATE CHANGE FROM LEGACY: the legacy convert also stashed each
 *     area's raw `workPackages` on the area object. Conversion now routes
 *     through the sanctioned creator, whose validateAreaGroups defines the
 *     canonical area shape and drops unknown fields — so per-area
 *     `workPackages` would be silently stripped on write anyway. We do NOT
 *     emit it (no dead data), and we do NOT deepen area-owned task arrays
 *     (CLAUDE.md task-led rule). The unioned job-level task lists carry the
 *     task data; the per-area "custom checklists" idea, if revived, keys off
 *     canonical task identity, not a re-converted legacy array.
 *   - materials: quote-only `source` / `confidence` stripped, pricing kept,
 *     status normalised (priced | ordered | else draft) exactly as legacy.
 *   - job lands as a DRAFT (admin reviews/publishes), with fromQuoteId set so
 *     the trace is two-way (quote.convertedJobId ↔ job.fromQuoteId).
 */

// ── Legacy-shaped inputs (tolerant; only the fields we read are typed) ──────

export interface QuoteWorkPackage {
  name?: string;
  stage?: string; // 'rough-in' | 'fit-off' | anything → defaults to rough-in
  tasks?: string[];
}

export interface QuoteArea {
  id?: string;
  name?: string;
  workPackages?: QuoteWorkPackage[];
}

export interface QuoteAreaGroup {
  id?: string;
  name?: string;
  areas?: QuoteArea[];
}

export interface QuoteStructureSection {
  areaGroups?: QuoteAreaGroup[];
}

export interface QuoteMaterialItem {
  id?: string;
  status?: string;
  source?: unknown;
  confidence?: unknown;
  [key: string]: unknown;
}

export interface QuoteMaterialsSection {
  items?: QuoteMaterialItem[];
}

export interface ConvertQuote {
  id: string;
  name?: string;
  jobType?: string;
  siteAddress?: string;
  [key: string]: unknown;
}

// ── Outputs ─────────────────────────────────────────────────────────────────

export interface JobInputArea {
  id: string;
  name: string;
}

export interface JobInputAreaGroup {
  id: string;
  name: string;
  areas: JobInputArea[];
}

export interface JobInputTask {
  name: string;
}

/** The payload `createJob` accepts (subset we populate). */
export interface QuoteJobInput {
  name: string;
  type: string;
  status: 'draft';
  areaGroups: JobInputAreaGroup[];
  roughInTasks: JobInputTask[];
  fitOffTasks: JobInputTask[];
  siteAddress: string;
  fromQuoteId: string;
}

/** Cleaned material rows for the live job's materials-list seed. */
export interface MaterialsSeedItem {
  status: 'priced' | 'ordered' | 'draft';
  [key: string]: unknown;
}

export interface QuoteToJobResult {
  jobInput: QuoteJobInput;
  materialsSeed: MaterialsSeedItem[];
}

// ── Mapping ──────────────────────────────────────────────────────────────────

function shortId(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2, 8);
}

function normaliseStage(stage: unknown): 'rough-in' | 'fit-off' {
  return stage === 'fit-off' ? 'fit-off' : 'rough-in';
}

/**
 * Map a won quote + its structure + materials into createJob input and the
 * materials seed. Pure — same inputs always give the same shape (ids are the
 * only non-determinism, matching the legacy convert which also minted them).
 */
export function quoteToJobInput(
  quote: ConvertQuote,
  structure: QuoteStructureSection | null | undefined,
  materials: QuoteMaterialsSection | null | undefined,
): QuoteToJobResult {
  const structureGroups = (structure && structure.areaGroups) || [];

  // Area groups → job areaGroups with fresh ids. Per-area workPackages are
  // intentionally NOT carried (the sanctioned validateAreaGroups would strip
  // them; the unioned task lists below carry the task data) — see the module
  // header for the rationale.
  const areaGroups: JobInputAreaGroup[] = structureGroups.map((g) => ({
    id: shortId('g_'),
    name: g.name || '',
    areas: (g.areas || []).map((a) => ({
      id: shortId('a_'),
      name: a.name || '',
    })),
  }));

  // Distil rough-in / fit-off tasks: union (dedupe) across every area's work
  // packages. Admin refines in Job Setup afterwards.
  const roughSet = new Set<string>();
  const fitSet = new Set<string>();
  for (const g of structureGroups) {
    for (const a of g.areas || []) {
      for (const wp of a.workPackages || []) {
        const target = normaliseStage(wp.stage) === 'fit-off' ? fitSet : roughSet;
        for (const t of wp.tasks || []) target.add(t);
      }
    }
  }
  const roughInTasks: JobInputTask[] = [...roughSet].map((name) => ({ name }));
  const fitOffTasks: JobInputTask[] = [...fitSet].map((name) => ({ name }));

  const jobInput: QuoteJobInput = {
    name: quote.name || 'Job',
    type: quote.jobType || '',
    status: 'draft',
    areaGroups,
    roughInTasks,
    fitOffTasks,
    siteAddress: quote.siteAddress || '',
    fromQuoteId: quote.id,
  };

  // Materials: strip quote-only fields, keep pricing, normalise status.
  // (createJob does not write the materials-list; the handler seeds it after
  // job creation from this array — see handleConvert.)
  const materialsSeed: MaterialsSeedItem[] = ((materials && materials.items) || []).map((m) => {
    // Strip the quote-only fields (don't name them as throwaway bindings —
    // that trips no-unused-vars); keep everything else incl. pricing.
    const rest = { ...m };
    delete rest.source;
    delete rest.confidence;
    const status: 'priced' | 'ordered' | 'draft' =
      m.status === 'priced' ? 'priced' : m.status === 'ordered' ? 'ordered' : 'draft';
    return { ...rest, status };
  });

  return { jobInput, materialsSeed };
}
