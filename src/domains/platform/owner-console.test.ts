import { describe, expect, it } from "vitest";
import {
  OwnerSummarySchema,
  checkTone,
  coverageTone,
  expiryTone,
  flagSourceLabel,
  flagStateTone,
  healthLabel,
  healthTone,
  severityLabel,
  severityRank,
  severityTone,
  sortProblems,
  type ProblemItem,
} from "./owner-console";

describe("owner-console classification helpers", () => {
  it("ranks severities most-urgent first", () => {
    expect(severityRank("blocker")).toBeLessThan(severityRank("high"));
    expect(severityRank("high")).toBeLessThan(severityRank("medium"));
    expect(severityRank("medium")).toBeLessThan(severityRank("low"));
    expect(severityRank("low")).toBeLessThan(severityRank("not_instrumented"));
  });

  it("sortProblems orders by severity and does not mutate the input", () => {
    const input: ProblemItem[] = [
      { severity: "low", title: "a", evidence: "", why: "", action: "" },
      { severity: "blocker", title: "b", evidence: "", why: "", action: "" },
      { severity: "medium", title: "c", evidence: "", why: "", action: "" },
      { severity: "not_instrumented", title: "d", evidence: "", why: "", action: "" },
      { severity: "high", title: "e", evidence: "", why: "", action: "" },
    ];
    const out = sortProblems(input);
    expect(out.map((p) => p.severity)).toEqual([
      "blocker",
      "high",
      "medium",
      "low",
      "not_instrumented",
    ]);
    expect(input[0]?.severity).toBe("low"); // original untouched
  });

  it("maps every severity to a tone and label", () => {
    expect(severityTone("blocker")).toBe("danger");
    expect(severityTone("high")).toBe("danger");
    expect(severityTone("medium")).toBe("warning");
    expect(severityTone("low")).toBe("info");
    expect(severityTone("not_instrumented")).toBe("neutral");
    expect(severityLabel("not_instrumented")).toBe("Not instrumented");
    expect(severityLabel("high")).toBe("high");
  });

  it("maps health, checks, expiry, flag state, source and coverage to tones", () => {
    expect(healthTone("ok")).toBe("success");
    expect(healthTone("warning")).toBe("warning");
    expect(healthTone("needs_attention")).toBe("danger");
    expect(healthLabel("needs_attention")).toBe("Needs attention");

    expect(checkTone("ok")).toBe("success");
    expect(checkTone("down")).toBe("danger");
    expect(checkTone("misconfigured")).toBe("danger");

    expect(expiryTone("ok")).toBe("neutral");
    expect(expiryTone("expiring")).toBe("warning");
    expect(expiryTone("expired")).toBe("danger");

    expect(flagStateTone(true)).toBe("success");
    expect(flagStateTone(false)).toBe("neutral");

    expect(flagSourceLabel("env")).toBe("env override");
    expect(flagSourceLabel("override")).toBe("blob override");
    expect(flagSourceLabel("default")).toBe("registry default");

    expect(coverageTone(true)).toBe("success");
    expect(coverageTone(false)).toBe("neutral");
  });
});

describe("OwnerSummarySchema", () => {
  it("parses a well-formed owner summary", () => {
    expect(OwnerSummarySchema.safeParse(validSummary()).success).toBe(true);
  });

  it("rejects a payload with ok:false or a missing section", () => {
    expect(OwnerSummarySchema.safeParse({ ...validSummary(), ok: false }).success).toBe(false);
    const noFlags = validSummary() as Record<string, unknown>;
    delete noFlags.flags;
    expect(OwnerSummarySchema.safeParse(noFlags).success).toBe(false);
  });
});

function validSummary() {
  return {
    ok: true as const,
    meta: {
      asOf: "2026-06-28T10:42:00.000Z",
      environment: "production",
      identityBasis: "owner-role" as const,
      viewer: { role: "owner", name: "Owner", email: "o*****@gmail.com" },
    },
    capabilities: { flagToggle: false, flagToggleReason: "read-only" },
    health: {
      overall: "ok" as const,
      checks: [{ id: "blob", label: "Blob storage", status: "ok" as const, detail: "reachable" }],
      notInstrumented: ["Error rate"],
    },
    flags: {
      source: "registry",
      items: [
        {
          key: "rfi_register",
          description: "RFI register",
          default: false,
          target: "global",
          expires: "2026-12-31",
          resolved: false,
          source: "default" as const,
          expiryStatus: "ok" as const,
          protected: false,
          toggleable: false,
        },
      ],
    },
    usage: {
      source: "audit",
      auditEvents7d: 3,
      distinctActors7d: 2,
      monthEntryCount: 12,
      monthCap: 5000,
      topActions: [{ action: "hours.approved", count: 2 }],
      notInstrumented: ["Route views"],
    },
    audit: {
      source: "journal",
      available: true,
      entries: [
        {
          id: "al_1",
          ts: "2026-06-28T09:00:00.000Z",
          action: "hours.approved",
          actorName: "Jess",
          actorRole: "office",
          targetType: "time_entry",
          summary: "approved Tue",
        },
      ],
    },
    coverage: {
      note: "first-pass",
      rows: [
        {
          area: "Hours",
          surface: "BuhlOS",
          routeExists: true,
          accessGuarded: true,
          auditTracked: true,
          usageTracked: false,
          errorsTracked: false,
        },
      ],
    },
    problems: [
      { severity: "low" as const, title: "x", evidence: "e", why: "w", action: "a" },
    ],
    nextActions: [
      { title: "do x", reason: "r", priority: "low" as const, safeNow: true, suggestedIssue: "i" },
    ],
  };
}
