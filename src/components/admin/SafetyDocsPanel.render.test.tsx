import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { SafetyDocsPanel } from "./SafetyDocsPanel";
import type { SafetyDoc, SafetyDocRollup } from "@/domains/safety-docs/schema";

/**
 * SSR render tests for the office Safety panel (#219): the upload form, the
 * current docs, and the acknowledged/outstanding rollup (the office's "who has
 * and hasn't read it" view).
 */

function doc(over: Partial<SafetyDoc> & Pick<SafetyDoc, "id">): SafetyDoc {
  return {
    jobId: "job-1",
    type: "swms",
    title: "Working at Heights",
    version: 1,
    fileName: "swms.pdf",
    blobPath: "p",
    url: "https://blob.test/p",
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

const strip = (h: string) => h.replace(/<!-- -->/g, "");

describe("SafetyDocsPanel — empty", () => {
  it("shows the upload form and an honest empty state", () => {
    const html = strip(
      renderToString(
        createElement(SafetyDocsPanel, {
          jobId: "job-1",
          initialDocuments: [],
          initialRollup: [],
          fetchError: null,
        })
      )
    );
    expect(html).toContain("Safety documents");
    expect(html).toContain("Upload safety document");
    expect(html).toContain("No safety documents on this job yet.");
  });
});

describe("SafetyDocsPanel — with a doc + rollup", () => {
  const d = doc({ id: "sd_1" });
  const rollup: SafetyDocRollup[] = [
    {
      doc: d,
      acknowledged: [{ userId: "w1", name: "Dave", at: "2026-06-27T01:00:00.000Z" }],
      outstanding: [{ userId: "w2", name: "Sam" }],
    },
  ];
  const html = strip(
    renderToString(
      createElement(SafetyDocsPanel, {
        jobId: "job-1",
        initialDocuments: [d],
        initialRollup: rollup,
        fetchError: null,
      })
    )
  );

  it("lists the doc with its type and version", () => {
    expect(html).toContain("Working at Heights");
    expect(html).toContain("SWMS");
    expect(html).toContain("v1");
  });

  it("shows the acknowledged vs outstanding split with names", () => {
    expect(html).toContain("1/2 acknowledged");
    expect(html).toContain("Dave"); // acknowledged
    expect(html).toContain("Sam"); // outstanding
  });
});
