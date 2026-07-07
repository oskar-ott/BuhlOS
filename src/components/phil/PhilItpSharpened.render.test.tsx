import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilItpSharpened } from "./PhilItpSharpened";
import type { ITPInstance, ITPInstanceResult } from "@/domains/itp/types";
import type { Job } from "@/domains/jobs/types";

/**
 * SSR smoke for the sharpened Checks/ITP detail (Wave 4a, §2.8). Static
 * guards:
 *   - title block shows the real ref/scope line + real n/m progress;
 *   - the sign-off chain renders the three REAL stations (no invented
 *     witness/name station);
 *   - Required proof renders real readings + real photo counts, and is
 *     honestly ABSENT when the template has no proof-kind points;
 *   - the points list keeps the existing ITPPointCard behaviour/testids;
 *   - "Snag raised" renders ONLY for a real #520 origin link;
 *   - the sticky primary carries the real next action + owed line, and
 *     disappears once the office owns the check.
 * Recording/submit dynamics stay covered by the existing card/route tests.
 */

const viewer = { id: "u_field", role: "tradie" };

const job: Job = {
  id: "j1",
  name: "Level 12 Office Fitout",
  code: "IV0041",
  areaGroups: [
    { id: "g1", name: "Ground", areas: [{ id: "area_1", name: "Reception" }] },
  ],
} as Job;

