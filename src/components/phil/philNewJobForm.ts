import type { Job } from "@/domains/jobs/types";

/**
 * Pure logic for the sharpened "+ New job" form (phil_sharpened, dark —
 * Wave 2b). Extracted from PhilNewJobSheet so the format/derivation rules the
 * server also enforces (api/_lib/job-create.js) are unit-testable without a
 * DOM.
 *
 * Job codes are strictly `IV` + 4 digits. Two families share the one format:
 *   - ServiceMate numbers — the office system's real job refs.
 *   - Custom/self-made refs — live in the 7000s (IV7001…) so they can never
 *     clash with a real ServiceMate code; the office matches them later.
 * Server-side both are just codes (validated + uniqueness-checked there —
 * this module only helps the worker land on a valid, probably-free one).
 */

export const CODE_PREFIX = "IV";

/** Custom/self-made refs live in [7001..7999] (IV7000 is reserved as the
 *  range marker; the prototype's default is IV7001). */
const CUSTOM_MIN = 7001;
const CUSTOM_MAX = 7999;

const CODE_RE = /^IV(\d{4})$/;

/** Keep only digits, capped at the 4 the format allows. */
export function sanitizeDigits(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, 4);
}

/** True when the form can submit: a real name + exactly 4 code digits. */
export function canCreateJobInput(name: string, digits: string): boolean {
  return name.trim().length > 0 && /^\d{4}$/.test(digits);
}

/** The full code a digits entry produces ("0041" → "IV0041"). */
export function codeFromDigits(digits: string): string {
  return `${CODE_PREFIX}${digits}`;
}

/**
 * The REAL IV#### codes present on the worker's job list — nothing invented
 * (P7): no code field on a job, no entry. Uppercased + de-duplicated, list
 * order preserved.
 */
export function realCodesOnList(
  jobs: ReadonlyArray<Pick<Job, "code">>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const j of jobs) {
    if (typeof j.code !== "string") continue;
    const c = j.code.trim().toUpperCase();
    if (!CODE_RE.test(c) || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

/**
 * The next free 7000-series number, as 4 digits ("7001"), computed from the
 * ACTUAL codes on the jobs the client already has: the smallest number in
 * [7001..7999] no listed code uses. Returns null only when the whole range is
 * taken (the form then leaves the input empty — the server validates anyway,
 * so a stale/partial list can at worst produce an honest 409, never a bad
 * write).
 */
export function nextFree7000(existingCodes: ReadonlyArray<string>): string | null {
  const taken = new Set<number>();
  for (const raw of existingCodes) {
    const m = CODE_RE.exec(String(raw).trim().toUpperCase());
    if (!m) continue;
    const n = Number(m[1]);
    if (n >= CUSTOM_MIN && n <= CUSTOM_MAX) taken.add(n);
  }
  for (let n = CUSTOM_MIN; n <= CUSTOM_MAX; n++) {
    if (!taken.has(n)) return String(n);
  }
  return null;
}
