import { describe, expect, it } from "vitest";
import { currentCertificates, sortByIssuedDesc } from "./sort";
import type { Certificate } from "./schema";

function cert(over: Partial<Certificate> & Pick<Certificate, "id">): Certificate {
  return {
    jobId: "job-1",
    type: "certificate",
    title: "Cert",
    referenceNo: "",
    issuedAt: "",
    fileName: "c.pdf",
    blobPath: "p",
    url: "u",
    mimeType: "application/pdf",
    sizeBytes: 1,
    status: "current",
    uploadedAt: "2026-06-01T00:00:00.000Z",
    uploadedBy: "boss",
    ...over,
  };
}

describe("currentCertificates", () => {
  it("drops archived", () => {
    const out = currentCertificates([cert({ id: "a" }), cert({ id: "b", status: "archived" })]);
    expect(out.map((c) => c.id)).toEqual(["a"]);
  });
});

describe("sortByIssuedDesc", () => {
  it("newest issue date first; undated sink; upload tiebreak", () => {
    const list = [
      cert({ id: "old", issuedAt: "2026-01-01" }),
      cert({ id: "undated", issuedAt: "", uploadedAt: "2026-06-10T00:00:00.000Z" }),
      cert({ id: "new", issuedAt: "2026-05-01" }),
      cert({ id: "undated2", issuedAt: "", uploadedAt: "2026-06-20T00:00:00.000Z" }),
    ];
    expect(sortByIssuedDesc(list).map((c) => c.id)).toEqual(["new", "old", "undated2", "undated"]);
  });
  it("does not mutate the input", () => {
    const list = [
      cert({ id: "a", issuedAt: "2026-01-01" }),
      cert({ id: "b", issuedAt: "2026-02-01" }),
    ];
    sortByIssuedDesc(list);
    expect(list.map((c) => c.id)).toEqual(["a", "b"]);
  });
});
