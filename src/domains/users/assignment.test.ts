import { describe, it, expect } from "vitest";
import {
  computeAssignedJobIds,
  diffWorkerAssignments,
  filterAssignableWorkers,
  isAssignableWorkerRole,
  isActiveAccount,
  toAssignableWorker,
} from "./assignment";
import type { AssignableWorker, UserAccount } from "./types";

function account(over: Partial<UserAccount> & { id: string; role: string }): UserAccount {
  return { username: over.id, assignedJobIds: [], ...over };
}

describe("isAssignableWorkerRole", () => {
  it("accepts the field tier and the leading-hand tier (canonical + legacy aliases)", () => {
    for (const role of [
      "tradie",
      "apprentice",
      "labourer",
      "electrician",
      "leadinghand",
      "leading_hand",
      "leading-hand",
      "lh",
      "ELECTRICIAN", // case-insensitive via normaliseRole
    ]) {
      expect(isAssignableWorkerRole(role)).toBe(true);
    }
  });

  it("rejects admin-tier and client roles (non-field, not Phil-gated by assignedJobIds)", () => {
    for (const role of ["admin", "boss", "owner", "manager", "office", "pm", "estimator", "client"]) {
      expect(isAssignableWorkerRole(role)).toBe(false);
    }
  });
});

describe("isActiveAccount", () => {
  it("treats archived / disabled / status:disabled as inactive", () => {
    expect(isActiveAccount({ archived: true })).toBe(false);
    expect(isActiveAccount({ disabled: true })).toBe(false);
    expect(isActiveAccount({ status: "disabled" })).toBe(false);
    expect(isActiveAccount({})).toBe(true);
  });
});

describe("filterAssignableWorkers", () => {
  const users: UserAccount[] = [
    account({ id: "u_admin", username: "boss", role: "admin", assignedJobIds: ["j1"] }),
    account({ id: "u_office", username: "office", role: "office" }),
    account({ id: "u_client", username: "client", role: "client", assignedJobIds: ["j1"] }),
    account({ id: "u_t1", username: "zane", role: "tradie", assignedJobIds: ["j1"] }),
    account({ id: "u_t2", username: "amy", role: "electrician", assignedJobIds: [] }),
    account({ id: "u_lh", username: "lee", role: "lh", assignedJobIds: ["j2"] }),
    account({ id: "u_gone", username: "gone", role: "tradie", archived: true }),
  ];

  it("keeps only active field/LH workers, dropping admin/office/client/archived", () => {
    const ids = filterAssignableWorkers(users).map((w) => w.id);
    expect(ids).toEqual(["u_t2", "u_lh", "u_t1"]); // sorted by username: amy, lee, zane
  });

  it("projects only the four secret-free fields (no extra account data leaks)", () => {
    // Simulate an over-broad API row carrying a hash + rate; both must be dropped.
    const withSecret = [
      { id: "u_t1", username: "zane", role: "tradie", assignedJobIds: [], passwordHash: "$2a$10$leak", hourlyRate: 55 },
    ] as unknown as UserAccount[];
    const [w] = filterAssignableWorkers(withSecret);
    expect(Object.keys(w!).sort()).toEqual(["assignedJobIds", "id", "role", "username"]);
  });

  it("de-duplicates by id (first wins)", () => {
    const dupes = [
      account({ id: "u_t1", username: "zane", role: "tradie", assignedJobIds: ["j1"] }),
      account({ id: "u_t1", username: "zane2", role: "tradie", assignedJobIds: [] }),
    ];
    const out = filterAssignableWorkers(dupes);
    expect(out).toHaveLength(1);
    expect(out[0]!.username).toBe("zane");
  });
});

describe("toAssignableWorker", () => {
  it("copies the assignedJobIds array (no shared reference)", () => {
    const src = account({ id: "u", role: "tradie", assignedJobIds: ["a"] });
    const w = toAssignableWorker(src);
    expect(w.assignedJobIds).toEqual(["a"]);
    expect(w.assignedJobIds).not.toBe(src.assignedJobIds);
  });
});

describe("computeAssignedJobIds — preserve other jobs", () => {
  it("adds the job id while preserving the worker's other assignments", () => {
    expect(computeAssignedJobIds(["j1", "j2"], "j3", true)).toEqual(["j1", "j2", "j3"]);
  });

  it("removes only the target job id, leaving the rest intact", () => {
    expect(computeAssignedJobIds(["j1", "j2", "j3"], "j2", false)).toEqual(["j1", "j3"]);
  });

  it("is idempotent when assigning an already-assigned job (and de-dupes)", () => {
    expect(computeAssignedJobIds(["j1", "j2", "j2"], "j2", true)).toEqual(["j1", "j2"]);
  });

  it("is a no-op when removing a job the worker doesn't have", () => {
    expect(computeAssignedJobIds(["j1"], "jX", false)).toEqual(["j1"]);
  });
});

describe("diffWorkerAssignments — only changed users", () => {
  const workers: AssignableWorker[] = [
    { id: "a", username: "amy", role: "tradie", assignedJobIds: ["job-1", "other"] }, // already on job-1
    { id: "b", username: "ben", role: "electrician", assignedJobIds: ["other"] }, // not on job-1
    { id: "c", username: "cat", role: "lh", assignedJobIds: [] }, // not on job-1
  ];

  it("emits a change only for workers whose membership flips, with full toggled arrays", () => {
    // desired: keep amy (a), add ben (b); cat stays unassigned.
    const selected = new Set(["a", "b"]);
    const changes = diffWorkerAssignments(workers, "job-1", selected);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      id: "b",
      assigned: true,
      assignedJobIds: ["other", "job-1"], // preserves "other"
    });
  });

  it("emits a removal that preserves the worker's other jobs", () => {
    // desired: deselect amy (a) → remove job-1 but keep "other".
    const selected = new Set<string>(["b"]);
    const changes = diffWorkerAssignments(workers, "job-1", selected);
    const amy = changes.find((c) => c.id === "a");
    const ben = changes.find((c) => c.id === "b");
    expect(amy).toMatchObject({ assigned: false, assignedJobIds: ["other"] });
    expect(ben).toMatchObject({ assigned: true, assignedJobIds: ["other", "job-1"] });
  });

  it("returns no changes when the selection matches current state", () => {
    const selected = new Set(["a"]); // a already on job-1, b & c already off
    expect(diffWorkerAssignments(workers, "job-1", selected)).toEqual([]);
  });
});
