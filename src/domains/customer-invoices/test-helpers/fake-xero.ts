import { createRequire } from "node:module";

/**
 * An in-memory stand-in for the parts of Xero's Accounting API the customer
 * invoice send touches, shaped like `xeroFetch(url, opts)` so it drops in for
 * the shared client. It behaves the way Xero's documentation says Xero does:
 *
 *   PUT  /Invoices                 create-only; InvoiceNumber unique for ACCREC;
 *                                  a repeated Idempotency-Key replays the first answer
 *   GET  /Invoices/{id}            the full invoice (with line items)
 *   GET  /Invoices?InvoiceNumbers= a summary list (NO line items)
 *
 * and lets a test break it on purpose: `failNext(...)` makes the next create
 * time out BEFORE or AFTER Xero stored it, be refused, rate-limited, or 5xx.
 * Every call is recorded in `calls` so a test can prove what was — and was
 * not — sent.
 */
const requireFromHere = createRequire(import.meta.url);
const { XeroError } = requireFromHere("../../../../api/_lib/xero/errors.js");

export interface FakeInvoice {
  InvoiceID: string;
  InvoiceNumber: string;
  Type: string;
  Status: string;
  Contact: { ContactID: string; Name?: string };
  Reference?: string;
  DateString: string;
  DueDateString: string;
  LineAmountTypes: string;
  LineItems: Array<{ Description: string; Quantity: number; UnitAmount: number; LineAmount: number; AccountCode: string; TaxType: string }>;
  SubTotal: number;
  TotalTax: number;
  Total: number;
  AmountDue: number;
  AmountPaid: number;
  AmountCredited: number;
  Url?: string;
  FullyPaidOnDate?: string;
  UpdatedDateUTCString?: string;
}

export type FailMode =
  | "timeout_before" // the request never reached Xero
  | "timeout_after" // Xero created the invoice, the answer was lost
  | "server_after" // Xero created it, then answered 500
  | "validation" // Xero refused it (400)
  | "rate_limit" // 429
  | "server_before" // 500, nothing created
  | "no_id"; // 200 with no invoice in the body

