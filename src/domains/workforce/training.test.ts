import { describe, expect, it } from "vitest";
import {
  TRAINING_KIND,
  isTrainingCredential,
  trainingRecords,
  renewalBandFor,
  renewalOf,
  trainingRenewalLabel,
  summariseTraining,
} from "./training";
import type { Credential } from "./types";

/** #336 — pure training projection over the kind-discriminated credential
 *  store. No expiry recompute: status/daysToExpiry are the server engine's
 *  output (api/_lib/licence-compliance.js), re-presented in renewal terms. */

function cred(over: Partial<Credential>): Credential {
  return {
    id: over.id ?? "c1",
    userId: "u1",
    typeId: "t1",
    label: "Course",
    status: "current",
    daysToExpiry: 100,
    ...over,
  } as Credential;
}

describe("kind discrimination", () => {
  it("training records are kind='training'; trainingRecords filters a mixed list", () => {
    const list = [
      cred({ id: "L", kind: "licence" }),
      cred({ id: "T1", kind: TRAINING_KIND }),
      cred({ id: "T2", kind: TRAINING_KIND }),
      cred({ id: "U" }), // undefined kind (legacy licence) → not training
    ];
    expect(isTrainingCredential({ kind: "training" })).toBe(true);
    expect(isTrainingCredential({ kind: "licence" })).toBe(false);
    expect(trainingRecords(list).map((c) => c.id)).toEqual(["T1", "T2"]);
  });
});

describe("renewal band (re-presents the engine status, no recompute)", () => {
  it("maps each credential status to a reminder band", () => {
    expect(renewalBandFor("expired")).toBe("overdue");
    expect(renewalBandFor("expiring")).toBe("due-soon");
    expect(renewalBandFor("current")).toBe("ok");
    expect(renewalBandFor("no-expiry")).toBe("none");
  });
  it("renewalOf carries through the server-computed status + days", () => {
    expect(renewalOf({ status: "expiring", daysToExpiry: 12 })).toEqual({
      status: "expiring",
      daysToRenewal: 12,
      band: "due-soon",
    });
  });
});

describe("trainingRenewalLabel (day-count phrasing)", () => {
  it("no renewal date", () => {
    expect(trainingRenewalLabel({ expiryDate: null, daysToExpiry: null })).toBe("no renewal date");
  });
  it("overdue / today / future", () => {
    expect(trainingRenewalLabel({ expiryDate: "2026-01-01", daysToExpiry: -3 })).toBe("renewal overdue by 3 days");
    expect(trainingRenewalLabel({ expiryDate: "2026-06-22", daysToExpiry: 0 })).toBe("renews today");
    expect(trainingRenewalLabel({ expiryDate: "2026-07-01", daysToExpiry: 1 })).toBe("renews in 1 day");
    expect(trainingRenewalLabel({ expiryDate: "2026-09-01", daysToExpiry: 30 })).toBe("renews in 30 days");
  });
});

describe("summariseTraining", () => {
  it("rolls up by renewal band", () => {
    const records = [
      cred({ status: "current" }),
      cred({ status: "expiring" }),
      cred({ status: "expiring" }),
      cred({ status: "expired" }),
      cred({ status: "no-expiry" }),
    ];
    expect(summariseTraining(records)).toEqual({ total: 5, ok: 1, dueSoon: 2, overdue: 1, noRenewal: 1 });
  });
  it("empty → zeros", () => {
    expect(summariseTraining([])).toEqual({ total: 0, ok: 0, dueSoon: 0, overdue: 0, noRenewal: 0 });
  });
});
