import { describe, expect, it } from "vitest";
import {
  buildAddOp,
  buildLinkOp,
  linkOptionKey,
  parseLinkOptionKey,
} from "./closeout-ops";
import { CloseoutOpSchema } from "@/server/job-control/closeout-producer";

/**
 * The closeout authoring panel can't be clicked in the node test runner, so the
 * exact ops it emits are built by these pure helpers and validated HERE against
 * the SAME `CloseoutOpSchema` the route enforces — proof the panel's add + link
 * controls emit ops the server actually accepts (#374 follow-up).
 */

describe("buildAddOp", () => {
  it("builds an add op the route schema accepts", () => {
    const op = buildAddOp("RCD test schedule handed over", "document");
    expect(op).not.toBeNull();
    expect(CloseoutOpSchema.parse(op)).toMatchObject({
      op: "add",
      title: "RCD test schedule handed over",
      kind: "document",
    });
  });

  it("trims the title and rejects a blank one (no fabricated requirement)", () => {
    expect(buildAddOp("   ", "other")).toBeNull();
    expect(buildAddOp("", "certificate")).toBeNull();
    expect(buildAddOp("  Padded  ", "evidence")?.title).toBe("Padded");
  });
});

describe("buildLinkOp", () => {
  it("builds a link op (replace semantics) the route schema accepts", () => {
    const op = buildLinkOp("cr_1", [
      { type: "certificate", id: "cert_real" },
      { type: "as-built", id: "doc_ab" },
    ]);
    const parsed = CloseoutOpSchema.parse(op);
    expect(parsed).toMatchObject({ op: "link", requirementId: "cr_1" });
    if (parsed.op !== "link") throw new Error("expected link op");
    expect(parsed.links.map((l) => l.id)).toEqual(["cert_real", "doc_ab"]);
  });

  it("emits an empty link array to clear (still schema-valid)", () => {
    const op = buildLinkOp("cr_1", []);
    expect(CloseoutOpSchema.parse(op)).toMatchObject({ op: "link", links: [] });
  });
});

describe("link option key round-trip", () => {
  it("encodes and parses a typed record reference back to the same link", () => {
    const link = { type: "evidence" as const, id: "ev_123" };
    const key = linkOptionKey(link);
    expect(parseLinkOptionKey(key)).toEqual(link);
  });

  it("keeps an id containing a colon intact (space-separated key)", () => {
    const link = { type: "document" as const, id: "plan:rev:2" };
    expect(parseLinkOptionKey(linkOptionKey(link))).toEqual(link);
  });

  it("returns null for a malformed key", () => {
    expect(parseLinkOptionKey("")).toBeNull();
    expect(parseLinkOptionKey("certificate")).toBeNull();
    expect(parseLinkOptionKey("certificate ")).toBeNull();
  });
});
