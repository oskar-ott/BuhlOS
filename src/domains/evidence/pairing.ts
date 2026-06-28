import type { EvidenceItem } from "./types";

/**
 * Pure helpers for #263 before/after evidence pairing.
 *
 * The link is stored ONLY on the AFTER row (`pairedWithId` → BEFORE id);
 * the render layer derives both directions. These helpers are framework-
 * free so they can be unit-tested in isolation and reused by both the
 * admin drawer and the Phil strip.
 *
 *   - candidateBeforePhotos: which earlier photos may be the BEFORE for a
 *     given AFTER (the Phil/admin picker list).
 *   - validateLink: mirrors the server's link rules so the client can
 *     refuse an obviously-bad pair before the round-trip (and so the unit
 *     tests cover the same matrix the API enforces).
 *   - resolvePair: given any item, return { before, after } for side-by-
 *     side rendering. A DANGLING pairedWithId (partner missing) is treated
 *     as unpaired — it NEVER throws.
 *
 * Cross-ref:
 *   api/evidence.js — linkEvidence / unlinkEvidence (authoritative rules)
 *   src/domains/evidence/schema.ts — LinkEvidencePayloadSchema
 */

function isPhoto(item: EvidenceItem | null | undefined): item is EvidenceItem {
  return !!item && item.kind === "photo";
}

/**
 * Candidate BEFORE photos for a given AFTER photo, for the link picker.
 *
 * Rules:
 *   - same job (defensive — callers pass a single-job list, but a stray
 *     cross-job row is excluded rather than offered)
 *   - kind === 'photo' only (no note pairing)
 *   - exclude the AFTER itself (no self-link)
 *   - prefer same area/task context, then cross-area
 *   - recent-first within each group (capturedAt desc)
 *   - capped (default 12) so the picker stays a glance, not a scroll
 *
 * Returns [] for a non-photo / missing AFTER — there is nothing to pair to.
 */
export function candidateBeforePhotos(
  items: ReadonlyArray<EvidenceItem>,
  after: EvidenceItem | null | undefined,
  opts: { cap?: number } = {},
): EvidenceItem[] {
  const cap = opts.cap ?? 12;
  if (!isPhoto(after)) return [];

  const pool = items.filter(
    (it) =>
      isPhoto(it) &&
      it.id !== after.id &&
      it.jobId === after.jobId,
  );

  // Same area/task context scores ahead of cross-area; recent-first
  // breaks ties. A stable sort keeps the grouping deterministic.
  const sameContext = (it: EvidenceItem): boolean => {
    // Same area is the strongest signal; same task strengthens it but
    // never weakens (an after with no area can't claim same-area).
    if (after.areaId && it.areaId && it.areaId === after.areaId) return true;
    return false;
  };

  const ranked = pool
    .map((it, idx) => ({ it, idx }))
    .sort((a, b) => {
      const sa = sameContext(a.it) ? 0 : 1;
      const sb = sameContext(b.it) ? 0 : 1;
      if (sa !== sb) return sa - sb;
      const ta = String(a.it.capturedAt || "");
      const tb = String(b.it.capturedAt || "");
      if (ta !== tb) return tb.localeCompare(ta); // recent-first
      return a.idx - b.idx; // stable for equal timestamps
    })
    .map((x) => x.it);

  return ranked.slice(0, Math.max(0, cap));
}

export type LinkValidation =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Mirror of the server's link rules (api/evidence.js#linkEvidence), minus
 * the permission gate (that needs the session — enforced server-side and
 * tested there). Used by the client to refuse a bad pair before the
 * round-trip and by the unit suite to cover the rule matrix.
 *
 * Both ids must resolve to photo rows on the same job; no self-link.
 */
export function validateLink(
  items: ReadonlyArray<EvidenceItem>,
  afterId: string,
  beforeId: string,
): LinkValidation {
  if (!afterId || !beforeId) return { ok: false, reason: "missing-id" };
  if (afterId === beforeId) return { ok: false, reason: "self-link" };

  const after = items.find((it) => it && it.id === afterId);
  const before = items.find((it) => it && it.id === beforeId);
  if (!after) return { ok: false, reason: "after-not-found" };
  if (!before) return { ok: false, reason: "before-not-found" };
  if (after.kind !== "photo") return { ok: false, reason: "after-not-photo" };
  if (before.kind !== "photo") return { ok: false, reason: "before-not-photo" };
  if (after.jobId !== before.jobId) return { ok: false, reason: "cross-job" };

  return { ok: true };
}

export interface ResolvedPair {
  /** The earlier "before" half, or null when unpaired / dangling. */
  before: EvidenceItem | null;
  /** The later "after" half (carries pairedWithId), or null when the
   *  given item is itself a before with no after referencing it here. */
  after: EvidenceItem | null;
  /** True only when BOTH halves resolved. A dangling link is false. */
  paired: boolean;
}

/**
 * Resolve the before/after pair for any evidence item, for rendering.
 *
 * The link direction is fixed: the AFTER row carries pairedWithId. So:
 *   - if `item` carries pairedWithId AND that partner exists → item is the
 *     AFTER, partner is the BEFORE.
 *   - else if some OTHER row's pairedWithId === item.id → item is the
 *     BEFORE, that row is the AFTER.
 *   - else → unpaired (also the DANGLING case: pairedWithId set but the
 *     partner is missing from `items`).
 *
 * Never throws. A dangling pairedWithId resolves to { before:null,
 * after:item, paired:false } so the caller renders the single item.
 */
export function resolvePair(
  items: ReadonlyArray<EvidenceItem>,
  item: EvidenceItem | null | undefined,
): ResolvedPair {
  if (!item) return { before: null, after: null, paired: false };

  // Case 1 — item is the AFTER (it carries the link).
  if (item.pairedWithId) {
    const before = items.find((it) => it && it.id === item.pairedWithId) ?? null;
    // Dangling: link set but partner missing → treat as unpaired.
    return { before, after: item, paired: !!before };
  }

  // Case 2 — item is the BEFORE (some after points at it).
  const after =
    items.find((it) => it && it.pairedWithId === item.id) ?? null;
  if (after) return { before: item, after, paired: true };

  // Case 3 — genuinely unpaired.
  return { before: null, after: item, paired: false };
}

/**
 * The set of evidence ids that participate in ANY pair, computed from the
 * UNFILTERED list. Includes both halves of every link so the admin queue
 * can badge a row even when its partner is filtered out (AC). Dangling
 * links contribute only the after id (the before is missing).
 */
export function pairedIdSet(items: ReadonlyArray<EvidenceItem>): Set<string> {
  const ids = new Set<string>();
  const byId = new Map(items.map((it) => [it.id, it] as const));
  for (const it of items) {
    if (it.pairedWithId && byId.has(it.pairedWithId)) {
      ids.add(it.id);
      ids.add(it.pairedWithId);
    }
  }
  return ids;
}
