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
 * The job on the worker's OWN list already carrying the code the form has
 * composed — the client-side pre-guard. Matching against their own list
 * leaks nothing (they can already see these jobs), and the server stays the
 * real enforcement for codes on jobs they can't see. Returns the clashing
 * job's id + name so the form can say "that's {name} — already on your
 * list" instead of letting Create fire into a guaranteed 409.
 */
export function jobOnListWithCode(
  jobs: ReadonlyArray<Pick<Job, "id" | "name" | "code">>,
  code: string,
): { id: string; name: string } | null {
  const want = code.trim().toUpperCase();
  if (!CODE_RE.test(want)) return null;
  for (const j of jobs) {
    if (typeof j.code !== "string" || typeof j.id !== "string" || !j.id) continue;
    if (j.code.trim().toUpperCase() === want) {
      return { id: j.id, name: j.name };
    }
  }
  return null;
}

/**
 * The pre-guard as the form uses it: the clashing own-list job for the 4
 * digits currently typed, or null while the entry is incomplete (no nagging
 * mid-type) or the code is free on the worker's list.
 */
export function newJobCodeClash(
  jobs: ReadonlyArray<Pick<Job, "id" | "name" | "code">>,
  digits: string,
): { id: string; name: string } | null {
  if (!/^\d{4}$/.test(digits)) return null;
  return jobOnListWithCode(jobs, codeFromDigits(digits));
}

/**
 * Find the id of the job carrying `code` in a GET /api/jobs list reply —
 * the timeout-recovery probe. A create POST can outlive the client write
 * budget (multi-blob-write path) yet still land; if the submitted code is
 * now on the worker's own list, the create DID succeed and the form must
 * not tell the worker it "may not have sent" (a retry would only bounce off
 * their own job). Defensive over the raw parsed JSON — any unexpected shape
 * is just "not found".
 */
export function findJobIdByCode(
  jobs: ReadonlyArray<unknown>,
  code: string,
): string | null {
  const want = code.trim().toUpperCase();
  if (!CODE_RE.test(want)) return null;
  for (const j of jobs) {
    if (!j || typeof j !== "object") continue;
    const { id, code: c } = j as { id?: unknown; code?: unknown };
    if (
      typeof id === "string" &&
      id &&
      typeof c === "string" &&
      c.trim().toUpperCase() === want
    ) {
      return id;
    }
  }
  return null;
}

/** What the timeout-recovery probe concluded. */
export type TimeoutRecovery =
  /** A job with the submitted code appeared that was NOT on the worker's
   *  list before submit — the create landed; navigate to it. */
  | { outcome: "created"; id: string }
  /** The code belongs to a job that was ALREADY on the worker's list before
   *  submit — the create can't have happened (the server 409s duplicate
   *  codes). Success must not be claimed off someone else's job. */
  | { outcome: "preexisting" }
  /** Probe failed or the code isn't on the list — no evidence either way. */
  | { outcome: "unknown" };

/**
 * After a philWrite TIMEOUT (and only a timeout — every other failure means
 * the server definitely didn't confirm), one cheap list read decides whether
 * the create actually landed. `preSubmitJobIds` is the snapshot of job ids
 * on the worker's list when Create was tapped: only a job whose id was NOT
 * in that snapshot counts as "my create landed". A pre-existing job merely
 * sharing the code is an honest failure, never a success — otherwise a
 * duplicate code would navigate the worker into an unrelated existing job
 * claiming the create worked. Any fetch/parse error is "unknown" — recovery
 * is best-effort; the honest failure line is the fallback.
 */
export async function recoverJobIdAfterTimeout(
  code: string,
  preSubmitJobIds: ReadonlySet<string>,
  fetchImpl: typeof fetch = fetch,
): Promise<TimeoutRecovery> {
  try {
    const res = await fetchImpl("/api/jobs", { cache: "no-store" });
    if (!res.ok) return { outcome: "unknown" };
    const raw = (await res.json()) as { jobs?: unknown };
    if (!raw || !Array.isArray(raw.jobs)) return { outcome: "unknown" };
    const id = findJobIdByCode(raw.jobs, code);
    if (!id) return { outcome: "unknown" };
    return preSubmitJobIds.has(id)
      ? { outcome: "preexisting" }
      : { outcome: "created", id };
  } catch {
    return { outcome: "unknown" };
  }
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
