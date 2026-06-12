import { describe, expect, it } from "vitest";
import { buildCompliancePack } from "./compliance-pack";
import type { ITPInstance } from "./types";
import type { Job } from "@/domains/jobs/types";

/**
 * Pure pack-model contract (#286). The printable view renders exactly what
 * this builder emits, so the honesty rules are pinned here: in-progress
 * watermarking, awaiting-sign-off as a distinct state, not-recorded rows,
 * archived excluded-and-counted, determinism, and signedOffBy rendered as
 * stored.
 */

const job = {
  id: "j1",
  name: "Riverside",
  ref: "BW-12",
  areaGroups: [
    { id: "g1", name: "Ground", areas: [{ id: "a1", name: "Unit 1" }] },
  ],
} as unknown as Job;

function inst(id: string, extra: Partial<ITPInstance> = {}): ITPInstance {
  return {
    id,
    jobId: "j1",
    templateId: "tpl",
    scope: "job",
    status: "pending",
    archived: false,
    createdAt: "2026-06-01T00:00:00.000Z",
    results: {},
    templateSnapshot: {
      name: "Energisation QA",
      points: [
        { id: "p1", label: "Torque check", type: "value", unit: "Nm", min: 10, max: 20 },
        { id: "p2", label: "Labels fitted", type: "signoff" },
      ],
    },
    ...extra,
  } as unknown as ITPInstance;
}

const NOW = "2026-06-12T10:00:00.000Z";

function build(instances: ITPInstance[], overrides: Record<string, string> = {}) {
  return buildCompliancePack({
    job,
    instances,
    overrides,
    overridesWindowMonths: 12,
    generatedAt: NOW,
  });
}

describe("buildCompliancePack — honesty rules", () => {
  it("pending/in-progress instances carry the watermark; nothing fakes completeness", () => {
    const pack = build([inst("i1", { status: "in-progress" })]);
    expect(pack.instances[0]!.inProgress).toBe(true);
    expect(pack.instances[0]!.awaitingSignOff).toBe(false);
    expect(pack.instances[0]!.signOff).toBeNull();
  });

  it("witnessed-but-unsigned is a DISTINCT state from in-progress", () => {
    const pack = build([inst("i1", { status: "witnessed" })]);
    expect(pack.instances[0]!.awaitingSignOff).toBe(true);
    expect(pack.instances[0]!.inProgress).toBe(false);
  });

  it("a point with no result row is recorded:false — 'Not recorded', never blank", () => {
    const pack = build([inst("i1")]);
    expect(pack.instances[0]!.points.map((p) => p.recorded)).toEqual([false, false]);
  });

  it("archived instances are EXCLUDED and COUNTED", () => {
    const pack = build([inst("i1"), inst("i2", { archived: true })]);
    expect(pack.instances).toHaveLength(1);
    expect(pack.archivedCount).toBe(1);
  });

  it("empty job builds an honest empty pack, not an error", () => {
    const pack = build([]);
    expect(pack.instances).toEqual([]);
    expect(pack.summary).toEqual([]);
    expect(pack.jobName).toBe("Riverside");
  });
});

describe("buildCompliancePack — point rows", () => {
  it("value points render value + unit + derived pass/fail; recorded-by as stored", () => {
    const pack = build([
      inst("i1", {
        results: {
          p1: { value: 15, note: "ok", photoUrl: "", byUserId: "u1", byUsername: "sparky", at: "2026-06-02T01:00:00.000Z" },
        },
      }),
    ]);
    const row = pack.instances[0]!.points[0]!;
    expect(row).toMatchObject({
      recorded: true,
      valueLabel: "15 Nm",
      passFail: "pass",
      note: "ok",
      byUsername: "sparky",
    });
  });

  it("an out-of-range value reads fail — the pack never hides a failing reading", () => {
    const pack = build([
      inst("i1", {
        results: {
          p1: { value: 99, note: "", photoUrl: "", byUserId: "u1", byUsername: "s", at: "2026-06-02T01:00:00.000Z" },
        },
      }),
    ]);
    expect(pack.instances[0]!.points[0]!.passFail).toBe("fail");
  });

  it("photo-only results render the photo as the result", () => {
    const pack = build([
      inst("i1", {
        templateSnapshot: {
          name: "T",
          points: [{ id: "p1", label: "Board photo", type: "photo" }],
        },
        results: {
          p1: { value: null, note: "", photoUrl: "https://blob/x.jpg", byUserId: "u1", byUsername: "s", at: "2026-06-02T01:00:00.000Z" },
        },
      } as Partial<ITPInstance>),
    ]);
    const row = pack.instances[0]!.points[0]!;
    expect(row.recorded).toBe(true);
    expect(row.photoUrl).toBe("https://blob/x.jpg");
    expect(row.valueLabel).toBeNull();
  });
});

describe("buildCompliancePack — sign-off + overrides + determinism", () => {
  it("sign-off block renders as stored and threads the audit-sourced override", () => {
    const pack = build(
      [
        inst("i1", {
          status: "signed-off",
          signedOffBy: "boss",
          signedOffAt: "2026-06-03T00:00:00.000Z",
        } as Partial<ITPInstance>),
      ],
      { i1: "Recorded most points myself — solo job" }
    );
    expect(pack.instances[0]!.signOff).toEqual({
      signedOffBy: "boss",
      signedOffAt: "2026-06-03T00:00:00.000Z",
      overrideJustification: "Recorded most points myself — solo job",
    });
    expect(pack.overridesNote).toContain("12 months");
  });

  it("deterministic: same data → same pack; instances ordered by createdAt", () => {
    const data = [
      inst("i_b", { createdAt: "2026-06-02T00:00:00.000Z" }),
      inst("i_a", { createdAt: "2026-06-01T00:00:00.000Z" }),
    ];
    const one = build(data);
    const two = build([...data].reverse());
    expect(one).toEqual(two);
    expect(one.instances.map((i) => i.id)).toEqual(["i_a", "i_b"]);
  });
});
