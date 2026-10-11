import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * The ONE freshness rule (api/_lib/source-freshness.js): is the content we
 * fetched through Vercel Blob's CDN the version the store's own metadata
 * (list()/head(): byte `size` + last-PUT `uploadedAt`) says is current?
 *
 * Every payroll sheet and every hours write leans on this verdict, so each
 * branch is pinned here with the incident it answers.
 */

const requireFromHere = createRequire(import.meta.url);
const sf = requireFromHere("../../../api/_lib/source-freshness.js") as {
  contentVerdict: (
    meta: { uploadedAt?: string | Date | number; size?: number },
    content: { doc: Record<string, unknown>; bytes?: number },
    nowMs?: number,
  ) => {
    current: boolean;
    reason?: "size" | "stamp";
    gapMs?: number | null;
    settled?: boolean;
    sizeMismatch?: boolean;
  };
  sourceContentIsCurrent: (doc: Record<string, unknown>, uploadedAt: string, nowMs?: number) => boolean;
  PUT_SKEW_MS: number;
  FRESHNESS_SKEW_MS: number;
  CDN_SETTLE_MS: number;
  STALE_SUSPECT_WINDOW_MS: number;
};

const NOW = Date.parse("2026-10-05T07:35:00.000Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const doc = (stampMsAgo: number, extra: Record<string, unknown> = {}) => ({
  status: "approved",
  __updatedAt: at(stampMsAgo),
  __rev: 2,
  ...extra,
});

describe("contentVerdict — byte size", () => {
  it("a different byte count inside the CDN window is a different version — refused", () => {
    // The 5 Oct shape: written 30s ago, the CDN still serves the
    // pre-approval copy. Stamp close enough to fool a time-only check.
    const v = sf.contentVerdict(
      { uploadedAt: at(30_000), size: 812 },
      { doc: doc(31_000), bytes: 760 },
      NOW,
    );
    expect(v).toMatchObject({ current: false, reason: "size" });
  });

  it("still decisive past the CDN window but inside the suspect window", () => {
    const v = sf.contentVerdict(
      { uploadedAt: at(2 * 60_000), size: 812 },
      { doc: doc(2 * 60_000 + 1_000), bytes: 760 },
      NOW,
    );
    expect(v).toMatchObject({ current: false, reason: "size" });
  });

  it("past the suspect window it can't be a stale CDN read — accepted and FLAGGED, never a permanent block (2026-09-21 lesson)", () => {
    const v = sf.contentVerdict(
      { uploadedAt: at(10 * 60_000), size: 812 },
      { doc: doc(10 * 60_000 + 1_000), bytes: 760 },
      NOW,
    );
    expect(v).toMatchObject({ current: true, settled: true, sizeMismatch: true });
  });

  it("an equal byte count passes on to the stamp check", () => {
    const v = sf.contentVerdict(
      { uploadedAt: at(30_000), size: 812 },
      { doc: doc(31_000), bytes: 812 },
      NOW,
    );
    expect(v.current).toBe(true);
  });

  it("unknown size or unknown bytes skips the size check (older listings, test doubles)", () => {
    expect(sf.contentVerdict({ uploadedAt: at(30_000) }, { doc: doc(31_000), bytes: 760 }, NOW).current).toBe(true);
    expect(sf.contentVerdict({ uploadedAt: at(30_000), size: 812 }, { doc: doc(31_000) }, NOW).current).toBe(true);
  });
});

describe("contentVerdict — storage stamp", () => {
  it("inside the CDN window the bar is tight: ≤ PUT_SKEW_MS clears, more is a stale read", () => {
    expect(sf.PUT_SKEW_MS).toBeLessThan(sf.FRESHNESS_SKEW_MS);
    const putAgo = 20_000;
    expect(sf.contentVerdict({ uploadedAt: at(putAgo) }, { doc: doc(putAgo + 3_000) }, NOW).current).toBe(true);
    expect(sf.contentVerdict({ uploadedAt: at(putAgo) }, { doc: doc(putAgo + 9_000) }, NOW)).toMatchObject({
      current: false,
      reason: "stamp",
    });
  });

  it("past the CDN window the historic 15s skew applies (a slow put is never refused for long)", () => {
    const putAgo = 2 * 60_000;
    expect(sf.contentVerdict({ uploadedAt: at(putAgo) }, { doc: doc(putAgo + 9_000) }, NOW).current).toBe(true);
    expect(sf.contentVerdict({ uploadedAt: at(putAgo) }, { doc: doc(putAgo + 40_000) }, NOW)).toMatchObject({
      current: false,
      reason: "stamp",
    });
  });

  it("past the suspect window a trailing stamp is a fact about the WRITE — accepted (2026-09-21)", () => {
    const putAgo = 3 * 60 * 60_000;
    expect(sf.contentVerdict({ uploadedAt: at(putAgo) }, { doc: doc(putAgo + 40_000) }, NOW)).toMatchObject({
      current: true,
      settled: true,
    });
  });

  it("a legacy document (handler stamps only) inside the window gets the historic bar, not the tight one", () => {
    const legacy = { status: "approved", updatedAt: at(28_000) };
    expect(sf.contentVerdict({ uploadedAt: at(20_000) }, { doc: legacy }, NOW).current).toBe(true);
    const older = { status: "submitted", updatedAt: at(60_000) };
    expect(sf.contentVerdict({ uploadedAt: at(20_000) }, { doc: older }, NOW).current).toBe(false);
  });

  it("missing metadata or a stamp-less document can't be judged on time — never invent staleness (P7)", () => {
    expect(sf.contentVerdict({}, { doc: doc(1_000) }, NOW).current).toBe(true);
    expect(sf.contentVerdict({ uploadedAt: at(5_000) }, { doc: { status: "approved" } }, NOW).current).toBe(true);
  });

  it("accepts a Date uploadedAt (the SDK's list() shape) as well as a string", () => {
    expect(sf.contentVerdict({ uploadedAt: new Date(NOW - 20_000) }, { doc: doc(23_000) }, NOW).current).toBe(true);
    expect(sf.contentVerdict({ uploadedAt: new Date(NOW - 20_000) }, { doc: doc(40_000) }, NOW).current).toBe(false);
  });
});

describe("sourceContentIsCurrent — the jobs.json derived-cache check (#1085) is unchanged", () => {
  it("keeps the 15s bar even inside the CDN window (it refuses-to-stamp, it doesn't refuse reads)", () => {
    expect(sf.sourceContentIsCurrent(doc(29_000), at(20_000), NOW)).toBe(true); // 9s gap
    expect(sf.sourceContentIsCurrent(doc(50_000), at(20_000), NOW)).toBe(false); // 30s gap, fresh PUT
    expect(sf.sourceContentIsCurrent(doc(10 * 60_000), at(9 * 60_000), NOW)).toBe(true); // settled
    expect(sf.sourceContentIsCurrent({ jobs: [] }, at(20_000), NOW)).toBe(true); // no stamp
  });
});
