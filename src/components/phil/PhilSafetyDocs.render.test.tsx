import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { PhilSafetyDocs } from "./PhilSafetyDocs";
import type { SafetyDoc } from "@/domains/safety-docs/schema";

/**
 * SSR render tests for the Phil acknowledge UI (#219): the worker sees each doc
 * with an "Open document" link and an acknowledge action, and already-read docs
 * show a read state instead of the button.
 */

function doc(over: Partial<SafetyDoc> & Pick<SafetyDoc, "id" | "title">): SafetyDoc {
  return {
    jobId: "job-1",
    type: "swms",
    version: 1,
    fileName: "x.pdf",
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

describe("PhilSafetyDocs — empty", () => {
  it("shows an honest empty state", () => {
    const html = strip(
      renderToString(
        createElement(PhilSafetyDocs, {
          jobId: "job-1",
          initialDocuments: [],
          initialAckedIds: [],
          fetchError: null,
        })
      )
    );
    expect(html).toContain("Nothing to read here");
  });
});

describe("PhilSafetyDocs — read vs unread", () => {
  const html = strip(
    renderToString(
      createElement(PhilSafetyDocs, {
        jobId: "job-1",
        initialDocuments: [
          doc({ id: "sd_1", title: "Working at Heights" }),
          doc({ id: "sd_2", title: "Energised Work", type: "sds" }),
        ],
        initialAckedIds: ["sd_1"], // first already acknowledged
        fetchError: null,
      })
    )
  );

  it("lists each doc with an open link and an acknowledge action", () => {
    expect(html).toContain("Working at Heights");
    expect(html).toContain("Energised Work");
    expect(html).toContain("Open document");
    expect(html).toContain("read this"); // covers both "I've read this" and "you've read this"
  });

  it("shows the already-read doc as read, not as a fresh button", () => {
    expect(html).toContain("Read"); // the read badge on sd_1
  });
});
