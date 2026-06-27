import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// The page imports the CJS flags lib directly; keep the readout dark.
vi.mock("../../../../api/_lib/feature-flags.js", () => ({
  isFlagEnabled: async () => false,
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
  pulse?: JsonBody;
  pulseStatus?: number;
  /** Submitted expense claims (the mobile "to approve" pulse + Approvals strip). */
  expenses?: JsonBody[];
  /** Display name for the mobile greeting (resolved via /api/auth?action=me). */
  meName?: string | null;
}

function stubFetch({
  submittedEntries = [],
  pulse,
  pulseStatus = 200,
  expenses = [],
  meName = null,
}: FetchFixtures) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/today-pulse")) {
        if (pulseStatus !== 200) return jsonResponse({ error: "boom" }, pulseStatus);
        return jsonResponse(pulse ?? pulseBody());
      }
      if (url.includes("/api/time-entries-overview")) {
        return jsonResponse(EMPTY_OVERVIEW);
      }
      if (url.includes("/api/time-entries")) {
        const isSubmitted = url.includes("status=submitted");
        return jsonResponse({ entries: isSubmitted ? submittedEntries : [] });
      }
      // /api/auth?action=me — the mobile greeting name. Must precede /api/jobs
      // (neither contains the other, but keep the auth check explicit).
      if (url.includes("/api/auth")) {
        return jsonResponse({ user: meName ? { name: meName, role: "boss" } : null });
      }
      if (url.includes("/api/expenses")) return jsonResponse({ expenses });
      if (url.includes("/api/jobs")) return jsonResponse({ jobs: [] });
      if (url.includes("/api/observations")) return jsonResponse({ observations: [] });
      if (url.includes("/api/material-requests")) return jsonResponse({ requests: [] });
      throw new Error(`unstubbed fetch in test: ${url}`);
    })
  );
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

describe("/command-centre with the Today strip (#185)", () => {
  it("leads with a populated strip whose pending figure matches the Hours queue card", async () => {
    stubFetch({
      // THREE pending entries from the hours source…
      submittedEntries: [timeEntry("t1"), timeEntry("t2"), timeEntry("t3")],
      // …while the pulse claims a different (today-only) pendingCount. The
      // strip must show the queue-card number, not the pulse's.
      pulse: pulseBody({
        submittedCount: 1,
        submittedTotal: 7.6,
        pendingCount: 1,
        crewOnSite: 2,
      }),
    });
    const html = await renderPage();

    // Strip: honest crew label + the shared pending figure.
    expect(html).toContain("on the clock");
    expect(html).toContain("logged hours today");
    expect(html).toContain("Pending approval: 3");
    expect(html).not.toContain("Pending approval: 1");
    // Queue card renders the same number from the same source.
    expect(html).toContain("Hours pending approval: 3");
    // Queues are present and unchanged.
    expect(html).toContain("Evidence to review");
    expect(html).toContain("Material requests");
    // Honesty: the crew stat is labelled by hours logged, never GPS presence.
    expect(html).toContain('aria-label="2 on the clock — logged hours today"');
  });

  it("renders the strip error chip while every queue still paints", async () => {
    stubFetch({
      submittedEntries: [timeEntry("t1")],
      pulseStatus: 500,
    });
    const html = await renderPage();

    // Per-source degradation: the strip says so…
    expect(html).toContain("Today’s pulse couldn’t load");
    expect(html).toContain("Today pulse API returned 500");
    // …the pending stat survives (it comes from the hours source)…
    expect(html).toContain("Pending approval: 1");
    // …and the queue cards all still render.
    for (const label of [
      "Hours pending approval",
      "Evidence to review",
      "Snags needing attention",
      "ITPs needing sign-off",
      "Observations to action",
      "Rejected hours",
      "Missing hours",
      "Plan mismatches",
      "Material requests",
    ]) {
      expect(html).toContain(label);
    }
    // A pulse failure is never "all clear". (The ExceptionsInbox empty state
    // has its own "All clear" heading, so assert the page card's unique copy.)
    expect(html).not.toContain("Nothing needs you right now");
  });

  it("keeps All clear on a calm zero day — the strip joins it, calmly", async () => {
    stubFetch({ submittedEntries: [], pulse: pulseBody() });
    const html = await renderPage();

    // The page-level all-clear card (not just the inbox's empty state).
    expect(html).toContain("Nothing needs you right now");
    expect(html).toContain("No hours logged yet today");
    // The zero state is neutral copy, not the strip's warning chip.
    expect(html).not.toContain("pulse couldn’t load");
  });

  it("blocks All clear when the pulse source failed, even with empty queues", async () => {
    stubFetch({ submittedEntries: [], pulseStatus: 503 });
    const html = await renderPage();

    expect(html).not.toContain("Nothing needs you right now");
    expect(html).toContain("Today’s pulse couldn’t load");
    // Queue cards still render their empty states.
    expect(html).toContain("No timesheets waiting for you.");
  });

  it("renders the mobile home (md:hidden) with greeting + pulse from the same data", async () => {
    stubFetch({
      submittedEntries: [timeEntry("t1")],
      pulse: pulseBody({ submittedTotal: 8, crewOnSite: 2 }),
      meName: "Dana Boss",
    });
    const html = await renderPage();

    // The mobile column exists, hidden on desktop (CSS gate, still in the SSR).
    expect(html).toContain("md:hidden");
    // Greeting uses the resolved display name (part-of-day varies by clock).
    expect(html).toContain("Dana");
    expect(html).toContain("here’s what needs you");
    // The navy pulse row's three honest segments.
    expect(html).toContain("on the clock");
    expect(html).toContain("logged today");
    expect(html).toContain("to approve");
    // The desktop tree is still present (wrapped hidden md:block).
    expect(html).toContain("Needs your attention");
  });
});
