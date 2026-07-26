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

// Configurable flag + proof-queue mocks (hoisted so the vi.mock factories can
// reference them). Default: all flags dark, proof queue empty.
const h = vi.hoisted(() => ({
  proofFlagOn: false,
  proofResult: { ok: true, items: [] as unknown[], scannedJobs: 0, failedJobs: [] as string[] } as
    | { ok: true; items: unknown[]; scannedJobs: number; failedJobs: string[] }
    | { ok: false; error: string },
  // #276 chase — rfi_register flag + the cross-job RFI scan result.
  rfiFlagOn: false,
  rfiScanCalls: 0,
  rfiResult: { rfis: [] as unknown[], scannedJobs: 0, failedJobs: [] as string[] },
  // Lean reset (2026-07): the flag-gated Command Centre sources (expenses,
  // itp, snags, observations_inbox, material_requests, reports) default OFF,
  // mirroring the registry. Tests opt a feature on per-case via this set.
  flagsOn: new Set<string>(),
}));

// Only the CORE spine keeps a default-ON kill-switch (jobs/hours/evidence/
// employees/gear); every lean-reset feature defaults dark. admin_proof_review
// + rfi_register stay driven by their dedicated per-test knobs.
const CORE_ON = new Set(["jobs", "hours", "evidence", "employees", "gear"]);
vi.mock("../../../../api/_lib/feature-flags.js", () => ({
  isFlagEnabled: async (key: string) =>
    key === "admin_proof_review"
      ? h.proofFlagOn
      : key === "rfi_register"
        ? h.rfiFlagOn
        : CORE_ON.has(key) || h.flagsOn.has(key),
  listFlags: () => [],
  isFlagOn: async () => false,
}));

// The cross-job proof scan reads blobs directly — mock it so the flagged
// surface can be driven without a blob backend.
vi.mock("@/server/job-control/proof-queue", () => ({
  runProofQueue: async () => h.proofResult,
  blobProofQueueDeps: () => ({}),
}));

