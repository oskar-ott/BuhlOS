import type { CloseoutFulfilmentLink } from "@/domains/job-control/types";

/**
 * Pure op-builders for the closeout matrix authoring panel (#374). The panel is
 * a "use client" component; the node test runner can't click it, so the shape of
 * every op it POSTs to /api/job-control/closeout/confirm is built here and
 * unit-tested directly. Each builder returns the exact `op` object the route's
 * `CloseoutOpSchema` validates (add / link / confirm / waive / remove).
 *
 * No fabrication: `buildAddOp` trims/validates the title and only the schema's
 * kinds are accepted; `buildLinkOp` emits only the typed record references the
 * picker offered (real records — see closeout-read's link options). The panel
 * never invents a "satisfied" — that stays a server re-derivation (link + confirm).
 */

/** The requirement kinds an admin can author (mirrors CloseoutRequirementKind). */
export const CLOSEOUT_AUTHOR_KINDS = [
  "document",
  "itp",
  "evidence",
  "certificate",
  "other",
] as const;
export type CloseoutAuthorKind = (typeof CLOSEOUT_AUTHOR_KINDS)[number];

export const CLOSEOUT_KIND_LABEL: Record<CloseoutAuthorKind, string> = {
  document: "Document",
  itp: "ITP",
  evidence: "Evidence",
  certificate: "Certificate",
  other: "Other",
};

export type CloseoutAddOp = {
  op: "add";
  title: string;
  kind: CloseoutAuthorKind;
};

export type CloseoutLinkOp = {
  op: "link";
  requirementId: string;
  links: CloseoutFulfilmentLink[];
};

/** Build an `add` op from the form fields, or null when the title is blank
 *  (the panel disables submit, but never POST a blank requirement). */
export function buildAddOp(title: string, kind: CloseoutAuthorKind): CloseoutAddOp | null {
  const trimmed = title.trim();
  if (trimmed.length === 0) return null;
  return { op: "add", title: trimmed, kind };
}

/** Build a `link` op that REPLACES the requirement's links with `links` (the
 *  producer clears any prior confirmation on a link change). Pass [] to clear. */
export function buildLinkOp(requirementId: string, links: CloseoutFulfilmentLink[]): CloseoutLinkOp {
  return { op: "link", requirementId, links };
}

/** Encode a picker option as a stable "type id" key for the controlled select.
 *  A space separates the two so a record id that contains ":" stays intact. */
export function linkOptionKey(link: { type: string; id: string }): string {
  return `${link.type} ${link.id}`;
}

/** Parse a key from `linkOptionKey` back into a fulfilment link, or null when
 *  malformed. The `type` is asserted to the link type — keys are only ever built
 *  from real, already-typed picker options, so this is safe at the boundary. */
export function parseLinkOptionKey(key: string): CloseoutFulfilmentLink | null {
  const sep = key.indexOf(" ");
  if (sep <= 0 || sep === key.length - 1) return null;
  return { type: key.slice(0, sep) as CloseoutFulfilmentLink["type"], id: key.slice(sep + 1) };
}
