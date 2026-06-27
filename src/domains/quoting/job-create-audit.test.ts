import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES } from "@/domains/audit-log/schema";

/**
 * #581 — the job-creation audit-log payload builders. Pure: the handlers append
 * the result best-effort after the job write. Asserts the shape, the privacy
 * line (no dollar amount), and that every action/target the builders emit is a
 * synced enum value (so the journal write isn't dropped by audit-log.js's
 * VALID_ACTIONS / VALID_TARGET_TYPES gate).
 */
const requireFromHere = createRequire(import.meta.url);
const { buildJobCreatedEntry, buildQuoteConvertedEntry } = requireFromHere(
  "../../../api/_lib/job-create-audit.js",
) as {
  buildJobCreatedEntry: (input: Record<string, unknown>) => Record<string, unknown>;
  buildQuoteConvertedEntry: (input: Record<string, unknown>) => Record<string, unknown>;
};

const ACTOR = { id: "u_admin", username: "Daniel", role: "admin" };
const JOB = { id: "birdwood-iv3232", name: "Birdwood IV", status: "draft" };
const QUOTE = { id: "quote_abc", name: "Birdwood IV — quote" };

describe("buildJobCreatedEntry (#581)", () => {
  it("shapes a builder-sourced job.created payload", () => {
    const p = buildJobCreatedEntry({ actor: ACTOR, job: JOB, source: "builder" });
    expect(p).toMatchObject({
      action: "job.created",
      actorId: "u_admin",
      actorName: "Daniel",
      actorRole: "admin",
      jobId: "birdwood-iv3232",
      targetType: "job",
      targetId: "birdwood-iv3232",
    });
    expect(p.metadata).toMatchObject({ source: "builder", name: "Birdwood IV", status: "draft" });
    expect((p.metadata as { fromQuoteId?: string }).fromQuoteId).toBeUndefined();
  });

  it("carries source quote_convert + fromQuoteId when converted from a quote", () => {
    const p = buildJobCreatedEntry({ actor: ACTOR, job: JOB, source: "quote_convert", fromQuoteId: "quote_abc" });
    expect((p.metadata as { source: string; fromQuoteId: string })).toMatchObject({
      source: "quote_convert",
      fromQuoteId: "quote_abc",
    });
    expect(String(p.summary)).toContain("from a won quote");
  });

  it("records no dollar amount (privacy line)", () => {
    const p = buildJobCreatedEntry({ actor: ACTOR, job: JOB, source: "builder" });
    expect(JSON.stringify(p)).not.toMatch(/amount|contractValue|price|dollar|\$/i);
  });
});

describe("buildQuoteConvertedEntry (#581)", () => {
  it("targets the quote but carries the new jobId so it surfaces in the job feed", () => {
    const p = buildQuoteConvertedEntry({ actor: ACTOR, quote: QUOTE, jobId: "birdwood-iv3232" });
    expect(p).toMatchObject({
      action: "quote.converted",
      targetType: "quote",
      targetId: "quote_abc",
      jobId: "birdwood-iv3232",
    });
    expect((p.metadata as { jobId: string; quoteName: string })).toMatchObject({
      jobId: "birdwood-iv3232",
      quoteName: "Birdwood IV — quote",
    });
  });
});

describe("both builders emit only synced enum values", () => {
  it("actions + target types are in the audit-log enums", () => {
    const created = buildJobCreatedEntry({ actor: ACTOR, job: JOB, source: "builder" });
    const converted = buildQuoteConvertedEntry({ actor: ACTOR, quote: QUOTE, jobId: JOB.id });
    for (const p of [created, converted]) {
      expect(AUDIT_ACTIONS).toContain(p.action);
      expect(AUDIT_TARGET_TYPES).toContain(p.targetType);
    }
  });
});
