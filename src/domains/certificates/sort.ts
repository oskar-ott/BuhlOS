import type { Certificate } from "./schema";

/** Pure projections over the certificates register (#231). No IO. */

/** Only the non-archived ("current") certificates. */
export function currentCertificates(certs: Certificate[]): Certificate[] {
  return certs.filter((c) => c.status === "current");
}

/**
 * Newest issue date first (the register's default order). Undated certs sink to
 * the bottom; ties (and undated rows) break by most-recently-uploaded. Pure +
 * stable — does not mutate the input.
 */
export function sortByIssuedDesc(certs: Certificate[]): Certificate[] {
  return [...certs].sort((a, b) => {
    const ai = a.issuedAt || "";
    const bi = b.issuedAt || "";
    if (ai && bi && ai !== bi) return ai < bi ? 1 : -1;
    if (ai && !bi) return -1; // dated before undated
    if (!ai && bi) return 1;
    // same issue date, or both undated → newest upload first
    return a.uploadedAt < b.uploadedAt ? 1 : a.uploadedAt > b.uploadedAt ? -1 : 0;
  });
}
