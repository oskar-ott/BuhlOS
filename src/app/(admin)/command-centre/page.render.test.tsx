import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

/**
 * #185 — page-level SSR smoke for /command-centre with the Today strip.
 *
 * The page is an async server component, so we await it for JSX and
 * renderToString the result (node env), with next/headers + next/navigation
 * + the feature-flags CJS lib mocked and global fetch stubbed per-URL.
 *
 * What this file pins down (beyond TodayStrip.render.test.tsx, which covers
 * the strip's own states in isolation):
 *  - the strip's pending figure is the SAME loadSnapshot value the Hours
 *    queue card renders (one number, one source — NOT pulse.pendingCount);
 *  - a today-pulse failure renders the strip's error chip while every queue
 *    card still paints (per-source degradation);
 *  - all-clear integration: the strip participates — a calm zero day keeps
 *    All clear, a pulse load failure blocks it.
 */

const COOKIE_VALUE =
  Buffer.from(
    // Tier value from ADMIN_ROLES (src/lib/auth/roles.ts) — a non-"admin"
    // admin-tier role on purpose, so nothing in this page works only for
    // the literal role string.
    JSON.stringify({ userId: "u-boss", role: "boss" })
  ).toString("base64url") + ".test-signature";

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
  usePathname: () => "/command-centre",
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

// #760: AdminShell is now an async server component (it resolves the viewer's
// owner-disabled nav flags). renderToString can't render async components, so
// mock it to a sync passthrough — this test asserts page CONTENT, not the shell
// chrome (sidebar/nav are covered by their own unit + render tests).
vi.mock("@/components/admin/AdminShell", () => ({
  AdminShell: ({ children }: { children: unknown }) =>
    createElement("div", { "data-testid": "buhlos-admin-shell" }, children as never),
}));

// Only the CORE spine keeps a default-ON kill-switch (jobs/hours/evidence/
// employees/gear).
const CORE_ON = new Set(["jobs", "hours", "evidence", "employees", "gear"]);
vi.mock("../../../../api/_lib/feature-flags.js", () => ({
  isFlagEnabled: async (key: string) => CORE_ON.has(key),
  listFlags: () => [],
  isFlagOn: async () => false,
}));

import CommandCentrePage from "./page";

type JsonBody = Record<string, unknown>;

