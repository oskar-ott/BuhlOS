import { describe, expect, it } from "vitest";
import {
  acknowledgedDocIds,
  allAcknowledgedByWorker,
  computeAckRollup,
  currentDocs,
  hasAcknowledged,
  nextVersion,
  type AssignedWorker,
} from "./rollup";
import type { SafetyDoc, SafetyAck } from "./schema";

function doc(over: Partial<SafetyDoc> & Pick<SafetyDoc, "id">): SafetyDoc {
  return {
    jobId: "job-1",
    type: "swms",
    title: "SWMS",
    version: 1,
    fileName: "x.pdf",
    blobPath: "p",
    url: "u",
    mimeType: "application/pdf",
    sizeBytes: 1,
    status: "current",
    supersedesId: null,
    supersededById: null,
    uploadedAt: "2026-06-27T00:00:00.000Z",
    uploadedBy: "boss",
    ...over,
  };
}
function ack(docId: string, userId: string, version = 1): SafetyAck {
  return { docId, version, userId, userName: userId, at: "2026-06-27T01:00:00.000Z" };
}

const WORKERS: AssignedWorker[] = [
  { id: "w1", name: "Dave" },
  { id: "w2", name: "Sam" },
];

// doc-v1 (swms v1) superseded by doc-v2 (swms v2, current); sds-1 (current).
const DOCS: SafetyDoc[] = [
  doc({ id: "doc-v1", version: 1, status: "superseded", supersededById: "doc-v2" }),
  doc({ id: "doc-v2", version: 2, status: "current", supersedesId: "doc-v1" }),
  doc({ id: "sds-1", type: "sds", title: "SDS", status: "current" }),
];
// w1 acked the old v1 AND the new v2; w2 acked only the old v1, plus sds-1.
const ACKS: SafetyAck[] = [
  ack("doc-v1", "w1", 1),
  ack("doc-v2", "w1", 2),
  ack("doc-v1", "w2", 1),
  ack("sds-1", "w2", 1),
];

describe("currentDocs", () => {
  it("returns only non-superseded docs", () => {
    expect(currentDocs(DOCS).map((d) => d.id)).toEqual(["doc-v2", "sds-1"]);
  });
});

describe("hasAcknowledged / acknowledgedDocIds", () => {
  it("reads a single acknowledgement", () => {
    expect(hasAcknowledged(ACKS, "doc-v2", "w1")).toBe(true);
    expect(hasAcknowledged(ACKS, "doc-v2", "w2")).toBe(false);
  });
  it("counts only acknowledgements of CURRENT docs", () => {
    // w1 acked doc-v1 (superseded) + doc-v2 (current) → only doc-v2 counts
    expect(acknowledgedDocIds(currentDocs(DOCS), ACKS, "w1")).toEqual(["doc-v2"]);
    // w2 acked doc-v1 (superseded) + sds-1 (current) → only sds-1 counts
    expect(acknowledgedDocIds(currentDocs(DOCS), ACKS, "w2")).toEqual(["sds-1"]);
  });
});

describe("computeAckRollup — a new version resets acknowledgement", () => {
  const rollup = computeAckRollup(currentDocs(DOCS), ACKS, WORKERS);

  it("splits acknowledged vs outstanding per current doc", () => {
    const v2 = rollup.find((r) => r.doc.id === "doc-v2")!;
    expect(v2.acknowledged.map((a) => a.userId)).toEqual(["w1"]);
    // w2 acked v1 but NOT the current v2 → outstanding despite the old ack
    expect(v2.outstanding.map((o) => o.userId)).toEqual(["w2"]);

    const sds = rollup.find((r) => r.doc.id === "sds-1")!;
    expect(sds.acknowledged.map((a) => a.userId)).toEqual(["w2"]);
    expect(sds.outstanding.map((o) => o.userId)).toEqual(["w1"]);
  });
});

describe("allAcknowledgedByWorker (readiness seam)", () => {
  it("is true when there is nothing to acknowledge", () => {
    expect(allAcknowledgedByWorker([], ACKS, "w1")).toBe(true);
  });
  it("is false while any current doc is unacknowledged", () => {
    // w1 acked doc-v2 but not sds-1
    expect(allAcknowledgedByWorker(currentDocs(DOCS), ACKS, "w1")).toBe(false);
  });
  it("is true once every current doc is acknowledged", () => {
    expect(allAcknowledgedByWorker([doc({ id: "doc-v2", version: 2 })], ACKS, "w1")).toBe(true);
  });
});

describe("nextVersion", () => {
  it("increments a prior version, or starts at 1", () => {
    expect(nextVersion(doc({ id: "doc-v2", version: 2 }))).toBe(3);
    expect(nextVersion(null)).toBe(1);
  });
});
