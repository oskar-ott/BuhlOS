import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { BUSINESS_TIMEZONE, localDateString } from "@/domains/timesheets/service";

/**
 * Page-level SSR smoke for the SHARPENED /phil/my-day (phil_sharpened, dark).
 *
 * The page is an async server component — await it for JSX, renderToString
 * the result (command-centre page.render.test.tsx precedent), with
 * next/headers + next/navigation mocked, the in-process data loaders
 * (api/_lib/phil-page-data.js — the page stopped self-fetching its own HTTP
 * API, 2026-08-03) stubbed with the same shapes, and the sharpened flag
 * resolver forced on.
 *
 * What this file pins (the usability-fix contract):
 *   - ONE hours affordance: the quick grid's "Log hours now" tile — the old
 *     week strip and the always-visible day-logger form are GONE from the
 *     sharpened render (the Hours tab, W2c, is the logging home).
 *   - the ?fixDate= deep-link contract still holds without the day-logger:
 *     a rejected day's link renders the focused fix card with the SAME
 *     resubmit sheet auto-opened; a non-rejected day renders no fix card.
 *   - lean reset: the quick-capture tiles and the reimbursements section are
 *     GONE with their features, so NEITHER renders — no trace of a deleted
 *     feature.
 */

const COOKIE_VALUE =
  Buffer.from(JSON.stringify({ userId: "u-sparky", role: "electrician" })).toString(
    "base64url",
  ) + ".test-signature";

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "buhl_session" ? { name, value: COOKIE_VALUE } : undefined,
  }),
  headers: async () => ({ get: () => null }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`unexpected redirect to ${url}`);
  },
  usePathname: () => "/phil/my-day",
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
}));

// Force the sharpened flag on (server-resolved boolean); keep the rest of the
// module (philInitials / philOnSiteSince) real.
vi.mock("@/lib/phil/sharpened", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/phil/sharpened")>();
  return {
    ...actual,
    philSharpenedFlags: async () => ({
      sharpened: true,
      jobRooms: false,
    }),
  };
});

// The attention stream is an ASYNC server component inside <Suspense> —
// renderToString can't render async components, so stub it (its own states
// are covered by PhilMyDaySharpened.render.test.tsx / needs-you tests).
vi.mock("@/components/phil/PhilMyDaySharpenedAttention", () => ({
  PhilMyDaySharpenedAttention: () => null,
  PhilMyDaySharpenedAttentionFallback: () => null,
}));

// The page's data now arrives via the in-process loaders, not HTTP self-
// fetches — stub them with the SAME response shapes the handlers serve.
// `inProcess` is a mutable holder so individual tests can swap the data
// (the old per-test fetch re-stub, without the fetch).
const inProcess = vi.hoisted(() => ({
  user: { role: "electrician", name: "Sam Payne" } as unknown,
  entries: [] as unknown[],
  jobs: [] as unknown[],
}));
vi.mock("../../../../api/_lib/phil-page-data.js", () => ({
  loadCurrentUserInProcess: async () => inProcess.user,
  loadWorkerEntriesInProcess: async () => ({
    ok: true,
    status: 200,
    entries: inProcess.entries,
  }),
  loadFieldJobsInProcess: async () => ({ ok: true, jobs: inProcess.jobs }),
}));

// "Today" must match the PAGE's clock — Sydney (BUSINESS_TIMEZONE), not UTC.
// The UTC version was a #812-family time bomb: every Sydney morning before
// 10:00 AEST the UTC date is still yesterday, the mocked "today" entry lands
// on the wrong day, and the banner "wrongly" renders.
const TODAY = localDateString(new Date(), BUSINESS_TIMEZONE);
// A rejected day inside the 7-day window (yesterday-ish, never "today").
const REJECTED_DATE = new Date(Date.now() - 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);
// An approved day two days back — a fixDate pointing here has nothing to fix.
const APPROVED_DATE = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);

