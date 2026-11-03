import type { VerificationStatus } from "@/domains/workshop-stock/schema";

/** How well an item's product code is confirmed, as a pill tone. */
export const CODE_TONE: Record<VerificationStatus, "success" | "warning" | "neutral"> = { manufacturer_code_matched: "success", possible_match: "warning", unverified: "neutral" };

/** The short status for a table cell or the drawer summary; the full line (verificationLine, with its reason) goes in the tooltip. */
export const CODE_SHORT: Record<VerificationStatus, string> = { manufacturer_code_matched: "Matched", possible_match: "Possible match", unverified: "Not checked" };
