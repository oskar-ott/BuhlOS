/**
 * Pure, framework-neutral validator for the Field-Readiness Smoke's hours
 * attribution check.
 *
 * The smoke (tests/playwright/smoke/field-readiness.spec.ts) intercepts the real
 * `POST /api/time-entries` that the Phil "Standard Day" button produces and
 * asserts the logged hours attribute to the *exact* assigned job — the #77
 * guarantee. That rule lives here, separate from Playwright, so its negative
 * cases (null / wrong / missing / malformed attribution) run under
 * `npm run test:unit` in normal CI — not only when a credentialed Preview Smoke
 * runs.
 *
 * This is TEST-SUPPORT logic. It is intentionally NOT imported by any app route
 * or API; it only inspects the shape of a captured request body, reads/mutates
 * nothing, and has no side effects. It mirrors the `{ ok, reason }` result shape
 * of the sibling Preview Smoke URL guard (see src/domains/qa/preview-url.test.ts
 * → scripts/qa/validate-preview-url.js).
 */

export type AttributionCheckResult = { ok: true } | { ok: false; reason: string };

/** A safe, human-readable label for an arbitrary value in a failure message. */
function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Validate that a captured `POST /api/time-entries` body attributes EVERY
 * allocation to `expectedJobId` (the resolved assigned fixture job).
 *
 * Returns `{ ok: true }` only when:
 *   - `expectedJobId` is a non-empty string (strict equality needs a target);
 *   - `body` is a non-null object (not an array);
 *   - `body.allocations` exists, is an array, and is non-empty;
 *   - every allocation is an object with a non-null, non-empty string `jobId`;
 *   - every allocation's `jobId` strictly equals `expectedJobId`.
 *
 * Otherwise returns `{ ok: false, reason }` with a diagnosable message. It never
 * throws and has no side effects, so a Playwright caller can do
 * `expect(result.ok, result.ok ? "" : result.reason).toBe(true)`.
 */
export function assertTimeEntryPostUsesExpectedJob(
  body: unknown,
  expectedJobId: unknown
): AttributionCheckResult {
  // Guard the target first: an empty/missing expected id must never silently
  // "pass" by being compared against nothing.
  if (typeof expectedJobId !== "string" || expectedJobId.length === 0) {
    return {
      ok: false,
      reason: `expectedJobId must be a non-empty string to assert job attribution (got ${kindOf(
        expectedJobId
      )}).`,
    };
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      ok: false,
      reason: `malformed time-entry POST body — expected an object (got ${kindOf(body)}).`,
    };
  }

  const allocations = (body as { allocations?: unknown }).allocations;
  if (allocations === undefined || allocations === null) {
    return { ok: false, reason: "time-entry POST body is missing `allocations`." };
  }
  if (!Array.isArray(allocations)) {
    return {
      ok: false,
      reason: `time-entry POST \`allocations\` must be an array (got ${kindOf(allocations)}).`,
    };
  }
  if (allocations.length === 0) {
    return {
      ok: false,
      reason: "time-entry POST `allocations` is empty — the Standard Day attributed no job.",
    };
  }

  for (let i = 0; i < allocations.length; i++) {
    const allocation = allocations[i];
    if (typeof allocation !== "object" || allocation === null || Array.isArray(allocation)) {
      return {
        ok: false,
        reason: `time-entry allocation[${i}] is not an object (got ${kindOf(allocation)}).`,
      };
    }

    const jobId = (allocation as { jobId?: unknown }).jobId;
    if (jobId === null || jobId === undefined || jobId === "") {
      return {
        ok: false,
        reason: `time-entry allocation[${i}] has a null/empty jobId — hours must never be submitted with jobId:null when an active assigned job exists.`,
      };
    }
    if (typeof jobId !== "string") {
      return {
        ok: false,
        reason: `time-entry allocation[${i}] jobId must be a string (got ${kindOf(jobId)}).`,
      };
    }
    if (jobId !== expectedJobId) {
      return {
        ok: false,
        reason: `time-entry allocation[${i}] attributes to the wrong job — expected "${expectedJobId}", got "${jobId}".`,
      };
    }
  }

  return { ok: true };
}
