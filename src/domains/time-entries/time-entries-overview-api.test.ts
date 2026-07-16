import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * API contract: missing-hours crew coverage on GET /api/time-entries-overview
 * (#114).
 *
 * The missing[] detection feeds /hours, /hours/weekly readiness and the
 * command-centre card. Pre-#114 its crew filter literal-matched
 * 'tradie'/'leadingHand', so onboarded electricians / apprentices / labourers
 * and lowercase-'leadinghand' accounts were INVISIBLE to missing-hours —
 * weeks could read payroll-ready while untracked field workers had logged
 * nothing. These tests pin the corrected rule (isHoursTrackedWorker): the
 * whole field tier + every LH spelling, live accounts only, and the
 * unchanged honesty rules (weekdays only, never future, viewer scoping).
 *
 * Harness mirrors time-entry-actions-api.test.ts: real auth + handler via
 * require-cache injection, in-memory blob Map, @vercel/blob list mock.
 */

const requireFromHere = createRequire(import.meta.url);
const blobSdkPath = requireFromHere.resolve("@vercel/blob");
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const handlerPath = requireFromHere.resolve("../../../api/time-entries-overview.js");

// #137: the REAL static holiday table (pure, no blob deps) — derive a genuine
// past weekday public holiday so the test follows the gazetted table instead of
// pinning a date that yearly maintenance could drop.
const publicHolidays = requireFromHere("../../../api/_lib/public-holidays.js") as {
  publicHolidaysInRange: (from: string, to: string) => Array<{ date: string; name: string }>;
};

type Handler = (
  req: Record<string, unknown>,
  res: ReturnType<typeof createRes>
) => Promise<unknown>;

let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: Handler;

// ── Dates anchored to the handler's own "today" (UTC date string, parsed at
// local midnight — matching its cursor arithmetic exactly).
const TODAY = new Date().toISOString().slice(0, 10);
function isoLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function todayLocal(): Date {
  return new Date(TODAY + "T00:00:00");
}
/** Most recent weekday (Mon–Fri) ≤ today. */
const PAST_WEEKDAY = (() => {
  const d = todayLocal();
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return isoLocal(d);
})();
/** Most recent Saturday ≤ today. */
const PAST_SATURDAY = (() => {
  const d = todayLocal();
  do d.setDate(d.getDate() - 1);
  while (d.getDay() !== 6);
  return isoLocal(d);
})();
const TOMORROW = (() => {
  const d = todayLocal();
  d.setDate(d.getDate() + 1);
  return isoLocal(d);
})();
/** A real NSW public holiday that is a past weekday (Mon–Fri ≤ today) — so
 *  without the #137 exclusion the crew WOULD be flagged missing on it. */
const PAST_WEEKDAY_HOLIDAY = (() => {
  const past = publicHolidays.publicHolidaysInRange("2025-01-01", TODAY);
  for (let i = past.length - 1; i >= 0; i--) {
    const wd = new Date(past[i]!.date + "T00:00:00").getDay();
    if (wd >= 1 && wd <= 5) return past[i]!;
  }
  return null;
})();

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function user(id: string, role: string, assignedJobIds: string[] = [], extra = {}) {
  return { id, username: id, role, assignedJobIds, ...extra };
}

function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  };
}

function cookieFor(userId: string, role: string): string {
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
}

async function overview(
  viewerId: string,
  viewerRole: string,
  query: Record<string, string>
) {
  const res = createRes();
  await handler(
    { method: "GET", query, headers: { cookie: cookieFor(viewerId, viewerRole) } },
    res
  );
  return res;
}

function missingIds(res: ReturnType<typeof createRes>): string[] {
  return ((res.body as { missing: Array<{ userId: string }> }).missing ?? [])
    .map((m) => m.userId)
    .sort();
}

