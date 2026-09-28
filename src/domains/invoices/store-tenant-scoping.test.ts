import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Cross-tenant test pack (remediation Task G, 2026-09-27) — part 1: the SQL.
 *
 * The in-memory store used by the handler tests is single-tenant, so it can
 * never prove that the REAL queries are tenant-scoped. This test runs every
 * tenant-taking function of api/_lib/invoices/store.js against a recording
 * `sql` tag (no database) and asserts that EVERY statement it issues filters
 * on `tenant_id` with the tenant it was given — fragments spliced into a
 * statement (`sql\`and …\``) are expanded into it first, so a predicate that
 * lives in a fragment still counts, and one that is missing still fails. A
 * function that reads or writes a supplier invoice, document, allocation,
 * event, line, learned category or supplier preference without the tenant
 * predicate fails here — before any second company ever shares a database.
 *
 * Out of scope on purpose (documented, asserted): `finishAttempt` (keyed by
 * the attempt's own uuid, created tenant-scoped by startAttempt),
 * `recordInboundEvent` / `finishInboundEvent` (pre-tenant Svix receipts,
 * keyed by the provider's message id), `resolveTenant` (the lookup itself),
 * and statements that touch ONLY `supplier_invoice_inbound_events` (that
 * table has no tenant column — a webhook arrives before the tenant is known).
 */
const requireFromHere = createRequire(import.meta.url);
const store = requireFromHere("../../../api/_lib/invoices/store.js") as Record<string, unknown>;

type Frag = { text: string; values: unknown[] };
type TaggedPromise = Promise<unknown[]> & { __frag?: Frag };
type Sql = ((strings: TemplateStringsArray | unknown[], ...values: unknown[]) => TaggedPromise | { __in: unknown[] }) & {
  json: (v: unknown) => unknown;
  begin: (fn: (tx: Sql) => Promise<unknown>) => Promise<unknown>;
  calls: Frag[];
};

/** A `postgres`-shaped tag that records instead of querying. Every tag call
 *  is recorded; a call used as a VALUE inside another call is a fragment and
 *  is expanded into its parent. Rows come back as one blank row, so functions
 *  may throw after their statements ran — the statements are what we check. */
function recorder(): Sql {
  const calls: Frag[] = [];
  const tag = ((strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
    if (!Array.isArray(strings) || !("raw" in strings)) return { __in: strings as unknown[] }; // sql(ids) helper for IN lists
    const frag: Frag = { text: (strings as TemplateStringsArray).raw.join("$"), values };
    calls.push(frag);
    const rows: unknown[] = [{}];
    const p = Promise.resolve(rows) as TaggedPromise;
    p.__frag = frag;
    return p;
  }) as Sql;
  tag.json = (v: unknown) => ({ __json: v });
  tag.begin = async (fn) => fn(tag);
  tag.calls = calls;
  return tag;
}

function isFragValue(v: unknown): v is TaggedPromise {
  return !!v && typeof v === "object" && "__frag" in (v as object) && !!(v as TaggedPromise).__frag;
}

/** Expand spliced fragments: text with each fragment's text in place of its `$`, values flattened. */
function expand(f: Frag): Frag {
  const parts = f.text.split("$");
  let text = parts[0] ?? "";
  const values: unknown[] = [];
  f.values.forEach((v, i) => {
    if (isFragValue(v)) {
      const inner = expand(v.__frag as Frag);
      text += inner.text;
      values.push(...inner.values);
    } else {
      text += "$";
      values.push(v);
    }
    text += parts[i + 1] ?? "";
  });
  return { text, values };
}

const isStatement = (text: string) => /^\s*(select|insert|update|delete|with)\b/i.test(text);
const isInboundOnly = (text: string) => /supplier_invoice_inbound_events/.test(text) && !/supplier_invoices\b/.test(text);
const TENANT_PREDICATE = /tenant_id\s*=\s*\$|\(\s*tenant_id\s*,|,\s*tenant_id\s*,|tenant_id\s*\)\s*values/i;

const TENANT = "11111111-1111-4111-8111-111111111111";
const INVOICE = "22222222-2222-4222-8222-222222222222";
const DOC = "33333333-3333-4333-8333-333333333333";
const actor = { id: "u_admin", name: "Karen Boss", role: "admin" };

/** Every tenant-taking store function with representative arguments. */
const CASES: Array<{ name: string; args: () => unknown[] }> = [
  { name: "resolveJobUuid", args: () => [TENANT, "birdwood"] },
  { name: "createInvoice", args: () => [TENANT, { source: "upload", sourceFilename: "a.pdf", createdBy: "u_admin", createdByName: "Karen" }] },
  {
    name: "createInvoiceWithDocument",
    args: () => [
      TENANT,
      { source: "upload", sourceFilename: "a.pdf", createdBy: "u_admin", createdByName: "Karen" },
      { source: "upload", kind: "pdf", filename: "a.pdf", contentType: "application/pdf", byteSize: 1, sha256: "s", blobPathname: "x", blobUrl: "blob://x", uploadedBy: "u_admin", uploadedByName: "Karen" },
    ],
  },
  { name: "getInvoiceRow", args: () => [TENANT, INVOICE] },
  { name: "getInvoiceDetail", args: () => [TENANT, INVOICE] },
  { name: "getDocumentWithBlob", args: () => [TENANT, INVOICE, DOC] },
  { name: "listInvoices", args: () => [TENANT, { status: ["matched"], supplier: "x", jobId: "birdwood", from: "2026-01-01", to: "2026-12-31", q: "x", autoConfirm: "pending", page: 1, limit: 10 }] },
  { name: "countsByStatus", args: () => [TENANT] },
  { name: "listSuppliers", args: () => [TENANT] },
  { name: "listSupplierInvoices", args: () => [TENANT, "sparky", INVOICE] },
  { name: "applyExtraction", args: () => [TENANT, INVOICE, { status: "matched", reviewReasons: [], fields: {}, ivCandidates: [] }] },
  { name: "updateInvoiceFields", args: () => [TENANT, INVOICE, { supplierName: "x", actor }] },
  { name: "setStatus", args: () => [TENANT, INVOICE, "excluded", { actor }] },
  { name: "addDocument", args: () => [TENANT, { invoiceId: INVOICE, filename: "a.pdf", blobUrl: "blob://x", blobPathname: "x", byteSize: 1, sha256: "s", kind: "pdf" }] },
  { name: "updateDocumentText", args: () => [TENANT, DOC, { pageCount: 1, hasTextLayer: true }] },
  { name: "findDocumentByProvider", args: () => [TENANT, "email-1", "att-1"] },
  { name: "findInvoicesByChecksum", args: () => [TENANT, "sha", INVOICE] },
  { name: "findInvoicesBySupplierNumber", args: () => [TENANT, "sparky", "SS-1", INVOICE] },
  { name: "claimPending", args: () => [TENANT, { limit: 3 }] },
  { name: "claimOne", args: () => [TENANT, INVOICE, { resetAttempts: true }] },
  { name: "startAttempt", args: () => [TENANT, INVOICE, "upload"] },
  { name: "confirmAllocation", args: () => [TENANT, INVOICE, { jobLegacyId: "birdwood", jobUuid: null, amountCents: 100, gstCents: 10, totalCents: 110, matchStatus: "manual", actor }] },
  { name: "transitionWithReversal", args: () => [TENANT, INVOICE, { status: "excluded", actor, event: "excluded", detail: {}, extra: {} }] },
  { name: "reassignAllocation", args: () => [TENANT, INVOICE, { jobLegacyId: "kent-st", jobUuid: null, amountCents: 100, gstCents: 10, totalCents: 110, actor }] },
  { name: "jobSummary", args: () => [TENANT, "birdwood"] },
  { name: "jobSummaries", args: () => [TENANT, ["birdwood", "kent-st"]] },
  { name: "insertEvent", args: () => [TENANT, INVOICE, { event: "held", actor, detail: {} }] },
  { name: "supplierHumanConfirmedCount", args: () => [TENANT, "sparky"] },
  { name: "supplierConfirmedOnJob", args: () => [TENANT, "sparky", "birdwood"] },
  { name: "getSupplierPref", args: () => [TENANT, "sparky"] },
  { name: "setSupplierPref", args: () => [TENANT, "sparky", { alwaysReview: true, actor }] },
  { name: "scheduleAutoConfirm", args: () => [TENANT, INVOICE, { eligible: true, checks: [], at: null }] },
  { name: "holdInvoice", args: () => [TENANT, INVOICE, actor] },
  { name: "claimAutoConfirmDue", args: () => [TENANT, { limit: 10, now: new Date("2026-09-27T00:00:00Z") }] },
  { name: "digestStats", args: () => [TENANT, { since: "2026-09-20T00:00:00.000Z" }] },
  { name: "listQuarantined", args: () => [TENANT, { limit: 10 }] },
  { name: "inboundStats", args: () => [TENANT] },
  { name: "healthSnapshot", args: () => [TENANT] },
  { name: "invoiceIdsForEmail", args: () => [TENANT, "email-1"] },
  { name: "replaceInvoiceLines", args: () => [TENANT, INVOICE, [{ lineNo: 1, description: "cable", descriptionKey: "cable", category: "cable" }]] },
  { name: "listInvoiceLines", args: () => [TENANT, INVOICE] },
  { name: "updateInvoiceLine", args: () => [TENANT, INVOICE, 1, { category: "fixings" }] },
  { name: "learnedCategories", args: () => [TENANT, "sparky", ["cable"]] },
  { name: "rememberCategory", args: () => [TENANT, { supplierKey: "sparky", descriptionKey: "cable", category: "cable", actor }] },
  { name: "jobMaterialsBreakdown", args: () => [TENANT, "birdwood"] },
  // Landed on main during the 2026-09-28 remediation merges (D, F, H, I).
  { name: "jobActiveAllocations", args: () => [TENANT, "birdwood"] },
  { name: "shadowRows", args: () => [TENANT, { from: "2026-07-01", to: "2026-09-28" }] },
  { name: "hasInboundEvent", args: () => ["msg_1"] },
  { name: "listLearnedCategories", args: () => [TENANT, { limit: 50 }] },
  { name: "forgetLearnedCategory", args: () => [TENANT, "44444444-4444-4444-8444-444444444444"] },
];

const EXEMPT = new Set(["resolveTenant", "finishAttempt", "recordInboundEvent", "finishInboundEvent"]);
const NOT_QUERIES = new Set(["TENANT_SLUG", "MAX_ATTEMPTS"]);
/** Functions whose statements may touch only the pre-tenant inbound table. */
const INBOUND_READERS = new Set(["digestStats", "healthSnapshot", "inboundStats", "listQuarantined", "hasInboundEvent"]);

async function run(name: string, args: unknown[]): Promise<Frag[]> {
  const fn = store[name] as (...a: unknown[]) => Promise<unknown>;
  const sql = recorder();
  try {
    await fn(sql, ...args);
  } catch {
    // A blank result row makes some functions throw after their statements ran — the statements are what we check.
  }
  // Statements only (fragments are folded into their parents), fragments expanded.
  const fragValues = new Set<Frag>();
  for (const c of sql.calls) for (const v of c.values) if (isFragValue(v)) fragValues.add(v.__frag as Frag);
  return sql.calls.filter((c) => !fragValues.has(c) && isStatement(c.text)).map(expand);
}

describe("invoice store — every statement is tenant-scoped", () => {
  it("the case list covers every exported function (new functions must be added here or exempted with a reason)", () => {
    const exported = Object.keys(store).filter((k) => !NOT_QUERIES.has(k));
    const covered = new Set([...CASES.map((c) => c.name), ...EXEMPT]);
    const missing = exported.filter((k) => !covered.has(k));
    expect(missing, `store functions without a tenant-scoping case: ${missing.join(", ")}`).toEqual([]);
  });

  for (const c of CASES) {
    it(`${c.name}: filters on tenant_id with the tenant it was given, in every statement`, async () => {
      expect(typeof store[c.name], `${c.name} is not exported`).toBe("function");
      const statements = await run(c.name, c.args());
      expect(statements.length, `${c.name} issued no SQL statement`).toBeGreaterThan(0);
      const tenantBearing = statements.filter((s) => !isInboundOnly(s.text));
      if (!INBOUND_READERS.has(c.name)) expect(tenantBearing.length, `${c.name} issued only inbound-table statements`).toBeGreaterThan(0);
      for (const s of tenantBearing) {
        expect(s.text, `${c.name} statement without a tenant predicate:\n${s.text}`).toMatch(TENANT_PREDICATE);
        expect(s.values, `${c.name} statement not bound to the given tenant:\n${s.text}`).toContain(TENANT);
      }
    });
  }

  it("only the documented inbound readers ever issue a statement without a tenant", async () => {
    const offenders: string[] = [];
    for (const c of CASES) {
      const statements = await run(c.name, c.args());
      if (statements.some((s) => isInboundOnly(s.text)) && !INBOUND_READERS.has(c.name)) offenders.push(c.name);
    }
    expect(offenders).toEqual([]);
  });
});
