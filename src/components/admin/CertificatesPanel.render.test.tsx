import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { CertificatesPanel } from "./CertificatesPanel";
import type { Certificate } from "@/domains/certificates/schema";

/**
 * SSR render tests for the certificates register (#231): the upload form, an
 * honest empty state, and the typed/dated/sorted list.
 */

function cert(over: Partial<Certificate> & Pick<Certificate, "id">): Certificate {
  return {
    jobId: "job-1",
    type: "certificate",
    title: "Cert",
    referenceNo: "",
    issuedAt: "",
    fileName: "c.pdf",
    blobPath: "p",
    url: "https://blob.test/p",
    mimeType: "application/pdf",
    sizeBytes: 1,
    status: "current",
    uploadedAt: "2026-06-01T00:00:00.000Z",
    uploadedBy: "boss",
    ...over,
  };
}

const strip = (h: string) => h.replace(/<!-- -->/g, "");

describe("CertificatesPanel — empty", () => {
  it("shows the upload form and an honest empty state", () => {
    const html = strip(
      renderToString(
        createElement(CertificatesPanel, {
          jobId: "job-1",
          initialCertificates: [],
          fetchError: null,
        })
      )
    );
    expect(html).toContain("Certificates &amp; commissioning");
    expect(html).toContain("Add to register");
    expect(html).toContain("No certificates on this job yet.");
  });
});

describe("CertificatesPanel — with rows", () => {
  const html = strip(
    renderToString(
      createElement(CertificatesPanel, {
        jobId: "job-1",
        initialCertificates: [
          cert({
            id: "c_old",
            type: "commissioning",
            title: "DALI commissioning",
            issuedAt: "2026-05-01",
          }),
          cert({
            id: "c_new",
            type: "certificate",
            title: "CCEW main switchboard",
            referenceNo: "CCEW-2026-014",
            issuedAt: "2026-06-20",
          }),
        ],
        fetchError: null,
      })
    )
  );

  it("renders type, title, reference and issue date", () => {
    expect(html).toContain("CCEW main switchboard");
    expect(html).toContain("Commissioning record");
    expect(html).toContain("CCEW-2026-014");
    expect(html).toContain("2026-06-20");
  });

  it("orders newest issue date first", () => {
    expect(html.indexOf("CCEW main switchboard")).toBeLessThan(html.indexOf("DALI commissioning"));
  });
});