function seedEntry(userId: string, date: string) {
  blob.set(`users/${userId}/time-entries/${date}.json`, {
    id: `te_${userId}_${date}`,
    userId,
    userName: userId,
    userRole: "electrician",
    date,
    totalHours: 7.6,
    ordinaryHours: 7.6,
    overtimeHours: 0,
    status: "submitted",
    submittedAt: `${date}T08:00:00.000Z`,
    allocations: [{ jobId: "job-x", hours: 7.6, notes: null, sortOrder: 0 }],
    createdAt: `${date}T07:00:00.000Z`,
    updatedAt: `${date}T08:00:00.000Z`,
  });
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          // viewers
          user("u_admin", "admin"),
          user("u_lh_viewer", "leadingHand", ["job-x"]),
          // hours-tracked crew across the WHOLE field tier + both LH spellings
          user("u_tradie", "tradie", ["job-x"]),
          user("u_elec", "electrician", ["job-x"]),
          user("u_appr", "apprentice", ["job-y"]),
          user("u_lab", "labourer", ["job-y"]),
          user("u_lhand", "leadinghand", ["job-x"]), // onboarding spelling
          // never tracked
          user("u_office", "office"),
          user("u_client", "client", ["job-x"]),
          user("u_archived", "tradie", ["job-x"], { archived: true }),
          user("u_disabled", "electrician", ["job-x"], { disabled: true }),
        ],
      },
    ],
    [
      "jobs.json",
      {
        jobs: [
          { id: "job-x", name: "Job X", status: "active" },
          { id: "job-y", name: "Job Y", status: "active" },
        ],
      },
    ],
  ]);

  for (const modulePath of [
    blobSdkPath,
    blobPath,
    authPath,
    requireFromHere.resolve("../../../api/_lib/leave.js"),
    handlerPath,
  ]) {
    delete requireFromHere.cache[modulePath];
  }

  requireFromHere.cache[blobSdkPath] = {
    id: blobSdkPath,
    filename: blobSdkPath,
    loaded: true,
    exports: {
      list: vi.fn(async () => ({
        blobs: [...blob.keys()]
          .filter((key) => key.includes("/time-entries/"))
          .map((pathname) => ({
            pathname,
            url: `https://blob.test/${encodeURIComponent(pathname)}`,
          })),
      })),
      put: vi.fn(),
      del: vi.fn(),
    },
  } as NodeJS.Module;
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        blob.set(key, clone(data));
      }),
      deleteBlob: vi.fn(async (key: string) => {
        blob.delete(key);
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const pathname = decodeURIComponent(new URL(url).pathname.slice(1));
      const value = blob.get(pathname);
      return { ok: value !== undefined, json: async () => clone(value) };
    })
  );

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("missing-hours crew coverage (#114)", () => {
  it("tracks the WHOLE field tier + both leading-hand spellings, never office/client/disabled", async () => {
    const res = await overview("u_admin", "admin", {
      fromDate: PAST_WEEKDAY,
      toDate: PAST_WEEKDAY,
    });
    expect(res.statusCode).toBe(200);
    expect(missingIds(res)).toEqual(
      ["u_appr", "u_elec", "u_lab", "u_lh_viewer", "u_lhand", "u_tradie"].sort()
    );
    // The regression this PR fixes: these were invisible pre-#114.
    expect(missingIds(res)).toContain("u_elec");
    expect(missingIds(res)).toContain("u_appr");
    expect(missingIds(res)).toContain("u_lab");
    expect(missingIds(res)).toContain("u_lhand");
    // Never tracked: office/admin tier, clients, archived/disabled accounts.
    for (const never of ["u_admin", "u_office", "u_client", "u_archived", "u_disabled"]) {
      expect(missingIds(res)).not.toContain(never);
    }
  });

  it("a real entry suppresses the missing row (any tracked role)", async () => {
    seedEntry("u_elec", PAST_WEEKDAY);
    const res = await overview("u_admin", "admin", {
      fromDate: PAST_WEEKDAY,
      toDate: PAST_WEEKDAY,
    });
    expect(missingIds(res)).not.toContain("u_elec");
    expect(missingIds(res)).toContain("u_appr"); // still no entry → still missing
    const entries = (res.body as { entries: Array<{ userId: string }> }).entries;
    expect(entries.map((e) => e.userId)).toContain("u_elec");
  });

  it("weekends are never missing", async () => {
    const res = await overview("u_admin", "admin", {
      fromDate: PAST_SATURDAY,
      toDate: PAST_SATURDAY,
    });
    expect(missingIds(res)).toEqual([]);
  });

  it("a public holiday weekday is exempt from missing AND named in holidays[] (#137)", async () => {
    // The static AU/NSW table must carry a past weekday holiday to exercise this.
    expect(PAST_WEEKDAY_HOLIDAY).not.toBeNull();
    const hol = PAST_WEEKDAY_HOLIDAY!;
    const res = await overview("u_admin", "admin", {
      fromDate: hol.date,
      toDate: hol.date,
    });
    // Without #137 the whole job-x crew (no entries) would be flagged missing on
    // this weekday; the holiday exempts them exactly like a weekend.
    expect(missingIds(res)).toEqual([]);
    // …and the server NAMES the holiday so the weekly board can render its cell
    // (the half that was dead until the page glue was wired).
    const holidays =
      (res.body as { holidays?: Array<{ date: string; name: string }> }).holidays ?? [];
    expect(holidays.map((h) => h.date)).toContain(hol.date);
    expect(holidays.find((h) => h.date === hol.date)?.name).toBeTruthy();
  });

  it("future days are never missing", async () => {
    const res = await overview("u_admin", "admin", {
      fromDate: TOMORROW,
      toDate: TOMORROW,
    });
    expect(missingIds(res)).toEqual([]);
  });

  it("LH viewer scoping is unchanged: crew restricted to workers on shared jobs", async () => {
    const res = await overview("u_lh_viewer", "leadingHand", {
      fromDate: PAST_WEEKDAY,
      toDate: PAST_WEEKDAY,
    });
    expect(res.statusCode).toBe(200);
    // job-x workers only — the expanded tier still respects visibility.
    expect(missingIds(res)).toEqual(
      ["u_elec", "u_lh_viewer", "u_lhand", "u_tradie"].sort()
    );
    expect(missingIds(res)).not.toContain("u_appr"); // job-y — not the LH's crew
  });

  it("the users[] directory mirrors the tracked crew (live field tier + LHs)", async () => {
    const res = await overview("u_admin", "admin", {
      fromDate: PAST_WEEKDAY,
      toDate: PAST_WEEKDAY,
    });
    const ids = (res.body as { users: Array<{ id: string }> }).users
      .map((u) => u.id)
      .sort();
    expect(ids).toEqual(
      ["u_appr", "u_elec", "u_lab", "u_lh_viewer", "u_lhand", "u_tradie"].sort()
    );
  });

  it("still 403s non-staff callers", async () => {
    const res = await overview("u_tradie", "tradie", {
      fromDate: PAST_WEEKDAY,
      toDate: PAST_WEEKDAY,
    });
    expect(res.statusCode).toBe(403);
  });
});

