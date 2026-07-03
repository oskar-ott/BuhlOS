import { z } from "zod";
import { QUOTE_LIMITS, QUOTE_LINE_KINDS, QuoteLineKindSchema, type QuoteLineKind } from "./schema";

/**
 * AI quote drafts (#246) — the domain contract behind
 * POST /api/quotes-v2?action=ai-draft / ai-draft-review.
 *
 * The house rule (api/_lib/ai-suggestions.js): AI output is a SUGGESTION
 * carrying provenance, and becomes a real quote line only through an explicit
 * human accept/edit. A suggested line NEVER carries a rate or price — the
 * model is forbidden from proposing one, and an accepted line lands at
 * rate 0 with `needsPricing: true` so it visibly contributes $0 until the
 * estimator prices it. Totals code (totals.ts and its CJS mirror) reads
 * only sections[].lines — the `aiDraft` doc field never enters money math.
 *
 * MIRROR: api/quotes-v2.js (CJS — cannot import this module, repo law)
 * hand-mirrors validateProposedLine / the takeoff contract. Change them
 * TOGETHER; the API harness test (quotes-v2-ai-draft-api.test.ts) pins the
 * server side and ai-draft.test.ts pins this side.
 */

/** Prompt version stamped on every run + suggestion (provenance). */
export const QUOTE_DRAFT_PROMPT_VERSION = "quote-draft-v1";

/** Scope text sent to the model is capped here; longer pastes are truncated
 *  and the run records `truncated: true` + `usedChars` so the UI can DISCLOSE
 *  it (same 12,000-char convention as the legacy ai-review in api/quotes.js). */
export const SCOPE_TEXT_MAX_CHARS = 12_000;

/** How much of the used scope text is kept on the run record for audit. */
export const SOURCE_TEXT_EXCERPT_CHARS = 300;

// ── Takeoff input — the TYPED, STUBBED Epic-5 interface ──────────────────
//
// THE PRODUCER NOW EXISTS: Epic 5's signed-off takeoffs (#213 — assembled
// from human-verified counts/schedules/estimates with provenance per line).
// takeoffToDraftInput() below maps a signed-off Takeoff into this shape;
// pasted scope text remains the other input path.

export const TakeoffItemSchema = z.object({
  description: z.string().trim().min(1, "takeoff item description required").max(QUOTE_LIMITS.maxLineDescription),
  qty: z.number().finite().min(0).max(QUOTE_LIMITS.maxQty),
  unit: z.string().trim().max(QUOTE_LIMITS.maxUnit),
  /** Optional drawing reference ("E-101 rev C") for provenance. */
  drawingRef: z.string().trim().max(80).optional(),
});
export type TakeoffItem = z.infer<typeof TakeoffItemSchema>;

export const TAKEOFF_MAX_ITEMS = 500;

export const TakeoffInputSchema = z.object({
  source: z.literal("takeoff"),
  items: z.array(TakeoffItemSchema).min(1, "takeoff needs at least one item").max(TAKEOFF_MAX_ITEMS),
});
export type TakeoffInput = z.infer<typeof TakeoffInputSchema>;

/**
 * #246 follow-through — map a SIGNED-OFF Epic 5 takeoff (#213) into the
 * ai-draft TakeoffInput. Only lines with an effective quantity map (a
 * flagged qty-less schedule line has nothing measurable to offer the
 * drafter — it is skipped and counted, never invented); estimate lines
 * keep the word "estimate" in their description so the drafting model and
 * the human both see it. Returns the mapped input plus honest skip/drop
 * counts for the UI to disclose.
 */
export function takeoffToDraftInput(takeoff: {
  version: number;
  lines: Array<{
    description: string;
    effectiveQty: number | null;
    unit: string;
    estimate: boolean;
    provenance: Record<string, unknown>;
  }>;
}): { input: TakeoffInput | null; skippedNoQty: number; droppedOverCap: number } {
  const usable = takeoff.lines.filter((l) => l.effectiveQty !== null);
  const skippedNoQty = takeoff.lines.length - usable.length;
  const capped = usable.slice(0, TAKEOFF_MAX_ITEMS);
  const droppedOverCap = usable.length - capped.length;
  const items: TakeoffItem[] = capped.map((l) => {
    const p = l.provenance;
    const ref =
      typeof p.planId === "string" && typeof p.pageIndex === "number"
        ? `${p.planId} p${p.pageIndex + 1}`.slice(0, 80)
        : undefined;
    return {
      description:
        l.estimate && !/estimate/i.test(l.description)
          ? `${l.description} (estimate)`.slice(0, QUOTE_LIMITS.maxLineDescription)
          : l.description.slice(0, QUOTE_LIMITS.maxLineDescription),
      qty: l.effectiveQty as number,
      unit: l.unit.slice(0, QUOTE_LIMITS.maxUnit),
      ...(ref ? { drawingRef: ref } : {}),
    };
  });
  if (items.length === 0) return { input: null, skippedNoQty, droppedOverCap };
  return { input: { source: "takeoff", items }, skippedNoQty, droppedOverCap };
}

export function parseTakeoffInput(
  raw: unknown
): { ok: true; takeoff: TakeoffInput } | { ok: false; error: string } {
  const parsed = TakeoffInputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid takeoff input" };
  }
  return { ok: true, takeoff: parsed.data };
}

