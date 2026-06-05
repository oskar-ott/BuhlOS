import { expect, type Page } from "@playwright/test";

/**
 * Helpers for the deterministic Field-Readiness Smoke
 * (tests/playwright/smoke/field-readiness.spec.ts).
 *
 * They prove the core BuhlOS → Phil loop using the stable seeded fixture
 * `QA_SEED_FIELD_ACTIVE_JOB` (docs/testing/Seeded-Authenticated-QA.md) — the
 * one QA_SEED_ job allowed to stay Active, assigned to QA Field. Reuses the
 * existing auth/testData helpers; never logs a secret value.
 *
 * Strict mode (`BUHLOS_SMOKE_STRICT=1`, set by Preview Smoke) turns "fixture
 * missing" into a FAILURE instead of a skip — so credentialed coverage is
 * deterministic and never silently passes against incidental data.
 */
export const FIXTURE_JOB_NAME = "QA_SEED_FIELD_ACTIVE_JOB";

export const isStrict = (): boolean => !!process.env.BUHLOS_SMOKE_STRICT;

/**
 * The Phil job link for the seeded fixture. PhilJobsList renders
 * aria-label="Open <name>", so an EXACT accessible-name match means a
 * substring look-alike like "QA_SEED_FIELD_ACTIVE_JOB_2" ("Open …_2") does NOT
 * satisfy strict mode — only the exact fixture does.
 */
export function fixtureJobLink(page: Page) {
  return page.getByRole("link", { name: `Open ${FIXTURE_JOB_NAME}`, exact: true });
}

/** Open /phil/jobs and assert the field list is clean (no Draft/Archived leak). */
export async function gotoPhilJobsAndAssertCleanList(page: Page): Promise<void> {
  await page.goto("/phil/jobs");
  await expect(page.getByTestId("phil-shell")).toBeVisible();
  // The field surface must never expose Draft (or Archived) jobs — only active
  // assigned work. (Matches tests/playwright/smoke/phil.spec.ts.)
  await expect(page.getByText("Draft", { exact: true })).toHaveCount(0);
}

/**
 * Open the assigned ACTIVE fixture job from /phil/jobs.
 *   - strict: the exact fixture MUST be present (assigned + active) → click it.
 *   - local non-strict: open the fixture if present, else any assigned job,
 *     else return false so the caller can skip with an explicit reason.
 * Returns true if a job was opened.
 */
export async function openAssignedActiveJob(page: Page): Promise<boolean> {
  const link = fixtureJobLink(page);
  if (isStrict()) {
    await expect(
      link,
      `Strict Preview Smoke requires the exact seeded fixture "${FIXTURE_JOB_NAME}" ` +
        `active + assigned to QA Field (docs/testing/Seeded-Authenticated-QA.md).`
    ).toHaveCount(1);
    await link.first().click();
    return true;
  }
  if ((await link.count()) > 0) {
    await link.first().click();
    return true;
  }
  const anyJob = page.locator('a[href^="/phil/jobs/"]');
  if ((await anyJob.count()) > 0) {
    await anyJob.first().click();
    return true;
  }
  return false;
}

/**
 * Resolve the id of the seeded fixture job from /phil/jobs, so the hours smoke
 * can assert the Standard Day POST attributes to THAT specific assigned job —
 * not merely to "some" non-null job. PhilJobsList renders the link as
 * href="/phil/jobs/<encodeURIComponent(id)>", so the id is the (decoded) last
 * path segment.
 *   - strict: the exact fixture MUST be present (assigned + active) → its id.
 *   - local non-strict: the fixture id if present, else null so the caller falls
 *     back to a non-null (rather than exact-match) attribution check.
 */
export async function resolveAssignedFixtureJobId(page: Page): Promise<string | null> {
  await page.goto("/phil/jobs");
  await expect(page.getByTestId("phil-shell")).toBeVisible();
  const link = fixtureJobLink(page);
  if (isStrict()) {
    await expect(
      link,
      `Strict Preview Smoke requires the exact seeded fixture "${FIXTURE_JOB_NAME}" ` +
        `active + assigned to QA Field (docs/testing/Seeded-Authenticated-QA.md).`
    ).toHaveCount(1);
  } else if ((await link.count()) === 0) {
    return null;
  }
  const href = await link.first().getAttribute("href");
  const id = decodeURIComponent(href?.split("/").pop() ?? "");
  expect(
    id,
    `Could not parse a job id from the fixture link href "${href ?? "(null)"}".`
  ).toMatch(/.+/);
  return id;
}

/**
 * Assert the opened Phil job is the read-only field view: the field capture
 * affordance is present, and there are NO admin save/publish controls (those
 * belong to the builder, which the field role can't reach).
 */
export async function assertPhilJobReadOnly(page: Page): Promise<void> {
  await expect(page.getByTestId("phil-shell")).toBeVisible();
  await expect(page.getByRole("button", { name: /Capture evidence/i })).toBeVisible();
  await expect(page.getByText(/Save changes|Publish to field/i)).toHaveCount(0);
}

/** The field role must be redirected out of the admin builder, not shown it. */
export async function assertFieldLockedOutOfAdminBuilder(page: Page): Promise<void> {
  await page.goto("/v2/jobs/not-a-real-job/builder");
  await expect(page).toHaveURL(/\/phil\/my-day(?:\?|$)/);
}