function entry(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "te-x",
    userId: "u-sparky",
    userName: "sparky",
    date: TODAY,
    totalHours: 7.6,
    ordinaryHours: 7.6,
    overtimeHours: 0,
    notes: null,
    status: "submitted",
    allocations: [{ jobId: "job-1", hours: 7.6 }],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

function entriesBody() {
  return {
    entries: [
      entry({
        id: "te-rejected",
        date: REJECTED_DATE,
        status: "rejected",
        rejectedReason: "Wrong job — this was the bakery day.",
      }),
      entry({ id: "te-approved", date: APPROVED_DATE, status: "approved" }),
    ],
  };
}

beforeEach(() => {
  inProcess.user = { role: "electrician", name: "Sam Payne" };
  inProcess.entries = entriesBody().entries;
  inProcess.jobs = [
    {
      id: "job-1",
      name: "Birdwood Estate",
      status: "active",
      ref: null,
      siteAddress: "12 Birdwood Rd",
    },
  ];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderPage(fixDate?: string): Promise<string> {
  const { default: MyDayPage } = await import("./page");
  const jsx = await MyDayPage({
    searchParams: Promise.resolve(fixDate ? { fixDate } : {}),
  });
  return renderToString(jsx);
}

describe("sharpened /phil/my-day — one hours affordance", () => {
  it("renders the Log-hours tile but NOT the old week strip or day-logger form", async () => {
    const html = await renderPage();
    expect(html).toContain('data-testid="phil-my-day-sharpened"');
    // The one hours affordance: the quick grid tile to the Hours tab.
    expect(html).toContain("Log hours now");
    // The competing old widgets are gone from the sharpened render.
    expect(html).not.toContain("This week"); // PhilWeekStrip
    expect(html).not.toContain("Standard day"); // LogHoursSheet's big action
    expect(html).not.toContain('data-testid="split-across-jobs"');
    // Lean reset: the quick-capture tiles and the reimbursements section were
    // deleted with their features — they leave NO trace.
    expect(html).not.toContain("Quick actions");
    expect(html).not.toContain("Reimbursements");
  });

  it("no ?fixDate= → no fix card", async () => {
    const html = await renderPage();
    expect(html).not.toContain("phil-my-day-fix-card");
  });

  it("renders the yellow Log-hours banner with real WEEK progress while today is unlogged", async () => {
    // The default mock has no entry dated today. Weekly-first (owner
    // directive 2026-08-08): the subline counts the week's real entries
    // against the weekdays elapsed, never a daily "today not logged" nag.
    const html = await renderPage();
    expect(html).toContain('data-testid="phil-my-day-log-hours-banner"');
    expect(html).toMatch(/\d+ of \d+ days? logged this week/);
    expect(html).not.toContain("Today not logged ·");
  });

  it("drops the banner once today has a real entry — its claim would be false", async () => {
    inProcess.entries = [entry({ id: "te-today", date: TODAY, status: "submitted" })];
    inProcess.jobs = [];
    const html = await renderPage();
    expect(html).not.toContain("phil-my-day-log-hours-banner");
    expect(html).not.toContain("Today not logged");
  });
});

describe("sharpened /phil/my-day — the ?fixDate= deep-link contract", () => {
  it("a rejected day's link renders the fix card with the REAL reason and the resubmit sheet open", async () => {
    const html = await renderPage(REJECTED_DATE);
    expect(html).toContain('data-testid="phil-my-day-fix-card"');
    expect(html).toContain("was sent back");
    expect(html).toContain("Wrong job — this was the bakery day.");
    // The SAME tested resubmit flow, auto-opened: its submit action renders.
    expect(html).toContain("Submit correction");
    // Still no day-logger — the fixer is focused, not a third hours form.
    expect(html).not.toContain("Standard day");
  });

  it("a non-rejected day's link renders NO fix card (nothing to fix — honest absence)", async () => {
    const html = await renderPage(APPROVED_DATE);
    expect(html).not.toContain("phil-my-day-fix-card");
  });
});