function instance(over: Partial<ITPInstance> = {}): ITPInstance {
  return {
    id: "itp_1",
    templateId: "tpl_1",
    templateSnapshot: {
      name: "Rough-in check",
      points: [
        { id: "p1", label: "IR test reading", type: "value", required: true, unit: "MΩ", min: 1 },
        { id: "p2", label: "Photos of covered work", type: "photo", required: true },
        { id: "p3", label: "Earth continuity", type: "value", required: true, unit: "Ω", max: 0.5 },
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
    value: 1.2,
    byUserId: "u_field",
    byUsername: "sparky",
    at: "2026-06-17T09:00:00.000Z",
    ...over,
  };
}

function render(
  inst: ITPInstance,
  snagPointIds: ReadonlyArray<string> = [],
): string {
  return renderToString(
    createElement(PhilItpSharpened, {
      job,
      instance: inst,
      viewer,
      initialSnagPointIds: snagPointIds,
    }),
  );
}

describe("PhilItpSharpened — title block", () => {
  it("shows the real name, job code · scope line, badge and n/m progress", () => {
    const html = render(instance({ results: { p1: result() } }));
    expect(html).toContain("Rough-in check");
    expect(html).toContain("IV0041 · Area: Reception");
    expect(html).toContain("In progress");
    expect(html).toContain("1/3");
    expect(html).toContain("1 of 3 points recorded");
  });

  it("pending reads Not started — nothing recorded is not progress", () => {
    const html = render(instance({ status: "pending" }));
    expect(html).toContain("Not started");
  });
});

describe("PhilItpSharpened — sign-off chain (real stations only)", () => {
  it("renders Recorded → Submitted → Signed off with the office role word", () => {
    const html = render(instance());
    expect(html).toContain('data-testid="phil-itp-signoff-chain"');
    expect(html).toContain("Recorded");
    expect(html).toContain("Submitted");
    expect(html).toContain("Signed off");
    expect(html).toContain("office");
    // No invented witness station or name (P7).
    expect(html).not.toContain("Witness");
    expect(html).not.toContain("Dave");
  });

  it("signed-off shows the REAL signer's name in the chain", () => {
    const html = render(
      instance({
        status: "signed-off",
        signedOffBy: "anna",
        signedOffAt: "2026-06-18T10:00:00.000Z",
        results: {
          p1: result(),
          p2: result({ value: null, photoUrl: "https://blob/p2.jpg" }),
          p3: result({ value: 0.2 }),
        },
      }),
    );
    expect(html).toContain("anna");
    expect(html).toContain("Admin has signed off this ITP");
  });
});

describe("PhilItpSharpened — required proof (real kinds, real counts)", () => {
  it("shows the recorded reading + unit and the amber photo count when short", () => {
    const html = render(instance({ results: { p1: result() } }));
    expect(html).toContain('data-testid="phil-itp-required-proof"');
    expect(html).toContain("Required proof");
    expect(html).toContain("1.2 MΩ");
    expect(html).toContain("not recorded");
    expect(html).toContain("0/1");
  });

  it("a STAMPED value-less reading agrees with its recorded glyph — never 'not recorded'", () => {
    // p1 is stamped (result.at set) but carries no reading value — a
    // note-only record. formatProgress counts it done (1/3), so the row must
    // say recorded too, not contradict its own green check.
    const html = render(instance({ results: { p1: result({ value: null }) } }));
    expect(html).toContain("1 of 3 points recorded"); // stamped = done
    expect(html).toContain("recorded · no reading value");
    // p3 is truly unrecorded — the plain fallback stays for it.
    expect(html).toContain("not recorded");
  });

  it("a failed reading renders its real value in the danger tone", () => {
    const html = render(instance({ results: { p3: result({ value: 0.9 }) } }));
    // 0.9 Ω against max 0.5 — the real recorded number, marked failed.
    expect(html).toContain("0.9 Ω");
    expect(html).toContain("text-state-danger");
  });

  it("is honestly absent when the template has no proof-kind points", () => {
    const html = render(
      instance({
        templateSnapshot: {
          name: "Sign-offs only",
          points: [
            { id: "s1", label: "Confirmed complete", type: "signoff", required: true },
          ],
        },
      }),
    );
    expect(html).not.toContain("Required proof");
  });
});

describe("PhilItpSharpened — points + snag links", () => {
  it("renders the existing point cards under a real count heading", () => {
    const html = render(instance());
    expect(html).toContain("Points · 3");
    // The EXISTING card surface — same labels the flag-off screen has.
    expect(html).toContain("Point: IR test reading");
    expect(html).toContain("Take a photo");
  });

  it("Snag raised renders ONLY for a point with a real origin link", () => {
    const html = render(instance(), ["p3"]);
    expect(html).toContain('data-testid="phil-itp-snag-raised-p3"');
    expect(html).toContain("Snag raised");
    expect(html).not.toContain('data-testid="phil-itp-snag-raised-p1"');
  });

  it("no links, no tag", () => {
    const html = render(instance());
    expect(html).not.toContain("Snag raised");
  });
});

describe("PhilItpSharpened — sticky primary + owed line", () => {
  it("disabled with the honest owed line while points are open", () => {
    const html = render(instance({ results: { p1: result() } }));
    expect(html).toContain('data-testid="phil-itp-sharpened-submit"');
    expect(html).toContain("Send to the office");
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("2 points still to record — 1 needs a photo");
  });

  it("enabled once everything required is recorded", () => {
    const html = render(
      instance({
        results: {
          p1: result(),
          p2: result({ value: null, photoUrl: "https://blob/p2.jpg" }),
          p3: result({ value: 0.2 }),
        },
      }),
    );
    expect(html).toContain('aria-disabled="false"');
    expect(html).toContain("All points recorded — send it to the office for sign-off.");
  });

  it("witnessed: the office owns it — calm notice, no sticky button", () => {
    const html = render(
      instance({
        status: "witnessed",
        results: {
          p1: result(),
          p2: result({ value: null, photoUrl: "https://blob/p2.jpg" }),
          p3: result({ value: 0.2 }),
        },
      }),
    );
    expect(html).toContain("Submitted for review — waiting on the office to sign off.");
    expect(html).not.toContain('data-testid="phil-itp-sharpened-submit"');
  });

  it("archived: locked copy, no submit affordance", () => {
    const html = render(instance({ archived: true }));
    expect(html).toContain("This ITP has been archived");
    expect(html).not.toContain('data-testid="phil-itp-sharpened-submit"');
  });
});