/** Local-date YYYY-MM-DD `back` days before today (matches the app's localDateString). */
function localISODaysAgo(back: number): string {
  const d = new Date();
  d.setDate(d.getDate() - back);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * On /phil/my-day, satisfy the LogHoursSheet job-attribution block and select a
 * date whose Standard Day button is ENABLED:
 *   - multiple active jobs → pick the fixture radio (strict: it must exist);
 *   - exactly one active job → already preselected ("Assigned job" pill);
 *   - zero jobs → throw (a real fixture problem, surfaced, never skipped).
 * Then scan in-window dates for one not locked by an existing submitted/approved
 * entry, so the click is deterministic across reruns. Throws (does not skip) if
 * the whole backdate window is already filled.
 */
export async function prepareAttributedStandardDay(page: Page): Promise<void> {
  await expect(page.getByTestId("phil-shell")).toBeVisible();

  const radiogroup = page.getByRole("radiogroup", { name: /Choose the job for these hours/i });
  const assignedPill = page.getByText("Assigned job", { exact: true });

  if ((await radiogroup.count()) > 0) {
    const radio = page.getByRole("radio", { name: FIXTURE_JOB_NAME, exact: true });
    if (isStrict()) {
      await expect(
        radio,
        `Strict smoke needs the fixture "${FIXTURE_JOB_NAME}" among QA Field's active assigned jobs.`
      ).toHaveCount(1);
    }
    if ((await radio.count()) > 0) await radio.first().click();
    else await page.getByRole("radio").first().click(); // local fallback: any job
  } else if ((await assignedPill.count()) > 0) {
    // Exactly one active assigned job — preselected, no friction.
  } else {
    throw new Error(
      `LogHoursSheet shows no attributable job for QA Field. The fixture ` +
        `"${FIXTURE_JOB_NAME}" must be Active + assigned (docs/testing/Seeded-Authenticated-QA.md). ` +
        `Hours must never submit jobId:null when active jobs exist.`
    );
  }

  const button = page.getByRole("button", { name: /Submit Standard day/i });
  const dateInput = page.locator('input[type="date"]');
  for (let back = 0; back < 14; back++) {
    await dateInput.fill(localISODaysAgo(back));
    if (await button.isEnabled()) return;
  }
  throw new Error(
    "No submittable date in the backdate window — QA Field already has a logged entry " +
      "on every in-window day. Clear QA time entries or check the fixture; not skipping."
  );
}

/**
 * Click Standard Day, capture the POST /api/time-entries request, assert it
 * attributes the hours to the assigned job, then ABORT it before it reaches the
 * server.
 *
 * Attribution is checked at full strength:
 *   - the body carries a non-empty `allocations` array (explicit existence);
 *   - EVERY allocation carries a non-null jobId (a partial-null regression like
 *     [{null},{real}] must not slip through a "first truthy" search); and
 *   - when the caller passes the assigned job's id (`expectedJobId`, resolved via
 *     resolveAssignedFixtureJobId), every allocation's jobId must EQUAL it — so a
 *     regression that attributes to the wrong job ({ jobId: "some-other-job" })
 *     fails, not just an outright jobId:null.
 *
 * Why abort: the create endpoint writes to a Vercel Blob that may be SHARED
 * with production (docs/testing/Seeded-Authenticated-QA.md §9). Aborting proves
 * the real Phil UI attaches the job to the real request WITHOUT mutating any
 * (possibly production) data. Server-side attribution acceptance/rejection is
 * covered by the API unit tests added in #77
 * (src/domains/time-entries/time-entry-attribution-api.test.ts).
 *
 * Returns the attributed jobId the UI put on the wire.
 */
export async function submitStandardDayAndCaptureAttribution(
  page: Page,
  opts: { expectedJobId?: string | null } = {}
): Promise<string> {
  const { expectedJobId } = opts;
  let capturedAllocations: Array<{ jobId: string | null }> | null | undefined;
  await page.route("**/api/time-entries", async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.continue();
    const body = req.postDataJSON() as {
      allocations?: Array<{ jobId: string | null }>;
    } | null;
    capturedAllocations = body?.allocations ?? null;
    await route.abort(); // prod-safety: never let the write reach the (shared) Blob
  });

  const button = page.getByRole("button", { name: /Submit Standard day/i });
  await expect(button).toBeEnabled();
  await button.click();
  await expect
    .poll(() => capturedAllocations !== undefined, { timeout: 15_000 })
    .toBeTruthy();
  await page.unroute("**/api/time-entries");

  // Allocations must exist explicitly — a non-empty array, not a missing/empty
  // field that an "any truthy jobId" search would silently treat as attributed.
  expect(
    Array.isArray(capturedAllocations) && capturedAllocations.length > 0,
    "Standard Day POST must carry a non-empty allocations array."
  ).toBe(true);
  const allocations = capturedAllocations as Array<{ jobId: string | null }>;

  for (const a of allocations) {
    // Never jobId:null when the worker has an active assigned job (#77).
    expect(
      a.jobId,
      "Standard Day allocation must attach a non-null jobId — never jobId:null with an active assigned job."
    ).toBeTruthy();
    // When we know the assigned job, the hours must attribute to THAT job — not
    // merely to some non-null job.
    if (expectedJobId) {
      expect(
        a.jobId,
        `Standard Day must attribute to the assigned job "${expectedJobId}", got "${a.jobId}".`
      ).toBe(expectedJobId);
    }
  }

  return allocations[0]?.jobId as string;
}