/**
 * #333 — approved leave exempts a day from missing-hours and surfaces in the
 * response's leave[] so the boards can show "On leave (sick)" instead of a
 * false "missing" chase.
 */
describe("approved leave exemption (#333)", () => {
  function seedLeave(status: string, userId = "u_elec") {
    blob.set("leave-requests.json", {
      requests: [
        {
          id: "lv_1",
          userId,
          userName: userId,
          type: "sick",
          fromDate: PAST_WEEKDAY,
          toDate: PAST_WEEKDAY,
          status,
        },
      ],
    });
  }

  it("an approved leave day is leave[], not missing[]", async () => {
    seedLeave("approved");
    const res = await overview("u_admin", "admin", {
      fromDate: PAST_WEEKDAY,
      toDate: PAST_WEEKDAY,
    });
    expect(res.statusCode).toBe(200);
    expect(missingIds(res)).not.toContain("u_elec");
    expect(missingIds(res)).toContain("u_appr"); // others still chased
    const leave = (res.body as {
      leave: Array<{ date: string; userId: string; type: string }>;
    }).leave;
    expect(leave).toEqual([
      { date: PAST_WEEKDAY, userId: "u_elec", userName: "u_elec", type: "sick" },
    ]);
  });

  it("pending leave does NOT exempt — only an approval stops the chase", async () => {
    seedLeave("pending");
    const res = await overview("u_admin", "admin", {
      fromDate: PAST_WEEKDAY,
      toDate: PAST_WEEKDAY,
    });
    expect(missingIds(res)).toContain("u_elec");
    expect((res.body as { leave: unknown[] }).leave).toEqual([]);
  });
});

/**
 * #123 — tier-aware viewer scoping. Pre-fix both endpoints literal-matched
 * `role === 'admin'`, so office/boss/PM viewers fell into the leading-hand
 * path with no assignedJobIds → empty visible set → blank /hours, /hours/weekly
 * and today-pulse for exactly the people who run payroll. The fix routes the
 * whole admin TIER through the full-company path; LH scoping is unchanged.
 */
