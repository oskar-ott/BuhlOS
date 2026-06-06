import { describe, expect, it } from "vitest";
import {
  parseActivityResult,
  parseEvidenceResult,
  parseHoursResult,
  parseJobResult,
} from "./job-interface-data";

/**
 * The four parsers are the only branchy logic in the hub's operational-loop
 * loader (the fetch/header wiring stays in the page). These tests pin every
 * branch — rejected settle, non-ok status, malformed body, and success — so a
 * failed sub-fetch is proven to degrade to a typed error slice rather than
 * throw or fabricate data.
 */

function fulfilled(
  status: number,
  body: unknown,
  opts: { jsonThrows?: boolean } = {},
): PromiseSettledResult<Response> {
  const res = {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      if (opts.jsonThrows) throw new Error("bad json");
      return body;
    },
  } as unknown as Response;
  return { status: "fulfilled", value: res };
}

function rejected(reason: unknown): PromiseSettledResult<Response> {
  return { status: "rejected", reason };
}

describe("parseJobResult", () => {
  it("maps a rejected fetch to an error (Error → its message)", async () => {
    expect(await parseJobResult(rejected(new Error("boom")))).toEqual({
      kind: "error",
      message: "boom",
    });
  });

  it("maps a non-Error rejection to a generic network error", async () => {
    expect(await parseJobResult(rejected("weird"))).toEqual({
      kind: "error",
      message: "Network error",
    });
  });

  it("maps 404 / 403 to not_found / forbidden", async () => {
    expect(await parseJobResult(fulfilled(404, null))).toEqual({ kind: "not_found" });
    expect(await parseJobResult(fulfilled(403, null))).toEqual({ kind: "forbidden" });
  });

  it("maps any other non-ok status to an error with the code", async () => {
    expect(await parseJobResult(fulfilled(500, null))).toEqual({
      kind: "error",
      message: "API returned 500",
    });
  });

  it("maps a malformed body (json throws or wrong shape) to an honest error", async () => {
    expect(await parseJobResult(fulfilled(200, null, { jsonThrows: true }))).toEqual({
      kind: "error",
      message: "Unexpected response shape",
    });
    expect(await parseJobResult(fulfilled(200, { nope: true }))).toEqual({
      kind: "error",
      message: "Unexpected response shape",
    });
  });

  it("returns the parsed job on success", async () => {
    const r = await parseJobResult(fulfilled(200, { job: { id: "job-1", name: "Test" } }));
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.job.id).toBe("job-1");
  });
});

describe("parseHoursResult", () => {
  it("degrades a rejected fetch to an empty slice with an error", async () => {
    expect(await parseHoursResult(rejected(new Error("net")))).toEqual({
      entries: [],
      error: "net",
    });
  });

  it("degrades a non-ok response to an empty slice with the status", async () => {
    expect(await parseHoursResult(fulfilled(502, null))).toEqual({
      entries: [],
      error: "Hours API returned 502",
    });
  });

  it("degrades a malformed body to an empty slice", async () => {
    expect(await parseHoursResult(fulfilled(200, { wrong: 1 }))).toEqual({
      entries: [],
      error: "Unexpected hours response shape",
    });
  });

  it("returns entries on success", async () => {
    expect(await parseHoursResult(fulfilled(200, { entries: [] }))).toEqual({
      entries: [],
      error: null,
    });
  });
});

describe("parseEvidenceResult", () => {
  it("degrades a rejected fetch", async () => {
    expect(await parseEvidenceResult(rejected(new Error("x")))).toEqual({
      evidence: [],
      error: "x",
    });
  });

  it("degrades a non-ok response", async () => {
    expect(await parseEvidenceResult(fulfilled(500, null))).toEqual({
      evidence: [],
      error: "Evidence API returned 500",
    });
  });

  it("degrades a malformed body", async () => {
    expect(await parseEvidenceResult(fulfilled(200, {}))).toEqual({
      evidence: [],
      error: "Unexpected evidence response shape",
    });
  });

  it("returns evidence on success", async () => {
    expect(await parseEvidenceResult(fulfilled(200, { evidence: [] }))).toEqual({
      evidence: [],
      error: null,
    });
  });
});

describe("parseActivityResult", () => {
  it("degrades a rejected fetch", async () => {
    expect(await parseActivityResult(rejected(new Error("y")))).toEqual({
      entries: [],
      error: "y",
    });
  });

  it("degrades a non-ok response", async () => {
    expect(await parseActivityResult(fulfilled(503, null))).toEqual({
      entries: [],
      error: "Activity API returned 503",
    });
  });

  it("degrades a malformed body", async () => {
    expect(await parseActivityResult(fulfilled(200, { entries: "nope" }))).toEqual({
      entries: [],
      error: "Unexpected activity response shape",
    });
  });

  it("returns entries on success", async () => {
    expect(await parseActivityResult(fulfilled(200, { entries: [] }))).toEqual({
      entries: [],
      error: null,
    });
  });
});
