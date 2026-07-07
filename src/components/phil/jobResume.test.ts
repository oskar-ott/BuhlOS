import { describe, expect, it } from "vitest";

import { readJobResume, writeJobResume, type JobResume } from "./jobResume";

/** Minimal in-memory storage so these run in the node test env (no window). */
function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    _map: map,
  };
}

describe("jobResume", () => {
  it("round-trips an area + stage for a job", () => {
    const store = fakeStorage();
    writeJobResume("job-1", { areaId: "area-7", stage: "fitOff" }, store);
    expect(readJobResume("job-1", store)).toEqual<JobResume>({
      areaId: "area-7",
      stage: "fitOff",
    });
  });

  it("scopes memory per job", () => {
    const store = fakeStorage();
    writeJobResume("job-1", { areaId: "a1", stage: "roughIn" }, store);
    writeJobResume("job-2", { areaId: "a2", stage: "fitOff" }, store);
    expect(readJobResume("job-1", store)?.areaId).toBe("a1");
    expect(readJobResume("job-2", store)?.areaId).toBe("a2");
  });

  it("returns null when nothing is stored", () => {
    expect(readJobResume("job-x", fakeStorage())).toBeNull();
  });

  it("rejects an unknown stage (forward-compat / tampering)", () => {
    const store = fakeStorage({
      "phil-job-resume:job-1": JSON.stringify({ areaId: "a1", stage: "demolition" }),
    });
    expect(readJobResume("job-1", store)).toBeNull();
  });

  it("rejects a missing areaId and malformed JSON", () => {
    expect(
      readJobResume(
        "job-1",
        fakeStorage({ "phil-job-resume:job-1": JSON.stringify({ stage: "roughIn" }) }),
      ),
    ).toBeNull();
    expect(
      readJobResume("job-1", fakeStorage({ "phil-job-resume:job-1": "{not json" })),
    ).toBeNull();
  });

  it("is a no-op without storage (SSR / no window)", () => {
    expect(readJobResume("job-1", null)).toBeNull();
    // must not throw
    expect(() => writeJobResume("job-1", { areaId: "a1", stage: "roughIn" }, null)).not.toThrow();
  });

  it("ignores a blank jobId or areaId", () => {
    const store = fakeStorage();
    writeJobResume("", { areaId: "a1", stage: "roughIn" }, store);
    writeJobResume("job-1", { areaId: "", stage: "roughIn" }, store);
    expect(store._map.size).toBe(0);
  });

  // ── Rooms extension (phil_job_rooms — #133 ≤1-gesture recovery) ──────────
  it("round-trips the room + open drill-in (rooms mode)", () => {
    const store = fakeStorage();
    writeJobResume(
      "job-1",
      { areaId: "a1", stage: "roughIn", room: "work", areaOpen: true },
      store,
    );
    expect(readJobResume("job-1", store)).toEqual<JobResume>({
      areaId: "a1",
      stage: "roughIn",
      room: "work",
      areaOpen: true,
    });
  });

  it("a flag-off write stays byte-identical — no rooms keys in the record", () => {
    const store = fakeStorage();
    writeJobResume("job-1", { areaId: "a1", stage: "fitOff" }, store);
    expect(store._map.get("phil-job-resume:job-1")).toBe(
      JSON.stringify({ areaId: "a1", stage: "fitOff" }),
    );
  });

  it("a legacy record (no room) still reads; an unknown room is dropped", () => {
    const legacy = fakeStorage({
      "phil-job-resume:job-1": JSON.stringify({ areaId: "a1", stage: "roughIn" }),
    });
    expect(readJobResume("job-1", legacy)).toEqual({ areaId: "a1", stage: "roughIn" });

    const tampered = fakeStorage({
      "phil-job-resume:job-1": JSON.stringify({
        areaId: "a1",
        stage: "roughIn",
        room: "garage",
        areaOpen: "yes",
      }),
    });
    // Unknown room + non-boolean areaOpen are dropped; the place survives.
    expect(readJobResume("job-1", tampered)).toEqual({ areaId: "a1", stage: "roughIn" });
  });
});
