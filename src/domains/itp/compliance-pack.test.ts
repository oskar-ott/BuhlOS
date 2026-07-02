import { describe, expect, it } from "vitest";
import {
  buildCompliancePack,
  buildHandoverChecklistSection,
  buildTestResultsSection,
} from "./compliance-pack";
import type { ITPInstance } from "./types";
import type { Job } from "@/domains/jobs/types";
import type { TestRecord } from "@/domains/test-records/schema";

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

  it("carries job id + site address for the letterhead (site null when not captured)", () => {
    const pack = build([]);
    expect(pack.jobId).toBe("j1");
    expect(pack.siteAddress).toBeNull();
    const withSite = buildCompliancePack({
      job: { ...job, siteAddress: "27 Kooba Ave, Lane Cove NSW 2066" } as unknown as Job,
      instances: [],
      overrides: {},
      overridesWindowMonths: 12,
      generatedAt: NOW,
    });
    expect(withSite.siteAddress).toBe("27 Kooba Ave, Lane Cove NSW 2066");
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

function testRecord(id: string, extra: Partial<TestRecord> = {}): TestRecord {
  return {
    id,
    jobId: "j1",
    reportType: "eicr",
    rows: [
      {
        circuit: "Ring final — kitchen sockets",
        testType: "insulation_resistance",
        value: 250,
        unit: "MΩ",
        min: 1,
        max: null,
        status: "pass",
      },
    ],
    tester: "sparky",
    testedAt: "2026-06-05T02:00:00.000Z",
    overallStatus: "pass",
    createdAt: "2026-06-05T02:05:00.000Z",
    ...extra,
  } as TestRecord;
}

describe("buildCompliancePack — #519 electrical test results", () => {
  it("is null with zero records — the pack never prints an empty scaffold", () => {
    expect(build([]).testResults).toBeNull();
    expect(buildTestResultsSection([])).toBeNull();
  });

  it("rows reproduce readings, units, limits and SERVER-DERIVED verdicts as stored", () => {
    const pack = buildCompliancePack({
      job,
      instances: [],
      overrides: {},
      overridesWindowMonths: 12,
      generatedAt: NOW,
      testRecords: [
        testRecord("tr_1", {
          rows: [
            {
              circuit: "Lights — level 1",
              testType: "earth_fault_loop_zs",
              value: 0.35,
              unit: "Ω",
              min: null,
              max: 1.37,
              status: "pass",
              note: "at DB",
            },
            {
              circuit: "Spa RCD",
              testType: "rcd_trip_time",
              value: 480,
              unit: "ms",
              min: null,
              max: 300,
              status: "fail",
            },
            {
              circuit: "Oven",
              testType: "functional",
              value: null,
              unit: null,
              min: null,
              max: null,
              status: "na",
            },
          ] as TestRecord["rows"],
          overallStatus: "fail",
        }),
      ],
    });
    const rec = pack.testResults!.records[0]!;
    expect(rec).toMatchObject({
      id: "tr_1",
      reportTypeLabel: "EICR",
      tester: "sparky",
      testedAt: "2026-06-05T02:00:00.000Z",
      overallStatus: "fail",
      supersedesId: null,
    });
    // Readings verbatim — never reformatted into invented precision.
    expect(rec.rows[0]).toEqual({
      circuit: "Lights — level 1",
      testTypeLabel: "Earth loop (Zs)",
      reading: "0.35 Ω",
      limits: "≤ 1.37",
      status: "pass",
      note: "at DB",
    });
    // A failing reading passes through as fail — never re-judged or hidden.
    expect(rec.rows[1]!.status).toBe("fail");
    expect(rec.rows[1]!.reading).toBe("480 ms");
    // No reading / no limits → "—" and na, never blank or invented.
    expect(rec.rows[2]).toMatchObject({ reading: "—", limits: "—", status: "na" });
  });

  it("an unknown/other test type falls back to the stored string — never guessed", () => {
    const section = buildTestResultsSection([
      testRecord("tr_1", {
        rows: [
          {
            circuit: "C1",
            testType: "other",
            value: 7,
            unit: null,
            min: 1,
            max: 9,
            status: "pass",
          },
        ] as TestRecord["rows"],
      }),
    ])!;
    expect(section.records[0]!.rows[0]!.testTypeLabel).toBe("Other");
    expect(section.records[0]!.rows[0]!.reading).toBe("7");
    expect(section.records[0]!.rows[0]!.limits).toBe("≥ 1, ≤ 9");
  });

  it("superseded records are EXCLUDED and COUNTED; the correction names its target", () => {
    const section = buildTestResultsSection([
      testRecord("tr_1"),
      testRecord("tr_2", {
        supersedesId: "tr_1",
        testedAt: "2026-06-06T02:00:00.000Z",
      }),
    ])!;
    expect(section.records.map((r) => r.id)).toEqual(["tr_2"]);
    expect(section.supersededCount).toBe(1);
    expect(section.records[0]!.supersedesId).toBe("tr_1");
  });

  it("a supersede chain prints only the latest revision per lineage", () => {
    const section = buildTestResultsSection([
      testRecord("tr_1"),
      testRecord("tr_2", { supersedesId: "tr_1", testedAt: "2026-06-06T02:00:00.000Z" }),
      testRecord("tr_3", { supersedesId: "tr_2", testedAt: "2026-06-07T02:00:00.000Z" }),
      testRecord("tr_x", { testedAt: "2026-06-01T02:00:00.000Z" }),
    ])!;
    expect(section.records.map((r) => r.id)).toEqual(["tr_x", "tr_3"]);
    expect(section.supersededCount).toBe(2);
  });

  it("deterministic: same records → same section; ordered by testedAt", () => {
    const data = [
      testRecord("tr_b", { testedAt: "2026-06-06T02:00:00.000Z" }),
      testRecord("tr_a", { testedAt: "2026-06-05T02:00:00.000Z" }),
    ];
    const one = buildTestResultsSection(data);
    const two = buildTestResultsSection([...data].reverse());
    expect(one).toEqual(two);
    expect(one!.records.map((r) => r.id)).toEqual(["tr_a", "tr_b"]);
  });

  it("degenerate supersede cycle falls back to printing everything — never drops all records", () => {
    const section = buildTestResultsSection([
      testRecord("tr_1", { supersedesId: "tr_2" }),
      testRecord("tr_2", { supersedesId: "tr_1" }),
    ])!;
    expect(section.records).toHaveLength(2);
    expect(section.supersededCount).toBe(0);
  });
});

describe("buildCompliancePack — #374 handover checklist (AC4)", () => {
  it("is null when no closeout requirements are supplied (honest absence)", () => {
    expect(build([]).handoverChecklist).toBeNull();
    expect(buildHandoverChecklistSection([])).toBeNull();
  });

  it("prepends a composable section with statuses + only resolving linked refs", () => {
    const pack = buildCompliancePack({
      job,
      instances: [],
      overrides: {},
      overridesWindowMonths: 12,
      generatedAt: NOW,
      closeoutRequirements: [
        {
          id: "cr_1",
          title: "Certificate of electrical safety issued",
          status: "satisfied",
          links: [
            { type: "certificate", id: "cert_ok", resolved: true },
            { type: "certificate", id: "cert_gone", resolved: false },
          ],
        },
        { id: "cr_2", title: "As-builts issued", status: "outstanding" },
        { id: "cr_3", title: "Deviation waived", status: "waived" },
      ],
    });
    const section = pack.handoverChecklist!;
    expect(section.total).toBe(3);
    // discharged = satisfied + waived
    expect(section.discharged).toBe(2);
    expect(section.rows[0]!.statusLabel).toBe("Closed out");
    // only the RESOLVING link is listed (a dangling link is not handover evidence)
    expect(section.rows[0]!.linkedRefs).toEqual(["certificate:cert_ok"]);
    expect(section.rows[1]!.discharged).toBe(false);
    expect(section.rows[2]!.statusLabel).toBe("Waived");
  });
});
