/**
 * Workshop Stock — does an online code check still describe the item on the
 * form? Pure; for the screen only (the server decides what is saved).
 *
 * Mirrors api/_lib/workshop-stock/codes.js (cleanCode / codeKey / brandKey /
 * variantDetailsFrom / checkApplies) so the "Code status" line says what the
 * server will record: a check made for the code alone still counts when
 * "Use these details" filled the brand or colour from the listing, but not
 * after the code, brand, colour or size changed to something the check wasn't
 * for. client-logic.test.ts runs both copies over the same cases.
 */

export interface LookupCheck {
  brand: string | null;
  manufacturerCode: string;
  colourFinish: string | null;
  variantDetails: string[];
}

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9 ./_+#()-]{0,47}$/;

function squash(v: unknown, max?: number): string | null {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
}

export function cleanCode(v: unknown): string | null {
  const s = squash(v);
  if (!s || s.length < 2 || s.length > 48) return null;
  if (!CODE_RE.test(s)) return null;
  if (s.replace(/[^A-Za-z0-9]/g, "").length < 2) return null;
  const parts = s.split(" ");
  if (parts.length > 3) return null;
  if (!/\d/.test(s) && (parts.length > 1 || s.length > 16)) return null;
  return s;
}

export function codeKey(v: unknown): string | null {
  const s = cleanCode(v);
  return s ? s.toUpperCase().replace(/\s+/g, "") : null;
}

const BRAND_ALIASES: Readonly<Record<string, string>> = {
  "clipsal by schneider electric": "clipsal",
  "clipsal by schneider": "clipsal",
  "schneider electric": "schneider",
  schneider: "schneider",
  "hpm legrand": "hpm",
  "hpm by legrand": "hpm",
  "nhp electrical engineering products": "nhp",
  "abb australia": "abb",
  "hager australia": "hager",
};

export function brandKey(v: unknown): string | null {
  const s = squash(v, 80);
  if (!s) return null;
  let k = s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  k = k.replace(/\b(pty|ltd|limited|inc|australia)\b/g, " ").replace(/\s+/g, " ").trim();
  if (!k) return null;
  return BRAND_ALIASES[k] ?? k;
}

/** Size/rating words as the online check compares them: ≤ 8 words of ≤ 30 characters. */
export function variantDetailsFrom(v: unknown): string[] {
  const text = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").join(" ") : typeof v === "string" ? v : "";
  return text.split(/\s+/).filter(Boolean).slice(0, 8).map((w) => w.slice(0, 30));
}

const colourKey = (v: unknown) => (squash(v, 40) ?? "").toLowerCase();
const variantWordsKey = (v: unknown) => variantDetailsFrom(v).map((w) => w.toLowerCase()).sort().join(" ");

export function checkApplies(
  check: { brand?: string | null; manufacturerCode?: string | null; colourFinish?: string | null; variantDetails?: string[] | null } | null | undefined,
  candidate: { brand?: string | null; colour?: string | null } | null | undefined,
  item: { brand?: string | null; manufacturerCode?: string | null; colourFinish?: string | null; variant?: string | null } | null | undefined,
): boolean {
  if (!check || !item) return false;
  const ck = codeKey(check.manufacturerCode);
  if (!ck || ck !== codeKey(item.manufacturerCode)) return false;
  const c = candidate ?? {};
  const sameOrFromListing = (checked: unknown, saved: unknown, listed: unknown, key: (v: unknown) => string) => {
    const a = key(checked);
    const b = key(saved);
    return a === b || (!a && Boolean(b) && b === key(listed));
  };
  if (!sameOrFromListing(check.brand, item.brand, c.brand, (v) => brandKey(v) ?? "")) return false;
  if (!sameOrFromListing(check.colourFinish, item.colourFinish, c.colour, colourKey)) return false;
  return variantWordsKey(check.variantDetails) === variantWordsKey(item.variant);
}