function jsonResponse(body: JsonBody, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function timeEntry(id: string): JsonBody {
  return {
    id,
    userId: `user-${id}`,
    date: "2026-06-11",
    totalHours: 8,
    ordinaryHours: 8,
    overtimeHours: 0,
    status: "submitted",
    submittedAt: "2026-06-11T07:30:00.000Z",
    allocations: [{ jobId: "j1", hours: 8 }],
    createdAt: "2026-06-11T07:00:00.000Z",
    updatedAt: "2026-06-11T07:30:00.000Z",
  };
}

const EMPTY_OVERVIEW: JsonBody = {
  range: { fromDate: "2026-06-05", toDate: "2026-06-11" },
  entries: [],
  totals: {
    totalHours: 0,
    byJob: [],
    byUser: [],
    byDate: [],
    byStatus: { draft: 0, submitted: 0, approved: 0, rejected: 0 },
  },
  missing: [],
  jobs: [],
  users: [],
};

function pulseBody(hours: Partial<Record<string, number>> = {}): JsonBody {
  return {
    date: "2026-06-12",
    hours: {
      submittedCount: 0,
      submittedTotal: 0,
      approvedCount: 0,
      approvedTotal: 0,
      pendingCount: 0,
      draftCount: 0,
      crewOnSite: 0,
      ...hours,
    },
    snags: { openedToday: 0, resolvedToday: 0 },
    jobs: { activeJobs: 0, jobsWithActivityToday: 0 },
  };
}

interface FetchFixtures {
  submittedEntries?: JsonBody[];
  /** Rejected-not-resubmitted entries for scope=approver&status=rejected. */
  rejectedEntries?: JsonBody[];
  pulse?: JsonBody;
  pulseStatus?: number;
  /** Display name for the mobile greeting (resolved via /api/auth?action=me). */
  meName?: string | null;
  /** Non-200 makes the jobs-with-stats fetch fail (board honest-degradation path). */
  jobsStatus?: number;
  /** Jobs rows for /api/jobs?withStats=1 (lean-reset leak tests feed stats). */
  jobs?: JsonBody[];
  /** admin-stats users.byRole roster (leading hands + tradies) for the on-clock ring. */
  byRole?: { admin: number; leadingHand: number; tradie: number; client: number };
  /** Non-200 makes the admin-stats fetch fail → ring degrades to a plain count. */
  adminStatsStatus?: number;
}

function stubFetch({
  submittedEntries = [],
  rejectedEntries = [],
  pulse,
  pulseStatus = 200,
  meName = null,
  jobsStatus = 200,
  jobs = [],
  byRole,
  adminStatsStatus = 200,
}: FetchFixtures) {
  const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      // admin-stats — the on-clock ring's roster denominator. Checked before
      // the broad /api/time-entries branches (none collide, but be explicit).
      if (url.includes("/api/admin-stats")) {
        if (adminStatsStatus !== 200) return jsonResponse({ error: "boom" }, adminStatsStatus);
        return jsonResponse({
          users: { byRole: byRole ?? { admin: 2, leadingHand: 0, tradie: 0, client: 0 } },
        });
      }
      if (url.includes("/api/today-pulse")) {
        if (pulseStatus !== 200) return jsonResponse({ error: "boom" }, pulseStatus);
        return jsonResponse(pulse ?? pulseBody());
      }
      if (url.includes("/api/time-entries-overview")) {
        return jsonResponse(EMPTY_OVERVIEW);
      }
      if (url.includes("/api/time-entries")) {
        const isSubmitted = url.includes("status=submitted");
        return jsonResponse({
          entries: isSubmitted ? submittedEntries : rejectedEntries,
        });
      }
      // /api/auth?action=me — the mobile greeting name. Must precede /api/jobs
      // (neither contains the other, but keep the auth check explicit).
      if (url.includes("/api/auth")) {
        return jsonResponse({ user: meName ? { name: meName, role: "boss" } : null });
      }
      if (url.includes("/api/jobs")) {
        if (jobsStatus !== 200) return jsonResponse({ error: "boom" }, jobsStatus);
        return jsonResponse({ jobs });
      }
      throw new Error(`unstubbed fetch in test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function renderPage(): Promise<string> {
  const jsx = await CommandCentrePage();
  return renderToString(jsx);
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/command-centre lean-reset board", () => {
  it("renders the summary sentence, the Needs-you queue and the Right-now strip from real counts", async () => {
    stubFetch({
      // Three pending days → the approval queue has work; one rejected day.
      submittedEntries: [timeEntry("t1"), timeEntry("t2"), timeEntry("t3")],
      rejectedEntries: [{ ...timeEntry("r1"), status: "rejected" }],
      pulse: pulseBody({ submittedTotal: 7.6, crewOnSite: 2 }),
    });
    const html = await renderPage();

    // Summary sentence — blocking clause (1 rejected) + pending clause (3 days).
    expect(html).toContain(
      "1 thing is holding up pay this week, and 3 days are waiting on your approval.",
    );
    // Needs-you queue rows with real counts + mono destination labels.
    expect(html).toContain("Needs you");
    expect(html).toContain("what blocks pay, first");
    expect(html).toContain('aria-label="Days waiting on your approval: 3"');
    expect(html).toContain('aria-label="Rejected day to re-submit: 1"');
    expect(html).toContain('href="/hours/approvals"');
    expect(html).toContain("Approve");
    // Zero loops render NO row (the queue shows only what's open).
    expect(html).not.toContain("Photos and tags to review");
    // Right-now strip tiles.
    expect(html).toContain("Right now");
    for (const label of ["on the clock", "logged today", "jobs live today"]) {
      expect(html).toContain(label);
    }
  });

  it("is calm on a zero day — all-clear sentence + All clear card, no queue rows", async () => {
    stubFetch({ submittedEntries: [], pulse: pulseBody() });
    const html = await renderPage();
    expect(html).toContain(
      "Nothing needs you. Every day this week is approved and no crew is waiting.",
    );
    expect(html).toContain("All clear");
    expect(html).not.toContain('aria-label="Rejected');
  });

  it("degrades the strip honestly when today-pulse fails — '—', not a fabricated 0, page still renders", async () => {
    stubFetch({ submittedEntries: [], pulseStatus: 503 });
    const html = await renderPage();
    expect(html).toContain("Right now");
    expect(html).toContain("on the clock");
    // A failed pulse → null signals render as an em-dash, never a fake number.
    expect(html).toContain("—");
  });

  it("shows an honest 'couldn't load every signal' card when a board source fails", async () => {
    stubFetch({ submittedEntries: [], pulse: pulseBody(), jobsStatus: 500 });
    const html = await renderPage();
    expect(html).toContain("Couldn’t load every signal");
    expect(html).toContain("Jobs API returned 500");
  });

  // ── Mobile home (md:hidden) — unchanged by the §2 board. ──
  it("renders the mobile home (md:hidden) with greeting + pulse", async () => {
    stubFetch({
      submittedEntries: [timeEntry("t1")],
      pulse: pulseBody({ submittedTotal: 8, crewOnSite: 2 }),
      meName: "Dana Boss",
    });
    const html = await renderPage();

    expect(html).toContain("md:hidden");
    expect(html).toContain("Dana");
    expect(html).toContain("here’s what needs you");
    // The desktop board is present too (wrapped hidden md:block).
    expect(html).toContain("Needs you");
    expect(html).toContain("Right now");
  });

  // ── Right-now fidelity ─────────────────────────────────────────────────
  it("shows the on-the-clock roster ratio (4/21-style suffix) when admin-stats supplies a roster", async () => {
    stubFetch({
      submittedEntries: [],
      pulse: pulseBody({ crewOnSite: 14 }),
      byRole: { admin: 3, leadingHand: 6, tradie: 15, client: 4 }, // roster = 21
    });
    const html = await renderPage();
    // Big-number tile with the honest crew/roster ratio.
    expect(html).toContain("/21");
    expect(html).toContain("on the clock");
  });

  it("degrades the ratio to a plain number when admin-stats fails (no fabricated roster)", async () => {
    stubFetch({
      submittedEntries: [],
      pulse: pulseBody({ crewOnSite: 14 }),
      adminStatsStatus: 503,
    });
    const html = await renderPage();
    // No denominator — just the count.
    expect(html).not.toContain("/21");
    expect(html).toContain("on the clock");
  });

  it("pluralises the pending queue row and keeps its approval routing at high counts", async () => {
    stubFetch({
      submittedEntries: Array.from({ length: 9 }, (_, i) => timeEntry(`t${i}`)),
      pulse: pulseBody(),
    });
    const html = await renderPage();
    expect(html).toContain('aria-label="Days waiting on your approval: 9"');
    expect(html).toContain('href="/hours/approvals"');
  });

  // ── The gut pass: deleted loops leave NO trace on the home ─────────────
  function jobWithStats(id: string, stats: JsonBody = {}): JsonBody {
    // statsCrewCount > 0 so the job-no-crew critical doesn't muddy the board.
    return { id, name: `Job ${id}`, status: "active", statsCrewCount: 2, ...stats };
  }

  it("snag/ITP counts on live job stats leave no tile, card or count", async () => {
    // The jobs fetch stays ON and its stats still carry snag/ITP numbers —
    // nothing here may surface them.
    stubFetch({
      submittedEntries: [],
      pulse: pulseBody(),
      jobs: [jobWithStats("j1", { statsSnagsV2Active: 3, statsItpsNeedsReview: 2 })],
    });
    const html = await renderPage();
    // No queue rows for the removed loops...
    expect(html).not.toContain("Open snags on live jobs");
    expect(html).not.toContain("ITPs waiting on sign-off");
    expect(html).not.toContain("open snag");
    // ...and the queue is honestly calm — the removed work is absent, not "0".
    expect(html).toContain("All clear");
  });
});
