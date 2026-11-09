/**
 * Workshop Stock — finding an item's product photo online, one item at a time
 * (owner pulls 2026-11-05: "grab an image from the internet as the stock
 * image"; then "find photos for every item without one"). The steps the drawer
 * button and the bulk run share:
 *
 *   1. ask the server for the image its own online check found (web-photo)
 *   2. no check on record → run the check (from the cache when there is one),
 *      then ask once more
 *   3. say plainly what happened — found, nothing to use, or couldn't check
 *
 * Nothing is applied here: a found photo is a PENDING copy for the office to
 * look at first. Calls are injected so the decisions are tested without a
 * network.
 */
import { errorCopy } from "./format";
import type { HttpResult } from "@/lib/http";
import type { LookupResult, StockItem } from "./schema";

export interface WebPhotoFound {
  photoId: string;
  source: { domain: string | null; kind: string | null; pageUrl: string | null };
}

export type WebPhotoOutcome =
  | { kind: "found"; photo: WebPhotoFound }
  /** nothing to use for this item — not a failure */
  | { kind: "none"; text: string }
  /** couldn't find out; `stop` = later items would fail the same way (a limit, no signal, signed out) */
  | { kind: "error"; text: string; stop: boolean };

export interface WebPhotoDeps {
  findWebPhoto: (itemId: string) => Promise<HttpResult<WebPhotoFound>>;
  lookupCode: (input: { brand: string | null; manufacturerCode: string; colourFinish: string | null; variantDetails: string }) => Promise<HttpResult<LookupResult>>;
  /** told when the code check starts (the slow step) */
  onChecking?: () => void;
}

type ItemForPhoto = Pick<StockItem, "id" | "brand" | "manufacturerCode" | "colourFinish" | "variant">;

const errorOf = (body: unknown): string | null => (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : null);

/** A failure every later item would hit too: signed out, no signal, a rate or daily limit. */
function stops(status: number, body: unknown): boolean {
  return status === 0 || status === 401 || status === 403 || status === 429 || errorOf(body) === "web_photo_limit" || errorOf(body) === "lookup_limit";
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1).replace(/\.$/, "");

export async function findPhotoFor(item: ItemForPhoto, deps: WebPhotoDeps): Promise<WebPhotoOutcome> {
  if (!item.manufacturerCode) return { kind: "none", text: "No maker's code to look it up by." };
  let r = await deps.findWebPhoto(item.id);
  if (!r.ok && r.error.status === 409 && errorOf(r.error.body) === "not_checked") {
    deps.onChecking?.();
    // exactly the item's own brand / code / colour / size — the check the server reads back
    const l = await deps.lookupCode({ brand: item.brand, manufacturerCode: item.manufacturerCode, colourFinish: item.colourFinish, variantDetails: item.variant ?? "" });
    if (!l.ok) return { kind: "error", text: errorCopy(l.error.status, l.error.body, "Couldn't check the code online right now."), stop: stops(l.error.status, l.error.body) };
    if (l.data.status === "unavailable" || l.data.status === "not_configured") {
      // "couldn't check" (incl. today's checks used up) — the next item would get the same answer
      return { kind: "error", text: l.data.reasons[0] ?? "Couldn't check the code online right now.", stop: true };
    }
    if (l.data.status !== "manufacturer_code_matched" && l.data.status !== "possible_match") {
      return { kind: "none", text: l.data.reasons[0] ? `No product page found — ${lowerFirst(l.data.reasons[0])}.` : "No product page found for this code." };
    }
    r = await deps.findWebPhoto(item.id);
  }
  if (r.ok) return { kind: "found", photo: r.data };
  const text = errorCopy(r.error.status, r.error.body, "Couldn't get a photo online right now.");
  if (r.error.status === 404 && errorOf(r.error.body) === "no_web_photo") return { kind: "none", text };
  return { kind: "error", text, stop: stops(r.error.status, r.error.body) };
}

/** The items a bulk run looks at: live, no product photo yet, a maker's code to look up by. */
export function needsWebPhoto<T extends Pick<StockItem, "photoId" | "manufacturerCode" | "archivedAt">>(items: readonly T[]): T[] {
  return items.filter((i) => !i.archivedAt && !i.photoId && Boolean(i.manufacturerCode));
}

/** At most this many per bulk run: each may spend one of the day's online checks. */
export const BULK_WEB_PHOTO_MAX = 25;