// #276 — the cross-job RFI scan reads blobs directly too; mocked + counted so
// the tests can also assert "flag off ⇒ the scan never runs" (zero reads).
vi.mock("@/server/rfi/overdue-rfis", () => ({
  runRfiScan: async () => {
    h.rfiScanCalls += 1;
    return h.rfiResult;
  },
  blobRfiScanDeps: () => ({}),
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
  /** Submitted expense claims (the mobile "to approve" pulse + Approvals strip). */
  expenses?: JsonBody[];
  /** Non-200 makes the expenses fetch fail (mobile honest-degradation path). */
  expensesStatus?: number;
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
  expenses = [],
  expensesStatus = 200,
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
      if (url.includes("/api/expenses")) {
        if (expensesStatus !== 200) return jsonResponse({ error: "boom" }, expensesStatus);
        return jsonResponse({ expenses });
      }
      if (url.includes("/api/jobs")) {
        if (jobsStatus !== 200) return jsonResponse({ error: "boom" }, jobsStatus);
        return jsonResponse({ jobs });
      }
      if (url.includes("/api/observations")) return jsonResponse({ observations: [] });
      if (url.includes("/api/material-requests")) return jsonResponse({ requests: [] });
      throw new Error(`unstubbed fetch in test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  // Returned so lean-reset tests can assert a dark source was never fetched.
  return fetchMock;
}

async function renderPage(): Promise<string> {
  const jsx = await CommandCentrePage();
  return renderToString(jsx);
}

beforeEach(() => {
  vi.unstubAllGlobals();
  h.proofFlagOn = false;
  h.proofResult = { ok: true, items: [], scannedJobs: 0, failedJobs: [] };
  h.rfiFlagOn = false;
  h.rfiScanCalls = 0;
  h.rfiResult = { rfis: [], scannedJobs: 0, failedJobs: [] };
  h.flagsOn = new Set();
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

  // ── Proof to sign off (#503, flagged) — unchanged by the §2 board. ──
  it("surfaces a TOTAL proof-scan failure as an error card, never a false 'queue clear' (#503 P7)", async () => {
    h.proofFlagOn = true;
    h.proofResult = { ok: false, error: "Could not load jobs for the proof queue" };
    stubFetch({ submittedEntries: [], pulse: pulseBody() });
    const html = await renderPage();
    expect(html).toContain("Couldn’t load proof to sign off");
    expect(html).toContain("Could not load jobs for the proof queue");
    expect(html).not.toContain("with site photos waiting on you");
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
  it("degrades honestly when the expenses fetch fails (flag on) — mobile 'couldn't load every queue', no fabricated 0", async () => {
    h.flagsOn.add("expenses");
    stubFetch({ submittedEntries: [], pulse: pulseBody(), expensesStatus: 500 });
    const html = await renderPage();
    expect(html).toContain("Couldn’t load every queue");
    expect(html).toContain("Expenses API returned 500");
  });

  it("renders the mobile home (md:hidden) with greeting + pulse — no 'to approve' segment while every approvals source is dark", async () => {
    stubFetch({
      submittedEntries: [timeEntry("t1")],
      pulse: pulseBody({ submittedTotal: 8, crewOnSite: 2 }),
      meName: "Dana Boss",
    });
    const html = await renderPage();

    expect(html).toContain("md:hidden");
    expect(html).toContain("Dana");
    expect(html).toContain("here’s what needs you");
    // Lean reset: expenses/ITPs/materials are all dark, so the approvals pulse
    // (whose count is those three queues) leaves no trace — not a "0".
    expect(html).not.toContain("to approve");
    // The desktop board is present too (wrapped hidden md:block).
    expect(html).toContain("Needs you");
    expect(html).toContain("Right now");
  });

  it("shows the mobile 'to approve' pulse again when an approvals source (expenses) is live", async () => {
    h.flagsOn.add("expenses");
    stubFetch({
      submittedEntries: [],
      pulse: pulseBody(),
      meName: "Dana Boss",
    });
    const html = await renderPage();
    expect(html).toContain("to approve");
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

  it("hides the 'Owner numbers' link while the reports flag is dark (lean reset — /reports 404s)", async () => {
    stubFetch({ submittedEntries: [], pulse: pulseBody() });
    const html = await renderPage();
    expect(html).not.toContain("Owner numbers");
    expect(html).not.toContain('href="/reports"');
  });

  it("renders the date subline + the 'Owner numbers' link to /reports when the reports flag is on", async () => {
    h.flagsOn.add("reports");
    stubFetch({ submittedEntries: [], pulse: pulseBody() });
    const html = await renderPage();
    expect(html).toContain("Owner numbers");
    expect(html).toContain('href="/reports"');
  });

  // ── Lean reset (2026-07): dark features leave NO trace on the home ──────
  function jobWithStats(id: string, stats: JsonBody = {}): JsonBody {
    // statsCrewCount > 0 so the job-no-crew critical doesn't muddy the board.
    return { id, name: `Job ${id}`, status: "active", statsCrewCount: 2, ...stats };
  }

  it("never fetches a dark source — no error chip even when its API would fail (dark ≠ failed)", async () => {
    // expenses/observations/material-requests flags are dark by default here;
    // the 500 must be unreachable because the fetch is skipped entirely.
    const fetchMock = stubFetch({ submittedEntries: [], pulse: pulseBody(), expensesStatus: 500 });
    const html = await renderPage();
    expect(html).not.toContain("Couldn’t load every queue");
    expect(html).not.toContain("Couldn’t load every signal");
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/api/expenses"))).toBe(false);
    expect(urls.some((u) => u.includes("/api/observations"))).toBe(false);
    expect(urls.some((u) => u.includes("/api/material-requests"))).toBe(false);
  });

  it("snag/ITP counts on live job stats leave no tile, card or count while those flags are dark", async () => {
    // The jobs fetch stays ON and its stats still carry snag/ITP numbers —
    // the belt-and-braces gating must stop them surfacing anywhere.
    stubFetch({
      submittedEntries: [],
      pulse: pulseBody(),
      jobs: [jobWithStats("j1", { statsSnagsV2Active: 3, statsItpsNeedsReview: 2 })],
    });
    const html = await renderPage();
    // No queue rows for the hidden loops...
    expect(html).not.toContain("Open snags on live jobs");
    expect(html).not.toContain("ITPs waiting on sign-off");
    expect(html).not.toContain("open snag");
    // ...and the queue is honestly calm — the hidden work is absent, not "0".
    expect(html).toContain("All clear");
  });

  it("surfaces the snag/ITP queues again when their flags are on (same job stats drive the rows)", async () => {
    h.flagsOn = new Set(["snags", "itp"]);
    stubFetch({
      submittedEntries: [],
      pulse: pulseBody(),
      jobs: [jobWithStats("j1", { statsSnagsV2Active: 3, statsItpsNeedsReview: 2 })],
    });
    const html = await renderPage();
    expect(html).toContain('aria-label="Open snags on live jobs: 3"');
    expect(html).toContain('aria-label="ITPs waiting on sign-off: 2"');
  });

  // ── RFIs overdue (#276 chase, flagged rfi_register) ─────────────────────
  function overdueRfi(id: string, daysAgo: number): Record<string, unknown> {
    const due = new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    return {
      id,
      jobId: "j1",
      jobName: "Marriott St",
      ref: "RFI-004",
      subject: "Panel location",
      question: "Where does the DB go?",
      askedOf: "builder@example.com",
      status: "sent",
      responseDue: due,
      sentAt: null,
      answer: "",
      answeredAt: null,
      answeredBy: null,
      closedReason: "",
      observationId: null,
      convertedFromObservationId: null,
      areaId: null,
      planId: null,
      raisedById: "u1",
      raisedByName: "Oskar",
      createdAt: "2026-06-15T00:00:00.000Z",
      updatedAt: "2026-06-15T00:00:00.000Z",
      auditLogIds: [],
    };
  }

  it("does NOT run the RFI scan and renders no RFI tile when rfi_register is off (zero extra reads)", async () => {
    stubFetch({ submittedEntries: [], pulse: pulseBody() });
    const html = await renderPage();
    expect(h.rfiScanCalls).toBe(0);
    expect(html).not.toContain("RFIs overdue");
  });

  it("surfaces an overdue RFI when the flag is on — a queue row with the real count, routed to jobs", async () => {
    h.rfiFlagOn = true;
    h.rfiResult = { rfis: [overdueRfi("rfi_1", 10)], scannedJobs: 1, failedJobs: [] };
    stubFetch({ submittedEntries: [], pulse: pulseBody() });
    const html = await renderPage();
    expect(h.rfiScanCalls).toBe(1);
    // Queue row (singular) with the real count; no cross-job RFI surface
    // exists, so the row routes to the jobs list.
    expect(html).toContain('aria-label="RFI overdue for an answer: 1"');
    expect(html).toContain('href="/v2/jobs"');
  });

  it("stays calm with the flag on and nothing overdue — no tile (buildBoard drops zero loops), All clear intact", async () => {
    h.rfiFlagOn = true;
    h.rfiResult = { rfis: [], scannedJobs: 3, failedJobs: [] };
    stubFetch({ submittedEntries: [], pulse: pulseBody() });
    const html = await renderPage();
    expect(html).not.toContain("RFIs overdue");
    expect(html).toContain("All clear");
  });

  it("discloses a partial RFI scan (failedJobs) via the 'couldn't load every signal' card — no silent undercount", async () => {
    h.rfiFlagOn = true;
    h.rfiResult = { rfis: [], scannedJobs: 3, failedJobs: ["j2", "j3"] };
    stubFetch({ submittedEntries: [], pulse: pulseBody() });
    const html = await renderPage();
    expect(html).toContain("Couldn’t load every signal");
    expect(html).toContain("RFIs couldn’t be read");
  });
});
