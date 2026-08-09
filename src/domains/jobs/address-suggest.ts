/**
 * Address suggestions for the site-address inputs (admin New-job form +
 * Builder basics).
 *
 * Backed by the free Photon geocoder (photon.komoot.io, OpenStreetMap data):
 * no API key, CORS-open, built for search-as-you-type. Results are biased to
 * Adelaide, filtered to Australia, and formatted the way the trade writes
 * them — "12 Magill Rd, Stepney SA 5069".
 *
 * Pure functions only — fetch/debounce/keyboard live in
 * src/components/admin/AddressAutocompleteInput.tsx. If Photon is down or
 * unreachable the input degrades to a plain text field; a typed address is
 * always accepted as-is.
 */

const PHOTON_ENDPOINT = "https://photon.komoot.io/api/";

/** Adelaide CBD — Photon ranks nearby results first but still searches AU-wide. */
const BIAS_LAT = -34.9285;
const BIAS_LON = 138.6007;

/** Don't query for fragments shorter than this — too noisy to be useful. */
export const ADDRESS_SUGGEST_MIN_CHARS = 4;

/** How many suggestions we ask for (and show at most). */
export const ADDRESS_SUGGEST_LIMIT = 6;

export function buildAddressSuggestUrl(query: string): string {
  const params = new URLSearchParams({
    q: query,
    limit: String(ADDRESS_SUGGEST_LIMIT),
    lang: "en",
    lat: String(BIAS_LAT),
    lon: String(BIAS_LON),
  });
  return `${PHOTON_ENDPOINT}?${params.toString()}`;
}

const STATE_ABBR: Record<string, string> = {
  "south australia": "SA",
  "new south wales": "NSW",
  victoria: "VIC",
  queensland: "QLD",
  "western australia": "WA",
  tasmania: "TAS",
  "northern territory": "NT",
  "australian capital territory": "ACT",
};

type PhotonProperties = {
  countrycode?: string;
  housenumber?: string;
  street?: string;
  name?: string;
  district?: string;
  city?: string;
  county?: string;
  state?: string;
  postcode?: string;
};

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export type AddressSuggestion = {
  label: string;
  /** True when the hit is a street (with or without a house number) — the
   *  only kind a typed house number can safely be re-attached to. */
  street: boolean;
};

/** One Photon feature → a display address, or null when it isn't usable. */
function formatFeature(props: PhotonProperties): AddressSuggestion | null {
  if ((props.countrycode ?? "").toUpperCase() !== "AU") return null;

  const housenumber = asString(props.housenumber);
  const street = asString(props.street);
  const name = asString(props.name);

  const line1 = street ? [housenumber, street].filter(Boolean).join(" ") : name;
  if (!line1) return null;

  const rawLocality = asString(props.district) ?? asString(props.city) ?? asString(props.county);
  // A suburb-only hit repeats itself as name AND locality — keep it once.
  const locality = rawLocality && rawLocality !== line1 ? rawLocality : undefined;

  const state = asString(props.state);
  const stateAbbr = state ? (STATE_ABBR[state.toLowerCase()] ?? state) : undefined;
  const tail = [locality, stateAbbr, asString(props.postcode)].filter(Boolean).join(" ");

  return { label: tail ? `${line1}, ${tail}` : line1, street: Boolean(street) };
}

/**
 * Photon GeoJSON response → deduped display addresses. Defensive on shape —
 * any surprise from the network yields [] rather than a throw.
 */
export function parseAddressSuggestions(json: unknown): AddressSuggestion[] {
  if (typeof json !== "object" || json === null) return [];
  const features = (json as { features?: unknown }).features;
  if (!Array.isArray(features)) return [];

  const out: AddressSuggestion[] = [];
  for (const f of features) {
    if (typeof f !== "object" || f === null) continue;
    const props = (f as { properties?: unknown }).properties;
    if (typeof props !== "object" || props === null) continue;
    const formatted = formatFeature(props as PhotonProperties);
    if (formatted && !out.some((s) => s.label === formatted.label)) out.push(formatted);
    if (out.length >= ADDRESS_SUGGEST_LIMIT) break;
  }
  return out;
}

/** Leading "12", "12a", "3/12", "12-14" … — the part OSM often can't match. */
const LEADING_HOUSE_NUMBER = /^\s*(\d+[a-zA-Z]?(?:\s*[-/]\s*\d+[a-zA-Z]?)?)\s+\S/;

/**
 * What picking a suggestion should put in the field. OSM is patchy on house
 * numbers, so a typed "12 Magill Rd Stepney" often matches the street-level
 * "Magill Road, Stepney SA 5069" — keep the typed number rather than losing
 * it. Street picks that already carry a number, and suburb/locality picks,
 * are taken as-is.
 */
export function mergePickedAddress(typed: string, picked: AddressSuggestion): string {
  if (!picked.street || /^\d/.test(picked.label)) return picked.label;
  const num = typed.match(LEADING_HOUSE_NUMBER)?.[1];
  return num ? `${num.replace(/\s+/g, "")} ${picked.label}` : picked.label;
}