// ── Model-proposed lines ─────────────────────────────────────────────────

/** What the model proposes per line — deliberately NO rate/price field. */
export interface DraftLine {
  kind: QuoteLineKind;
  description: string;
  /** null = the scope stated NO quantity; the model must never estimate one. */
  qty: number | null;
  unit: string | null;
}

/**
 * Validate one model-proposed line (the API hand-mirrors this):
 *   - kind must be in the material|labour|other whitelist
 *   - description non-empty, within the line-description cap
 *   - qty must be null unless an explicit finite number ≥ 0 was given
 *   - unit null or a short string
 * An invalid proposal is DROPPED by the caller, never "fixed up".
 */
export function validateProposedLine(
  raw: unknown
): { ok: true; line: DraftLine; uncertainty: string | null } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "line must be an object" };
  const l = raw as Record<string, unknown>;

  if (typeof l.kind !== "string" || !(QUOTE_LINE_KINDS as readonly string[]).includes(l.kind)) {
    return { ok: false, error: "kind must be material|labour|other" };
  }
  if (typeof l.description !== "string" || !l.description.trim()) {
    return { ok: false, error: "description required" };
  }
  const description = l.description.trim();
  if (description.length > QUOTE_LIMITS.maxLineDescription) {
    return { ok: false, error: `description too long (${QUOTE_LIMITS.maxLineDescription} max)` };
  }

  let qty: number | null = null;
  if (l.qty !== null && l.qty !== undefined) {
    if (typeof l.qty !== "number" || !Number.isFinite(l.qty) || l.qty < 0 || l.qty > QUOTE_LIMITS.maxQty) {
      return { ok: false, error: "qty must be null or a finite number ≥ 0" };
    }
    qty = l.qty;
  }

  let unit: string | null = null;
  if (l.unit !== null && l.unit !== undefined && l.unit !== "") {
    if (typeof l.unit !== "string") return { ok: false, error: "unit must be null or a string" };
    const trimmed = l.unit.trim();
    if (trimmed.length > QUOTE_LIMITS.maxUnit) {
      return { ok: false, error: `unit too long (${QUOTE_LIMITS.maxUnit} max)` };
    }
    unit = trimmed || null;
  }

  const uncertainty =
    typeof l.uncertainty === "string" && l.uncertainty.trim()
      ? l.uncertainty.trim().slice(0, 300)
      : null;

  return { ok: true, line: { kind: l.kind as QuoteLineKind, description, qty, unit }, uncertainty };
}

// ── Stored shapes (the quote doc's additive `aiDraft` field) ─────────────

export const AiDraftLineSchema = z.object({
  kind: QuoteLineKindSchema,
  description: z.string(),
  qty: z.number().nullable(),
  unit: z.string().nullable(),
});

/** One suggestion = the ai-suggestions envelope + the quote-draft payload. */
export const DraftSuggestionSchema = z
  .object({
    // envelope (api/_lib/ai-suggestions.js suggestionEnvelope)
    id: z.string(),
    type: z.string(),
    status: z.enum(["suggested", "accepted", "edited", "rejected", "superseded"]),
    model: z.string(),
    promptVersion: z.string(),
    confidence: z.number().nullable(),
    createdAt: z.string(),
    createdBy: z.string(),
    reviewedById: z.string().nullable(),
    reviewedByName: z.string().nullable(),
    reviewedAt: z.string().nullable(),
    reviewNote: z.string().nullable(),
    humanCorrection: z.unknown().nullable(),
    // quote-draft payload
    runId: z.string(),
    sectionTitle: z.string(),
    line: AiDraftLineSchema,
    uncertainty: z.string().nullable(),
  })
  .passthrough();
export type DraftSuggestion = z.infer<typeof DraftSuggestionSchema>;

export const AiDraftRunSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    createdById: z.string().nullable(),
    model: z.string(),
    promptVersion: z.string(),
    /** First SOURCE_TEXT_EXCERPT_CHARS of the used scope text (audit trail). */
    sourceTextExcerpt: z.string(),
    /** True when the paste exceeded SCOPE_TEXT_MAX_CHARS — the UI discloses it. */
    truncated: z.boolean(),
    usedChars: z.number(),
    usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).nullable(),
    takeoffProvided: z.boolean(),
  })
  .passthrough();
export type AiDraftRun = z.infer<typeof AiDraftRunSchema>;

export const AiDraftStateSchema = z
  .object({
    runs: z.array(AiDraftRunSchema),
    suggestions: z.array(DraftSuggestionSchema),
  })
  .passthrough();
export type AiDraftState = z.infer<typeof AiDraftStateSchema>;

const EMPTY_AI_DRAFT: AiDraftState = { runs: [], suggestions: [] };

/**
 * Read the additive `aiDraft` field off a wire quote document. QuoteSchema is
 * .passthrough() so the field survives parsing without schema.ts knowing about
 * it (keeps this module the single owner of the shape). Missing/unparseable →
 * the honest empty state — never an invented draft.
 */
export function readAiDraft(quote: unknown): AiDraftState {
  if (!quote || typeof quote !== "object") return EMPTY_AI_DRAFT;
  const raw = (quote as Record<string, unknown>).aiDraft;
  if (raw === undefined || raw === null) return EMPTY_AI_DRAFT;
  const parsed = AiDraftStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : EMPTY_AI_DRAFT;
}
