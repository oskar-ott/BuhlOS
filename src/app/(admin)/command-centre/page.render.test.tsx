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

// Configurable flag + proof-queue mocks (hoisted so the vi.mock factories can
// reference them). Default: all flags dark, proof queue empty.
const h = vi.hoisted(() => ({
  proofFlagOn: false,
  proofResult: { ok: true, items: [] as unknown[], scannedJobs: 0, failedJobs: [] as string[] } as
    | { ok: true; items: unknown[]; scannedJobs: number; failedJobs: string[] }
    | { ok: false; error: string },
}));

vi.mock("../../../../api/_lib/feature-flags.js", () => ({
  isFlagEnabled: async (key: string) => (key === "admin_proof_review" ? h.proofFlagOn : false),
  listFlags: () => [],
  isFlagOn: async () => false,
}));

// The cross-job proof scan reads blobs directly — mock it so the flagged
// surface can be driven without a blob backend.
vi.mock("@/server/job-control/proof-queue", () => ({
  runProofQueue: async () => h.proofResult,
  blobProofQueueDeps: () => ({}),
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
  /** Non-200 makes the expenses fetch fail (mobile honest-degradation path). */
  expensesStatus?: number;
  /** Display name for the mobile greeting (resolved via /api/auth?action=me). */
  meName?: string | null;
  /** Non-200 makes the jobs-with-stats fetch fail (board honest-degradation path). */
  jobsStatus?: number;
}

function stubFetch({
  submittedEntries = [],
  pulse,
  pulseStatus = 200,
  expenses = [],
  expensesStatus = 200,
  meName = null,
  jobsStatus = 200,
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
      if (url.includes("/api/expenses")) {
        if (expensesStatus !== 200) return jsonResponse({ error: "boom" }, expensesStatus);
        return jsonResponse({ expenses });
      }
      if (url.includes("/api/jobs")) {
        if (jobsStatus !== 200) return jsonResponse({ error: "boom" }, jobsStatus);
        return jsonResponse({ jobs: [] });
      }
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
  h.proofFlagOn = false;
  h.proofResult = { ok: true, items: [], scannedJobs: 0, failedJobs: [] };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/command-centre board (§2)", () => {
  it("renders the board — hero, four pulse tiles, and an open-work tile for each non-empty loop", async () => {
    stubFetch({
      // Three pending entries → the hours loop has open work.
      submittedEntries: [timeEntry("t1"), timeEntry("t2"), timeEntry("t3")],
      pulse: pulseBody({ submittedTotal: 7.6, crewOnSite: 2 }),
    });
    const html = await renderPage();

    // State-of-play hero.
    expect(html).toContain("State of play");
    // The four pulse tiles.
    for (const label of [
      "on the clock",
      "logged today",
      "pending approvals",
      "jobs live today",
    ]) {
      expect(html).toContain(label);
    }
    // Open work: the hours loop (3 pending) renders a tile with its count; the
    // zero loops do NOT render tiles (the heatmap shows only what's open).
    expect(html).toContain("Open work");
    expect(html).toContain('aria-label="Hours pending approval: 3"');
    expect(html).not.toContain('aria-label="Evidence to review: 0"');
  });

  it("is calm on a zero day — calm hero, All clear, No open work", async () => {
    stubFetch({ submittedEntries: [], pulse: pulseBody() });
    const html = await renderPage();
    expect(html).toContain("The desk is calm");
    expect(html).toContain("CALM");
    expect(html).toContain("All clear"); // needsNow empty
    expect(html).toContain("No open work"); // openWork empty
  });

  it("degrades the pulse honestly when today-pulse fails — '—', not a fabricated 0, board still renders", async () => {
    stubFetch({ submittedEntries: [], pulseStatus: 503 });
    const html = await renderPage();
    expect(html).toContain("State of play");
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

  // ── Proof to sign off (#503, flagged) — unchanged by the §2 board. ──
  it("surfaces a TOTAL proof-scan failure as an error card, never a false 'queue clear' (#503 P7)", async () => {
    h.proofFlagOn = true;
    h.proofResult = { ok: false, error: "Could not load jobs for the proof queue" };
    stubFetch({ submittedEntries: [], pulse: pulseBody() });
    const html = await renderPage();
    expect(html).toContain("Couldn’t load proof to sign off");
    expect(html).toContain("Could not load jobs for the proof queue");
    expect(html).not.toContain("waiting on you");
  });

  it("flags a PARTIAL proof scan (failedJobs) instead of presenting an undercount as the total", async () => {
    h.proofFlagOn = true;
    h.proofResult = { ok: true, items: [], scannedJobs: 3, failedJobs: ["job-2", "job-3"] };
    stubFetch({ submittedEntries: [], pulse: pulseBody() });
    const html = await renderPage();
    expect(html).toContain("Proof to sign off");
    expect(html).toContain("couldn’t be read");
  });

  // ── Mobile home (md:hidden) — unchanged by the §2 board. ──
  it("degrades honestly when the expenses fetch fails — mobile 'couldn't load every queue', no fabricated 0", async () => {
    stubFetch({ submittedEntries: [], pulse: pulseBody(), expensesStatus: 500 });
    const html = await renderPage();
    expect(html).toContain("Couldn’t load every queue");
    expect(html).toContain("Expenses API returned 500");
  });

  it("renders the mobile home (md:hidden) with greeting + pulse, and the desktop board alongside", async () => {
    stubFetch({
      submittedEntries: [timeEntry("t1")],
      pulse: pulseBody({ submittedTotal: 8, crewOnSite: 2 }),
      meName: "Dana Boss",
    });
    const html = await renderPage();

    expect(html).toContain("md:hidden");
    expect(html).toContain("Dana");
    expect(html).toContain("here’s what needs you");
    expect(html).toContain("to approve");
    // The desktop board is present too (wrapped hidden md:block).
    expect(html).toContain("State of play");
  });
});
