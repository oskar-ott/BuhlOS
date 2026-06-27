import { describe, expect, it } from "vitest";

import {
  RECENT_GROUP_MIN_JOBS,
  orderJobList,
  type OrderableJob,
} from "./jobListOrder";
import type { JobListPrefs } from "./jobListPrefs";

const j = (id: string, name: string): OrderableJob => ({ id, name });

const prefs = (p: Partial<JobListPrefs> = {}): JobListPrefs => ({
  recents: p.recents ?? [],
  pinned: p.pinned ?? [],
});

const ids = (jobs: OrderableJob[]) => jobs.map((x) => x.id);

describe("orderJobList", () => {
  it("sorts the rest name-first when there are no prefs", () => {
    const jobs = [j("a", "Zebra"), j("b", "Apple"), j("c", "Mango")];
    const { fullList, recentGroup, showRecentGroup } = orderJobList(jobs, prefs());
    expect(ids(fullList)).toEqual(["b", "c", "a"]); // Apple, Mango, Zebra
    // 3 jobs is NOT more than the gate (>3), so no Recent group.
    expect(showRecentGroup).toBe(false);
    expect(recentGroup).toEqual([]);
  });

  it("orders pinned first, recents next, rest name-first", () => {
    const jobs = [
      j("a", "Zebra"),
      j("b", "Apple"),
      j("c", "Mango"),
      j("d", "Banana"),
      j("e", "Cherry"),
    ];
    const { fullList } = orderJobList(
      jobs,
      prefs({ pinned: ["c"], recents: ["e", "a"] }),
    );
    // pinned: Mango; recents (most-recent-first): Cherry, Zebra; rest name-first: Apple, Banana
    expect(ids(fullList)).toEqual(["c", "e", "a", "b", "d"]);
  });

  it("a pinned job never also appears in the recents slot", () => {
    const jobs = [j("a", "A"), j("b", "B"), j("c", "C"), j("d", "D")];
    const { fullList, recentGroup } = orderJobList(
      jobs,
      prefs({ pinned: ["a"], recents: ["a", "b"] }),
    );
    // a counted once (as pinned), then b as recent, then rest
    expect(ids(fullList)).toEqual(["a", "b", "c", "d"]);
    // pinned excluded from the Recent group too
    expect(ids(recentGroup)).toEqual(["b"]);
  });

  it("hides the Recent group at or below the gate (P10 — single/few-job worker)", () => {
    const jobs = [j("a", "A"), j("b", "B"), j("c", "C")];
    expect(jobs.length).toBe(RECENT_GROUP_MIN_JOBS);
    const { showRecentGroup, recentGroup } = orderJobList(
      jobs,
      prefs({ recents: ["c", "b"] }),
    );
    expect(showRecentGroup).toBe(false);
    expect(recentGroup).toEqual([]);
  });

  it("single-job worker: no Recent group, list unchanged", () => {
    const jobs = [j("a", "Only job")];
    const { fullList, showRecentGroup } = orderJobList(
      jobs,
      prefs({ recents: ["a"], pinned: ["a"] }),
    );
    expect(ids(fullList)).toEqual(["a"]);
    expect(showRecentGroup).toBe(false);
  });

  it("shows the Recent group above the gate, capped to the shortlist", () => {
    const jobs = [
      j("a", "A"),
      j("b", "B"),
      j("c", "C"),
      j("d", "D"),
      j("e", "E"),
    ];
    const { recentGroup, showRecentGroup } = orderJobList(
      jobs,
      prefs({ recents: ["e", "d", "c", "b"] }),
    );
    expect(showRecentGroup).toBe(true);
    // shortlist is the top 3 recents, most-recent-first
    expect(ids(recentGroup)).toEqual(["e", "d", "c"]);
  });

  it("gate met but no recents → no Recent group (honest, P7)", () => {
    const jobs = [j("a", "A"), j("b", "B"), j("c", "C"), j("d", "D")];
    const { showRecentGroup, recentGroup, fullList } = orderJobList(jobs, prefs());
    expect(showRecentGroup).toBe(false);
    expect(recentGroup).toEqual([]);
    // and the list is just name-first as today
    expect(ids(fullList)).toEqual(["a", "b", "c", "d"]);
  });

  it("ignores stale pin/recent ids that no longer match an assigned job", () => {
    const jobs = [j("a", "A"), j("b", "B"), j("c", "C"), j("d", "D")];
    const { fullList, recentGroup } = orderJobList(
      jobs,
      prefs({ pinned: ["gone"], recents: ["also-gone", "c"] }),
    );
    // 'gone'/'also-gone' dropped; c is the only live recent
    expect(ids(fullList)).toEqual(["c", "a", "b", "d"]);
    expect(ids(recentGroup)).toEqual(["c"]);
  });
});
