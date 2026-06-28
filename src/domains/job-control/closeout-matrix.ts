import { CloseoutRequirementSchema } from "./schema";
import type {
  CloseoutFulfilmentLink,
  CloseoutFulfilmentType,
  CloseoutRequirement,
  CloseoutRequirementKind,
  CloseoutRequirementStatus,
} from "./types";
import type { ScopeClauseClassification } from "./reconciliation";

/**
 * Closeout matrix engine (#374) — the PURE seed + status derivation behind the
 * per-job closeout matrix. No I/O, no UI; unit-tested directly.
 *
 * A closeout requirement is an obligation that must be discharged to hand the
 * job over: every electrical job owes the standing defaults (test results, the
 * certificate of electrical safety, as-builts, O&M manuals/warranties); a job's
 * confirmed scope reconciliation (#366) may add more, from any clause the office
 * classified `closeout`. This module turns those two sources into a
 * `CloseoutRequirement[]`, and answers the only question that matters at
 * handover honestly: is each one actually discharged?
 *
 * The honesty rule (the whole point of #374):
 *   - `satisfied` requires BOTH a fulfilment link that RESOLVES to a real record
 *     (certificate / document / evidence / ITP / as-built that still exists) AND
 *     an admin CONFIRMATION on the requirement (`confirmedAt`). A stored
 *     `status: "satisfied"` is NEVER trusted on its own — it is always re-derived.
 *   - a link present but unconfirmed (or confirmed but the link no longer
 *     resolves) is `in_progress` — work is underway / was undone, not done.
 *   - everything else is `outstanding`. A `waived` requirement stays waived (an
 *     explicit office decision), independent of links.
 *
 * Read-only on completion: this measures readiness; it does NOT gate the job's
 * close-out action (#349 stays the authority on freezing numbers). #374 only
 * surfaces a pre-freeze warning.
 */

// ── Defaults ──────────────────────────────────────────────────────────────────

/** One standing closeout obligation shared by electrical jobs. The seed stamps
 *  a stable, greppable id from the key so re-seeding is idempotent (an existing
 *  requirement for the same default is matched, not duplicated). */
export interface DefaultCloseoutRequirement {
  /** Stable key → folded into the requirement id; never random, never time-based. */
  key: string;
  title: string;
  kind: CloseoutRequirementKind;
}

/**
 * The standing electrical closeout defaults. Deliberately small and honest — the
 * obligations every job of this trade owes at handover. NOT exhaustive
 * (job-specific obligations come from `closeout` clauses); these are the floor.
 */
export const DEFAULT_CLOSEOUT_REQUIREMENTS: ReadonlyArray<DefaultCloseoutRequirement> = [
  { key: "test_results", title: "Electrical test results recorded", kind: "evidence" },
  {
    key: "certificate_of_electrical_safety",
    title: "Certificate of electrical safety issued",
    kind: "certificate",
  },
  { key: "as_built_drawings", title: "As-built drawings issued", kind: "document" },
  { key: "om_manuals_warranties", title: "O&M manuals and warranties handed over", kind: "document" },
];

// ── Seeding ─────────────────────────────────────────────────────────────────--

const CLOSEOUT_ID_PREFIX = "cr_";

/** Deterministic id from a source key (FNV-1a, the repo's id idiom). Re-seeding
 *  the same default / clause yields the same id, so an admin's links/confirms
 *  survive a re-seed. */
