import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { OwnerConsole } from "./OwnerConsole";
import type { OwnerSummary } from "@/domains/platform/owner-console";

/**
 * The Owner Console board paints every panel from a parsed summary, surfaces
 * honest "not instrumented yet" labels, marks flags read-only, and renders an
 * explicit empty state when the audit feed has no entries. No fake metrics.
 */

describe("<OwnerConsole />", () => {
  it("renders all panels, real flag data, and honest instrumentation labels", () => {
    const html = renderToString(createElement(OwnerConsole, { summary: makeSummary() }));

    for (const heading of [
      "Platform control",
      "Product health",
      "Usage &amp; activity",
      "Feature control",
      "Product problems",
      "Audit trail",
      "Surface coverage",
      "Next actions",
    ]) {
      expect(html).toContain(heading);
    }

    expect(html).toContain("Read-only");
    expect(html).toContain("rfi_register"); // a real flag key
    expect(html).toContain("expired"); // the expired flag's status chip
    expect(html).toContain("Not instrumented yet"); // honest gap label
    expect(html).toContain("Route / page views"); // a named gap
    expect(html).toContain("hours.approved"); // a real audit action
  });

  it("renders an explicit empty state when the audit feed has no entries", () => {
    const summary = makeSummary();
    summary.audit = { source: "journal", available: false, entries: [] };
    const html = renderToString(createElement(OwnerConsole, { summary }));
    expect(html).toContain("No recent activity");
  });

  it("renders the staged control when flagToggle is on; fences protected + env-pinned", () => {
    const summary = makeSummary();
    summary.capabilities = { flagToggle: true, flagToggleReason: "toggle via POST /api/owner-flags" };
    summary.flags = {
      source: "registry + env + blob",
      rev: 7,
      items: [
        // normal feature flag → the Off/Preview/Live staged control
        mkFlag({ key: "safety_docs", resolvedForOwner: true, ownerPreview: true, ownerSource: "owner-preview", previewHref: "/v2/jobs" }),
        // protected → read-only System group, no control
        mkFlag({ key: "supabase_dual_write", protected: true, toggleable: false }),
        // env-pinned → disabled, no control
        mkFlag({ key: "rfi_register", resolved: true, resolvedForOwner: true, source: "env", ownerSource: "env" }),
      ],
    };
    const html = renderToString(createElement(OwnerConsole, { summary }));

    expect(html).toContain("Owner controls"); // header chip reflects control mode
    // The staged Off/Preview/Live control for the product feature.
    expect(html).toContain("rollout-off-safety_docs");
    expect(html).toContain("rollout-preview-safety_docs");
    expect(html).toContain("rollout-live-safety_docs");
    // Preview-only feature is reachable for the owner → Open-to-test link.
    expect(html).toContain("feature-open-safety_docs");
    // Protected flag is fenced read-only in the System group — no control.
    expect(html).toContain("protected");
    expect(html).not.toContain("rollout-live-supabase_dual_write");
    // Env-pinned flag is disabled with a note — no control.
    expect(html).toContain("pinned by env");
    expect(html).not.toContain("rollout-live-rfi_register");
  });
});

/** A complete FlagItem with sensible defaults; override per case. */
function mkFlag(over: Partial<OwnerSummary["flags"]["items"][number]> & { key: string }) {
  return {
    description: `${over.key} feature`,
    default: false,
    target: "global",
    expires: "2026-12-31",
    resolved: false,
    resolvedForOwner: false,
    ownerPreview: null,
    source: "default",
    ownerSource: "default",
    expiryStatus: "ok",
    protected: false,
    toggleable: true,
    ...over,
  } as OwnerSummary["flags"]["items"][number];
}

function makeSummary(): OwnerSummary {
  return {
    ok: true,
    meta: {
      asOf: "2026-06-28T10:42:00.000Z",
      environment: "production",
      identityBasis: "owner-role",
      viewer: { role: "owner", name: "Owner", email: "o****@gmail.com" },
    },
    capabilities: {
      flagToggle: false,
      flagToggleReason: "Flags are read-only here.",
    },
    health: {
      overall: "ok",
      checks: [
        { id: "blob", label: "Blob storage", status: "ok", detail: "reachable" },
        { id: "session_secret", label: "Session signing key", status: "ok", detail: "configured" },
      ],
      notInstrumented: ["Error / exception rate", "Endpoint latency (p50/p95)"],
    },
    flags: {
      source: "feature flag registry + env + flags.json override blob",
      rev: 3,
      items: [
        {
          key: "rfi_register",
          description: "Per-job RFI register",
          default: false,
          target: "global",
          expires: "2026-12-31",
          resolved: false,
          resolvedForOwner: false,
          ownerPreview: null,
          source: "default",
          ownerSource: "default",
          expiryStatus: "ok",
          protected: false,
          toggleable: true,
        },
        {
          key: "admin_proof_review",
          description: "Office proof sign-off",
          default: false,
          target: "admin-tier",
          expires: "2026-01-01",
          resolved: true,
          resolvedForOwner: true,
          ownerPreview: null,
          source: "env",
          ownerSource: "env",
          expiryStatus: "expired",
          protected: false,
          toggleable: true,
        },
      ],
    },
    usage: {
      source: "derived from the audit journal",
      auditEvents7d: 4,
      distinctActors7d: 3,
      monthEntryCount: 18,
      monthCap: 5000,
      topActions: [{ action: "hours.approved", count: 3 }],
      notInstrumented: ["Route / page views", "Feature adoption"],
    },
    audit: {
      source: "audit log — cross-job journal",
      available: true,
      entries: [
        {
          id: "al_1",
          ts: "2026-06-28T09:00:00.000Z",
          action: "hours.approved",
          actorName: "Jess",
          actorRole: "office",
          targetType: "time_entry",
          summary: "approved Tuesday",
        },
      ],
    },
    coverage: {
      note: "First-pass matrix.",
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
      {
        severity: "high",
        title: 'Feature flag "admin_proof_review" is past its expiry',
        evidence: "feature flag registry",
        why: "Expired flags fail CI.",
        action: "Remove or extend it.",
      },
      {
        severity: "not_instrumented",
        title: "Route / feature usage is not instrumented",
        evidence: "no analytics store found",
        why: "Cannot see which surfaces are used.",
        action: "Add route-view instrumentation.",
      },
    ],
    nextActions: [
      {
        title: "Clear expired feature flag(s)",
        reason: "Expired flags fail CI.",
        priority: "high",
        safeNow: true,
        suggestedIssue: "Owner Console: remove/extend expired feature flags",
      },
    ],
  };
}
