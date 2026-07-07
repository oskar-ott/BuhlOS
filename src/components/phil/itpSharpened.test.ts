import { describe, expect, it } from "vitest";
import {
  itpApplicablePoints,
  itpOwedLine,
  itpProofSummary,
  itpStations,
} from "./itpSharpened";
import type { ITPInstance, ITPInstanceResult } from "@/domains/itp/types";

/**
 * Unit tests for the sharpened Checks/ITP projections (Wave 4a, §2.8).
 * Everything asserted here is a derivation over the REAL instance model —
 * the stations are the pending → in-progress → witnessed → signed-off
 * machine, the proof split is the snapshot's photo/value kinds, and the
 * owed line mirrors the real submit gate (required points recorded).
 */

function instance(over: Partial<ITPInstance> = {}): ITPInstance {
  return {
    id: "itp_1",
    templateId: "tpl_1",
    templateSnapshot: {
      name: "Rough-in check",
      points: [
        { id: "p1", label: "IR test reading", type: "value", required: true, unit: "MΩ", min: 1 },
        { id: "p2", label: "Photos of covered work", type: "photo", required: true },
        { id: "p3", label: "Circuits labelled", type: "signoff", required: true },
      ],
    },
    scope: "area",
    scopeId: "area_1",
    status: "in-progress",
    results: {},
    createdAt: "2026-06-17T08:00:00.000Z",
    createdBy: "boss",
    updatedAt: "2026-06-17T08:30:00.000Z",
    ...over,
  };
}

function result(over: Partial<ITPInstanceResult> = {}): ITPInstanceResult {
  return {
    value: true,
    byUserId: "u_field",
    byUsername: "sparky",
    at: "2026-06-17T09:00:00.000Z",
    ...over,
  };
}

const ALL_DONE = {
  p1: result({ value: 1.2 }),
  p2: result({ value: null, photoUrl: "https://blob/p2.jpg" }),
  p3: result({ value: true }),
};

describe("itpStations — the three real stations", () => {
  it("recording open: Recorded is current, the rest pending, sub is the role word", () => {
    const s = itpStations(instance());
    expect(s.map((x) => x.state)).toEqual(["current", "pending", "pending"]);
    expect(s[2]!.sub).toBe("office");
  });

  it("all required points recorded: Submitted becomes the current station", () => {
    const s = itpStations(instance({ results: ALL_DONE }));
    expect(s.map((x) => x.state)).toEqual(["done", "current", "pending"]);
  });

  it("witnessed (= submitted for review): office sign-off is current", () => {
    const s = itpStations(instance({ status: "witnessed", results: ALL_DONE }));
    expect(s.map((x) => x.state)).toEqual(["done", "done", "current"]);
  });

  it("signed-off: all done, and the sub is the REAL signer, never invented", () => {
    const s = itpStations(
      instance({
        status: "signed-off",
        signedOffBy: "anna",
        signedOffAt: "2026-06-18T10:00:00.000Z",
        results: ALL_DONE,
      }),
    );
    expect(s.map((x) => x.state)).toEqual(["done", "done", "done"]);
    expect(s[2]!.sub).toBe("anna");
  });

  it("there is no witness station — the model has none on an instance", () => {
    const s = itpStations(instance());
    expect(s).toHaveLength(3);
    expect(s.map((x) => x.key)).toEqual(["recorded", "submitted", "signoff"]);
  });
});

describe("itpProofSummary — the snapshot's real proof kinds only", () => {
  it("splits value readings from photo-bearing points with the real attached count", () => {
    const p = itpProofSummary(
      instance({ results: { p2: result({ value: null, photoUrl: "https://blob/p2.jpg" }) } }),
    )!;
    expect(p.readings.map((x) => x.id)).toEqual(["p1"]);
    expect(p.photos).toEqual({ attached: 1, total: 1 });
  });

  it("counts evidenceRequired points as photo-bearing", () => {
    const p = itpProofSummary(
      instance({
        templateSnapshot: {
          name: "Check",
          points: [
            { id: "n1", label: "Torque note", type: "note", required: true, evidenceRequired: true },
          ],
        },
      }),
    )!;
    expect(p.readings).toEqual([]);
    expect(p.photos).toEqual({ attached: 0, total: 1 });
  });

  it("is null when the template has no proof-kind points (no fabricated taxonomy)", () => {
    const p = itpProofSummary(
      instance({
        templateSnapshot: {
          name: "Check",
          points: [
            { id: "s1", label: "Confirmed", type: "signoff", required: true },
            { id: "n1", label: "Notes", type: "note", required: false },
          ],
        },
      }),
    );
    expect(p).toBeNull();
  });

  it("excludes archived and non-applicable conditional points (#293)", () => {
    const p = itpProofSummary(
      instance({
        scope: "job",
        scopeId: undefined,
        templateSnapshot: {
          name: "Check",
          points: [
            { id: "v1", label: "Reading", type: "value", required: true, archived: true },
            {
              id: "v2",
              label: "Board reading",
              type: "value",
              required: true,
              onlyIf: { scopeType: "switchboard" },
            },
          ],
        },
      }),
    );
    expect(p).toBeNull();
  });
});

describe("itpApplicablePoints — matches the flag-off visible list", () => {
  it("drops archived points and sorts by order", () => {
    const pts = itpApplicablePoints(
      instance({
        templateSnapshot: {
          name: "Check",
          points: [
            { id: "b", label: "Second", type: "note", order: 2 },
            { id: "x", label: "Gone", type: "note", archived: true },
            { id: "a", label: "First", type: "note", order: 1 },
          ],
        },
      }),
    );
    expect(pts.map((p) => p.id)).toEqual(["a", "b"]);
  });
});

describe("itpOwedLine — mirrors the real submit gate", () => {
  it("counts the remaining required points, with the photo clause when they need one", () => {
    expect(itpOwedLine(instance({ results: { p1: result({ value: 1.2 }) } }))).toBe(
      "2 points still to record — 1 needs a photo",
    );
  });

  it("singular point wording", () => {
    expect(
      itpOwedLine(
        instance({
          results: {
            p1: result({ value: 1.2 }),
            p2: result({ value: null, photoUrl: "https://blob/p2.jpg" }),
          },
        }),
      ),
    ).toBe("1 point still to record");
  });

  it("everything recorded → send it for sign-off", () => {
    expect(itpOwedLine(instance({ results: ALL_DONE }))).toBe(
      "All points recorded — send it to the office for sign-off.",
    );
  });

  it("no required points → honest dead-end copy, never a fake go-ahead", () => {
    expect(
      itpOwedLine(
        instance({
          templateSnapshot: {
            name: "Check",
            points: [{ id: "o1", label: "Optional look", type: "note", required: false }],
          },
        }),
      ),
    ).toBe("No required points on this check — ask your PM.");
  });
});