function deriveCloseoutRequirementId(sourceKey: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < sourceKey.length; i++) {
    h ^= sourceKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${CLOSEOUT_ID_PREFIX}${(h >>> 0).toString(16).padStart(8, "0")}`;
}

export interface SeedCloseoutInput {
  jobId: string;
  /** The confirmed reconciliation's clause classifications (#366). Only clauses
   *  classified `closeout` seed a requirement. */
  clauseClassifications: ReadonlyArray<ScopeClauseClassification>;
  /** The standing defaults to include (pass `DEFAULT_CLOSEOUT_REQUIREMENTS` in
   *  production; injectable so a test can pin them). */
  defaults?: ReadonlyArray<DefaultCloseoutRequirement>;
}

/**
 * Build the seed set of closeout requirements from (a) the recon's `closeout`
 * clauses and (b) the standing defaults. Every requirement starts `outstanding`
 * with no links and no confirmation — never a fabricated "done". Tagged with
 * `source` so the matrix can show provenance, and ordered defaults-first then
 * clause order. PURE — returns fresh records, mutates nothing.
 *
 * Seeding is the FIRST write only: it is the initial obligation set. Status is
 * always re-derived later from links + confirmation, never read back off these.
 */
export function seedCloseoutRequirements(input: SeedCloseoutInput): CloseoutRequirement[] {
  const { jobId } = input;
  const defaults = input.defaults ?? DEFAULT_CLOSEOUT_REQUIREMENTS;
  const out: CloseoutRequirement[] = [];
  let order = 0;

  for (const d of defaults) {
    out.push(
      CloseoutRequirementSchema.parse({
        id: deriveCloseoutRequirementId(`default:${d.key}`),
        jobId,
        title: d.title,
        kind: d.kind,
        scopeClauseIds: [],
        fulfilmentLinks: [],
        areaScope: "job_wide",
        source: "manual",
        status: "outstanding",
        order: order++,
      }),
    );
  }

  for (const cc of input.clauseClassifications) {
    if (cc.classification !== "closeout") continue;
    out.push(
      CloseoutRequirementSchema.parse({
        id: deriveCloseoutRequirementId(`clause:${cc.clauseId}`),
        jobId,
        // The clause's own warning/note is the most honest title we have; fall
        // back to a clause-scoped label rather than inventing prose.
        title: cc.warningText?.trim() || cc.note?.trim() || `Closeout obligation (clause ${cc.clauseId})`,
        kind: "other",
        scopeClauseIds: [cc.clauseId],
        fulfilmentLinks: [],
        areaScope: "job_wide",
        source: "clause",
        status: "outstanding",
        order: order++,
      }),
    );
  }

  return out;
}

// ── Status derivation ───────────────────────────────────────────────────────--

/** The id sets a caller loads from the real stores so a fulfilment link can be
 *  checked for resolution. Each set is OPTIONAL: a link type is only resolvable
 *  when the caller supplied the matching set (a caller that didn't load, say,
 *  ITP instances simply can't confirm an `itp-instance` link resolves). */
export interface CloseoutKnownIds {
  certificateIds?: Iterable<string>;
  documentIds?: Iterable<string>;
  evidenceIds?: Iterable<string>;
  itpInstanceIds?: Iterable<string>;
}

function knownSetFor(
  type: CloseoutFulfilmentType,
  known: ResolvedKnownIds,
): Set<string> | null {
  switch (type) {
    case "certificate":
      return known.certificateIds;
    case "evidence":
      return known.evidenceIds;
    case "itp-instance":
      return known.itpInstanceIds;
    // An as-built IS a document in the register, so both resolve against documents.
    case "document":
    case "as-built":
      return known.documentIds;
  }
}

interface ResolvedKnownIds {
  certificateIds: Set<string> | null;
  documentIds: Set<string> | null;
  evidenceIds: Set<string> | null;
  itpInstanceIds: Set<string> | null;
}

function resolveKnown(known: CloseoutKnownIds): ResolvedKnownIds {
  return {
    certificateIds: known.certificateIds ? new Set(known.certificateIds) : null,
    documentIds: known.documentIds ? new Set(known.documentIds) : null,
    evidenceIds: known.evidenceIds ? new Set(known.evidenceIds) : null,
    itpInstanceIds: known.itpInstanceIds ? new Set(known.itpInstanceIds) : null,
  };
}

/**
 * True when a fulfilment link points at a record that still exists. When the
 * caller supplied no id set for the link's type, the link is treated as
 * UNRESOLVED (fail-closed) — we never flip a requirement green against a store
 * we couldn't check. This is the closeout mirror of `findDanglingRefs`: a
 * deleted/dangling record can never count.
 */
export function isFulfilmentLinkResolved(link: CloseoutFulfilmentLink, known: ResolvedKnownIds): boolean {
  const set = knownSetFor(link.type, known);
  return set != null && set.has(link.id);
}

/** A requirement's links partitioned by whether they still resolve. */
export interface CloseoutLinkResolution {
  resolved: CloseoutFulfilmentLink[];
  dangling: CloseoutFulfilmentLink[];
}

export function resolveCloseoutLinks(
  requirement: Pick<CloseoutRequirement, "fulfilmentLinks">,
  known: CloseoutKnownIds,
): CloseoutLinkResolution {
  const resolvedKnown = resolveKnown(known);
  const resolved: CloseoutFulfilmentLink[] = [];
  const dangling: CloseoutFulfilmentLink[] = [];
  for (const link of requirement.fulfilmentLinks ?? []) {
    if (isFulfilmentLinkResolved(link, resolvedKnown)) resolved.push(link);
    else dangling.push(link);
  }
  return { resolved, dangling };
}

/**
 * Derive a requirement's status from its links + admin confirmation + the live
 * id sets — NEVER from its stored `status` field (except `waived`, an explicit
 * office decision that links can't undo). The honesty contract of #374:
 *
 *   waived                          → waived
 *   ≥1 resolving link AND confirmed → satisfied
 *   ≥1 resolving link, not confirmed → in_progress  (work underway)
 *   confirmed but NO resolving link  → in_progress  (a confirmed link was deleted
 *                                                     — reverts, never green)
 *   otherwise                        → outstanding
 *
 * A confirmed requirement whose only links have gone dangling REVERTS to
 * `in_progress`, never silently staying `satisfied`.
 */
export function deriveCloseoutStatus(
  requirement: Pick<CloseoutRequirement, "fulfilmentLinks" | "confirmedAt" | "status">,
  known: CloseoutKnownIds,
): CloseoutRequirementStatus {
  if (requirement.status === "waived") return "waived";

  const { resolved } = resolveCloseoutLinks(requirement, known);
  const hasResolvingLink = resolved.length > 0;
  const confirmed = Boolean(requirement.confirmedAt);

  if (hasResolvingLink && confirmed) return "satisfied";
  if (hasResolvingLink || confirmed) return "in_progress";
  return "outstanding";
}