export function createFakeXero({ taxRates = { OUTPUT: 1000, EXEMPTOUTPUT: 0 } as Record<string, number> } = {}) {
  const invoices: FakeInvoice[] = [];
  const byKey = new Map<string, FakeInvoice>();
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: unknown }> = [];
  const queue: Array<{ mode: FailMode; message?: string }> = [];
  // Invoice ids a multi-invoice (IDs=) read leaves out — the way Xero might
  // for a deleted invoice. A read of that one id still answers.
  const leftOutOfLists = new Set<string>();
  let readsFail: unknown = null;
  let n = 0;
  const id = () => `aaaaaaaa-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const round2 = (v: number) => Math.round(v * 100) / 100;

  function store(input: Record<string, unknown>): FakeInvoice {
    const lines = (input.LineItems as FakeInvoice["LineItems"]).map((l) => ({
      ...l,
      LineAmount: round2(Number(l.UnitAmount) * Number(l.Quantity ?? 1)),
    }));
    const sub = round2(lines.reduce((s, l) => s + l.LineAmount, 0));
    const tax = round2(lines.reduce((s, l) => s + (l.LineAmount * (taxRates[l.TaxType] ?? 0)) / 10000, 0));
    const inv: FakeInvoice = {
      InvoiceID: id(),
      InvoiceNumber: String(input.InvoiceNumber),
      Type: String(input.Type),
      Status: String(input.Status || "DRAFT"),
      Contact: input.Contact as FakeInvoice["Contact"],
      Reference: input.Reference as string | undefined,
      DateString: `${input.Date}T00:00:00`,
      DueDateString: `${input.DueDate}T00:00:00`,
      LineAmountTypes: String(input.LineAmountTypes),
      LineItems: lines,
      SubTotal: sub,
      TotalTax: tax,
      Total: round2(sub + tax),
      AmountDue: round2(sub + tax),
      AmountPaid: 0,
      AmountCredited: 0,
      Url: input.Url as string | undefined,
    };
    invoices.push(inv);
    return inv;
  }

  const summary = (i: FakeInvoice) => {
    const { LineItems: _lines, ...rest } = i;
    void _lines;
    return rest;
  };
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

  async function xeroFetch(url: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const method = (opts.method || "GET").toUpperCase();
    const headers = opts.headers || {};
    calls.push({ method, url, headers, body: opts.body === undefined ? undefined : clone(opts.body) });
    const u = new URL(url);
    const path = u.pathname.replace("/api.xro/2.0", "");

    if (method === "PUT" && path === "/Invoices") {
      const input = ((opts.body as { Invoices?: Array<Record<string, unknown>> })?.Invoices || [])[0];
      if (!input) throw new XeroError("validation", { status: 400, detail: "No invoice in the request" });
      const key = headers["Idempotency-Key"];
      if (key && byKey.has(key)) return { data: { Invoices: [clone(byKey.get(key))] }, correlationId: "fake-replay" };
      const fail = queue.shift();
      if (fail?.mode === "timeout_before") throw new XeroError("timeout", { detail: "api_request" });
      if (fail?.mode === "server_before") throw new XeroError("server", { status: 500, detail: "api_request" });
      if (fail?.mode === "rate_limit") throw new XeroError("rate_limit", { status: 429, retryAfterSeconds: 60, detail: "api_request" });
      if (fail?.mode === "validation") throw new XeroError("validation", { status: 400, detail: fail.message || "Account code '999' is not a valid code for this document." });
      if (invoices.some((i) => i.Type === "ACCREC" && i.InvoiceNumber === input.InvoiceNumber)) {
        throw new XeroError("validation", { status: 400, detail: "Invoice # must be unique." });
      }
      if (input.Status && input.Status !== "DRAFT") throw new Error("the send must only ever create a DRAFT");
      if (Object.keys(input.Contact as object).join() !== "ContactID") throw new Error("only ContactID may be sent in Contact");
      const inv = store(input);
      if (key) byKey.set(key, inv);
      if (fail?.mode === "timeout_after") throw new XeroError("timeout", { detail: "api_request" });
      if (fail?.mode === "server_after") throw new XeroError("server", { status: 500, detail: "api_request" });
      if (fail?.mode === "no_id") return { data: { Invoices: [] }, correlationId: "fake-no-id" };
      return { data: { Invoices: [clone(inv)] }, correlationId: "fake-corr" };
    }
    if (method !== "GET") throw new Error(`the fake Xero got an unexpected ${method} ${path}`);
    if (readsFail) throw readsFail;

    if (path === "/Invoices") {
      const numbers = (u.searchParams.get("InvoiceNumbers") || "").split(",").filter(Boolean);
      const ids = (u.searchParams.get("IDs") || "").split(",").filter(Boolean);
      const hits = invoices.filter(
        (i) => numbers.includes(i.InvoiceNumber) || (ids.includes(i.InvoiceID) && !leftOutOfLists.has(i.InvoiceID))
      );
      return { data: { Invoices: hits.map((i) => clone(summary(i))) }, correlationId: "fake-corr" };
    }
    if (path.startsWith("/Invoices/")) {
      const inv = invoices.find((i) => i.InvoiceID === path.slice("/Invoices/".length));
      if (!inv) throw new XeroError("not_found", { status: 404 });
      return { data: { Invoices: [clone(inv)] }, correlationId: "fake-corr" };
    }
    throw new Error(`the fake Xero has no answer for ${method} ${path}`);
  }

  return {
    xeroFetch,
    invoices,
    calls,
    /** Queue a failure for the next create(s). */
    failNext(mode: FailMode, message?: string) {
      queue.push({ mode, message });
    },
    /** Put an invoice straight into "Xero" (e.g. one the office made by hand). */
    seed(input: Partial<FakeInvoice> & { InvoiceNumber: string }) {
      const inv = store({
        Type: "ACCREC", Status: "DRAFT", Contact: { ContactID: "someone-else" }, Date: "2026-11-01", DueDate: "2026-12-01",
        LineAmountTypes: "Exclusive", LineItems: [{ Description: "Hand-made", Quantity: 1, UnitAmount: 1, AccountCode: "200", TaxType: "OUTPUT" }],
        ...input,
      });
      Object.assign(inv, input);
      return inv;
    },
    // ── what the office does in Xero after a send (#1151) ──────────────────
    /** The invoice with this number (throws when there is none). */
    get(number: string): FakeInvoice {
      const inv = invoices.find((i) => i.InvoiceNumber === number);
      if (!inv) throw new Error(`no invoice ${number} in the fake Xero`);
      return inv;
    },
    approve(number: string) {
      this.get(number).Status = "AUTHORISED";
    },
    /** Record a payment (GST-inclusive dollars). Fully paid → PAID. */
    pay(number: string, amount: number, onDay = "2026-12-10") {
      const inv = this.get(number);
      inv.AmountPaid = round2(inv.AmountPaid + amount);
      inv.AmountDue = round2(inv.Total - inv.AmountPaid);
      if (inv.AmountDue <= 0) {
        inv.Status = "PAID";
        inv.FullyPaidOnDate = `/Date(${Date.parse(`${onDay}T00:00:00Z`)}+0000)/`;
      } else {
        inv.Status = "AUTHORISED";
      }
    },
    void(number: string) {
      Object.assign(this.get(number), { Status: "VOIDED", AmountDue: 0 });
    },
    delete(number: string) {
      Object.assign(this.get(number), { Status: "DELETED", AmountDue: 0 });
    },
    /** The office edits the draft's amount in Xero. */
    editSubtotal(number: string, subtotal: number) {
      const inv = this.get(number);
      inv.SubTotal = subtotal;
      inv.TotalTax = round2(subtotal * 0.1);
      inv.Total = round2(subtotal * 1.1);
      inv.AmountDue = round2(inv.Total - inv.AmountPaid);
    },
    /** Make a multi-invoice read leave this invoice out. */
    leaveOutOfLists(number: string) {
      leftOutOfLists.add(this.get(number).InvoiceID);
    },
    /** Remove an invoice entirely (Xero has nothing under its id). */
    vanish(number: string) {
      invoices.splice(invoices.indexOf(this.get(number)), 1);
    },
    /** Make every read fail (e.g. Xero is down) until cleared with null. */
    failReads(err: unknown) {
      readsFail = err;
    },
    puts: () => calls.filter((c) => c.method === "PUT"),
    gets: () => calls.filter((c) => c.method === "GET"),
  };
}

export type FakeXero = ReturnType<typeof createFakeXero>;
