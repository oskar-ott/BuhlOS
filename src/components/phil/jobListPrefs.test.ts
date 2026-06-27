import { describe, expect, it } from "vitest";

import {
  RECENTS_CAP,
  purgeJobListPrefs,
  readJobListPrefs,
  recordView,
  togglePin,
} from "./jobListPrefs";

/** Minimal in-memory storage so these run in the node test env (no window). */
function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    _map: map,
  };
}

describe("jobListPrefs", () => {
  it("returns empty prefs when nothing is stored", () => {
    expect(readJobListPrefs("user-1", fakeStorage())).toEqual({
      recents: [],
      pinned: [],
    });
  });

  it("records a view, most-recent-first", () => {
    const store = fakeStorage();
    recordView("user-1", "job-a", store);
    recordView("user-1", "job-b", store);
    recordView("user-1", "job-c", store);
    expect(readJobListPrefs("user-1", store).recents).toEqual([
      "job-c",
      "job-b",
      "job-a",
    ]);
  });

  it("de-duplicates a re-opened job to the front", () => {
    const store = fakeStorage();
    recordView("user-1", "job-a", store);
    recordView("user-1", "job-b", store);
    recordView("user-1", "job-a", store);
    expect(readJobListPrefs("user-1", store).recents).toEqual(["job-a", "job-b"]);
  });

  it("caps recents at RECENTS_CAP, dropping the oldest", () => {
    const store = fakeStorage();
    for (let i = 0; i < RECENTS_CAP + 3; i += 1) {
      recordView("user-1", `job-${i}`, store);
    }
    const { recents } = readJobListPrefs("user-1", store);
    expect(recents).toHaveLength(RECENTS_CAP);
    // Most-recent-first: the last recorded is first, the oldest fell off.
    expect(recents[0]).toBe(`job-${RECENTS_CAP + 2}`);
    expect(recents).not.toContain("job-0");
  });

  it("toggles a pin on and off", () => {
    const store = fakeStorage();
    expect(togglePin("user-1", "job-a", store).pinned).toEqual(["job-a"]);
    expect(readJobListPrefs("user-1", store).pinned).toEqual(["job-a"]);
    expect(togglePin("user-1", "job-a", store).pinned).toEqual([]);
    expect(readJobListPrefs("user-1", store).pinned).toEqual([]);
  });

  it("keeps pins in insertion order", () => {
    const store = fakeStorage();
    togglePin("user-1", "job-a", store);
    togglePin("user-1", "job-b", store);
    expect(readJobListPrefs("user-1", store).pinned).toEqual(["job-a", "job-b"]);
  });

  it("keeps recents and pins independent", () => {
    const store = fakeStorage();
    recordView("user-1", "job-a", store);
    togglePin("user-1", "job-b", store);
    expect(readJobListPrefs("user-1", store)).toEqual({
      recents: ["job-a"],
      pinned: ["job-b"],
    });
  });

  it("scopes prefs per user (shared-device isolation)", () => {
    const store = fakeStorage();
    recordView("user-1", "job-a", store);
    togglePin("user-2", "job-z", store);
    expect(readJobListPrefs("user-1", store)).toEqual({
      recents: ["job-a"],
      pinned: [],
    });
    expect(readJobListPrefs("user-2", store)).toEqual({
      recents: [],
      pinned: ["job-z"],
    });
  });

  it("purges a user's prefs (sign-out, shared-device safety)", () => {
    const store = fakeStorage();
    recordView("user-1", "job-a", store);
    togglePin("user-1", "job-b", store);
    purgeJobListPrefs("user-1", store);
    expect(readJobListPrefs("user-1", store)).toEqual({ recents: [], pinned: [] });
    expect(store._map.size).toBe(0);
  });

  it("purge only touches the named user", () => {
    const store = fakeStorage();
    recordView("user-1", "job-a", store);
    recordView("user-2", "job-b", store);
    purgeJobListPrefs("user-1", store);
    expect(readJobListPrefs("user-2", store).recents).toEqual(["job-b"]);
  });

  it("survives malformed / partial / wrong-typed stored JSON", () => {
    expect(
      readJobListPrefs("user-1", fakeStorage({ "phil-job-list-prefs:user-1": "{not json" })),
    ).toEqual({ recents: [], pinned: [] });
    // partial shape — missing pinned
    expect(
      readJobListPrefs(
        "user-1",
        fakeStorage({ "phil-job-list-prefs:user-1": JSON.stringify({ recents: ["a"] }) }),
      ),
    ).toEqual({ recents: ["a"], pinned: [] });
    // wrong-typed members are dropped, blanks too
    expect(
      readJobListPrefs(
        "user-1",
        fakeStorage({
          "phil-job-list-prefs:user-1": JSON.stringify({
            recents: ["a", 7, "", "a", null],
            pinned: "nope",
          }),
        }),
      ),
    ).toEqual({ recents: ["a"], pinned: [] });
  });

  it("is a no-op without storage (SSR / no window)", () => {
    expect(readJobListPrefs("user-1", null)).toEqual({ recents: [], pinned: [] });
    expect(recordView("user-1", "job-a", null)).toEqual({ recents: [], pinned: [] });
    expect(togglePin("user-1", "job-a", null)).toEqual({ recents: [], pinned: [] });
    expect(() => purgeJobListPrefs("user-1", null)).not.toThrow();
  });

  it("ignores a blank userId or jobId", () => {
    const store = fakeStorage();
    recordView("", "job-a", store);
    recordView("user-1", "", store);
    togglePin("", "job-a", store);
    expect(store._map.size).toBe(0);
  });
});