describe("office-tier viewer scoping (#123)", () => {
  const pulsePath = requireFromHere.resolve("../../../api/today-pulse.js");

  async function pulse(viewerId: string, viewerRole: string, date: string) {
    // Fresh require AFTER the shared beforeEach injected the blob/auth mocks,
    // so the pulse handler binds to the same in-memory store.
    delete requireFromHere.cache[pulsePath];
    const pulseHandler = requireFromHere(pulsePath) as Handler;
    const res = createRes();
    await pulseHandler(
      {
        method: "GET",
        query: { date },
        headers: { cookie: cookieFor(viewerId, viewerRole) },
      },
      res
    );
    return res;
  }

  it("overview: an office viewer sees the same full-company missing crew as an admin", async () => {
    const admin = await overview("u_admin", "admin", {
      fromDate: PAST_WEEKDAY,
      toDate: PAST_WEEKDAY,
    });
    const office = await overview("u_office", "office", {
      fromDate: PAST_WEEKDAY,
      toDate: PAST_WEEKDAY,
    });
    expect(office.statusCode).toBe(200);
    expect(missingIds(office)).toEqual(missingIds(admin));
    expect(missingIds(office).length).toBeGreaterThan(0); // not the empty LH path
  });

  it("overview: a boss viewer with no assigned jobs is admin-tier, not job-scoped", async () => {
    (blob.get("users.json") as { users: unknown[] }).users.push(user("u_boss_v", "boss"));
    const boss = await overview("u_boss_v", "boss", {
      fromDate: PAST_WEEKDAY,
      toDate: PAST_WEEKDAY,
    });
    expect(boss.statusCode).toBe(200);
    expect(missingIds(boss).length).toBeGreaterThan(0);
  });

  it("overview: leading-hand scoping is unchanged by the tier fix", async () => {
    const lh = await overview("u_lh_viewer", "leadingHand", {
      fromDate: PAST_WEEKDAY,
      toDate: PAST_WEEKDAY,
    });
    // job-x crew only (incl. the LH themself — leading hands are
    // hours-tracked) — never the job-y workers an admin/office viewer sees.
    expect(missingIds(lh)).toEqual(["u_elec", "u_lh_viewer", "u_lhand", "u_tradie"]);
  });

  it("today-pulse: an office viewer sees company-wide hours, not a blank pulse", async () => {
    seedEntry("u_elec", PAST_WEEKDAY);
    const office = await pulse("u_office", "office", PAST_WEEKDAY);
    expect(office.statusCode).toBe(200);
    const body = office.body as { hours: { submittedCount: number }; jobs: { activeJobs: number } };
    expect(body.hours.submittedCount).toBe(1);
    expect(body.jobs.activeJobs).toBe(2); // all active jobs, not zero
  });

  it("today-pulse: all-jobs access — a leading hand now sees EVERY active job", async () => {
    seedEntry("u_elec", PAST_WEEKDAY); // allocation on job-x
    blob.set(`users/u_appr/time-entries/${PAST_WEEKDAY}.json`, {
      id: `te_u_appr_${PAST_WEEKDAY}`,
      userId: "u_appr",
      userName: "u_appr",
      userRole: "apprentice",
      date: PAST_WEEKDAY,
      totalHours: 7.6,
      ordinaryHours: 7.6,
      overtimeHours: 0,
      status: "submitted",
      submittedAt: `${PAST_WEEKDAY}T08:00:00.000Z`,
      allocations: [{ jobId: "job-y", hours: 7.6, notes: null, sortOrder: 0 }],
      createdAt: `${PAST_WEEKDAY}T07:00:00.000Z`,
      updatedAt: `${PAST_WEEKDAY}T08:00:00.000Z`,
    });
    const lh = await pulse("u_lh_viewer", "leadingHand", PAST_WEEKDAY);
    expect(lh.statusCode).toBe(200);
    const body = lh.body as { hours: { submittedCount: number }; jobs: { activeJobs: number } };
    // Assignment no longer scopes: the LH sees BOTH entries (job-x and job-y)
    // and every active job — the same pulse an office viewer gets.
    expect(body.hours.submittedCount).toBe(2);
    expect(body.jobs.activeJobs).toBe(2);
  });
});
