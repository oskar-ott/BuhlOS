import { describe, it, expect } from "vitest";
// The email templates run in the legacy CommonJS API layer (api/_lib). Vitest
// test files must live under src/, but may import from anywhere — esbuild
// handles the CJS interop, so we test the real templates that actually run.
import {
  inviteEmail,
  resendEmail,
  expiredReplacementEmail,
  acceptedNotificationEmail,
  article,
} from "../../../api/_lib/email-templates.js";
import {
  recentResendCount,
  canResendNow,
  effectiveInviteStatus,
  RESEND_MAX_PER_WINDOW,
} from "./service";
import { sendErrorText } from "./format";
import { InvitePublicSchema, InviteSchema } from "./schema";

const BASE_CTX = {
  firstName: "Liam",
  lastName: "Marriott",
  companyName: "bühl electrical",
  roleLabel: "apprentice",
  ctaUrl: "https://buhlos.com/phil/invite/TOKEN_abc123",
  expiresText: "This invite expires 11 Jun 2026",
  adminName: "Oskar Bühl",
  adminPhone: "0421 558 902",
};

const SECRETS = ["tokenHash", "passwordHash", "RESEND_API_KEY", "bcrypt"];

function assertNoSecrets(s: string) {
  for (const secret of SECRETS) expect(s.toLowerCase()).not.toContain(secret.toLowerCase());
}

/* ----------------------------------------------------------------------- */
/* Email templates E1–E4 (bible §07)                                        */
/* ----------------------------------------------------------------------- */

describe("E1 invite email", () => {
  const { subject, html, text } = inviteEmail(BASE_CTX);
  it("subject states what + who", () => {
    expect(subject).toBe("You're invited to Phil — bühl electrical");
  });
  it("uses a first-name greeting in plain text", () => {
    expect(text).toContain("G'day Liam,");
  });
  it("includes the CTA URL (with token) in BOTH html and text", () => {
    expect(html).toContain(BASE_CTX.ctaUrl);
    expect(text).toContain(BASE_CTX.ctaUrl);
  });
  it("shows expiry as information, and has one primary CTA", () => {
    expect(html).toContain("expires 11 Jun 2026");
    // Single "Set up Phil" call-to-action anchor.
    expect((html.match(/Set up Phil/g) || []).length).toBe(1);
  });
  it("renders role with the right article", () => {
    expect(html).toContain("as an apprentice");
  });
  it("leaks no secrets", () => {
    assertNoSecrets(html);
    assertNoSecrets(text);
  });
});

describe("E2 resend email", () => {
  const { subject, html, text } = resendEmail(BASE_CTX);
  it("is a reminder and makes clear it's a fresh link", () => {
    expect(subject).toContain("Reminder");
    expect(`${html} ${text}`.toLowerCase()).toContain("fresh link");
  });
  it("includes the CTA URL", () => {
    expect(html).toContain(BASE_CTX.ctaUrl);
    expect(text).toContain(BASE_CTX.ctaUrl);
  });
});

describe("E3 expired replacement email", () => {
  const { subject, html, text } = expiredReplacementEmail(BASE_CTX);
  it("states the previous link expired and offers a new one", () => {
    expect(subject).toContain("New invite");
    expect(`${html} ${text}`.toLowerCase()).toContain("expired");
  });
  it("includes the new CTA URL", () => {
    expect(html).toContain(BASE_CTX.ctaUrl);
  });
});

describe("E4 admin notification (built; triggered in O3)", () => {
  const { subject, html, text } = acceptedNotificationEmail({
    firstName: "Liam",
    lastName: "Marriott",
    timeText: "7:46am",
    jobText: "Magill Rd",
    buhlosUrl: "https://buhlos.com/employees",
    companyName: "bühl electrical",
  });
  it("addresses the admin that the worker is in", () => {
    expect(subject).toBe("Liam Marriott is in Phil");
    expect(text).toContain("set up Phil at 7:46am");
    expect(html).toContain("View in BuhlOS");
  });
});

describe("article helper", () => {
  it("picks a/an by leading vowel", () => {
    expect(article("apprentice")).toBe("an");
    expect(article("electrician")).toBe("an");
    expect(article("labourer")).toBe("a");
    expect(article("leading hand")).toBe("a");
  });
});

/* ----------------------------------------------------------------------- */
/* Resend rate limit (bible A8 / §10)                                       */
/* ----------------------------------------------------------------------- */

describe("resend rate limit", () => {
  const now = Date.parse("2026-05-29T12:00:00.000Z");
  const mins = (n: number) => new Date(now - n * 60_000).toISOString();
  it("counts resends within the last hour", () => {
    const ts = [mins(10), mins(30), mins(90)]; // 90m ago is outside the window
    expect(recentResendCount(ts, now)).toBe(2);
  });
  it("allows up to the limit, blocks the next", () => {
    const three = [mins(5), mins(15), mins(45)];
    expect(recentResendCount(three, now)).toBe(RESEND_MAX_PER_WINDOW);
    expect(canResendNow(three, now)).toBe(false);
    const two = [mins(5), mins(15)];
    expect(canResendNow(two, now)).toBe(true);
    expect(canResendNow(undefined, now)).toBe(true);
  });
});

/* ----------------------------------------------------------------------- */
/* Lazy expiry (bible A8 — no cron)                                         */
/* ----------------------------------------------------------------------- */

describe("effectiveInviteStatus (lazy expiry)", () => {
  const now = Date.parse("2026-05-29T00:00:00.000Z");
  it("flips a stale sent invite to expired", () => {
    expect(effectiveInviteStatus({ status: "sent", expiresAt: "2026-05-01T00:00:00.000Z" }, now)).toBe("expired");
    expect(effectiveInviteStatus({ status: "opened", expiresAt: "2026-05-01T00:00:00.000Z" }, now)).toBe("expired");
  });
  it("leaves a live invite alone", () => {
    expect(effectiveInviteStatus({ status: "sent", expiresAt: "2099-01-01T00:00:00.000Z" }, now)).toBe("sent");
  });
  it("never re-flips accepted / revoked / failed", () => {
    expect(effectiveInviteStatus({ status: "accepted", expiresAt: "2026-05-01T00:00:00.000Z" }, now)).toBe("accepted");
    expect(effectiveInviteStatus({ status: "revoked", expiresAt: "2026-05-01T00:00:00.000Z" }, now)).toBe("revoked");
    expect(effectiveInviteStatus({ status: "failed", expiresAt: "2026-05-01T00:00:00.000Z" }, now)).toBe("failed");
  });
});

/* ----------------------------------------------------------------------- */
/* Schema: delivery/sendError public; tokenHash/resendTimestamps server-only */
/* ----------------------------------------------------------------------- */

describe("invite schema O2 fields", () => {
  const publicInvite = {
    id: "i1",
    employeeId: "e1",
    email: "liam@x.com",
    status: "failed" as const,
    expiresAt: "2026-06-11T00:00:00.000Z",
    createdBy: "u_oskar",
    resentCount: 1,
    delivery: "email" as const,
    sendError: "provider_rejected",
  };
  it("public invite accepts delivery + sendError", () => {
    expect(InvitePublicSchema.safeParse(publicInvite).success).toBe(true);
  });
  it("stored invite carries tokenHash + resendTimestamps", () => {
    const stored = { ...publicInvite, tokenHash: "hash", resendTimestamps: ["2026-05-29T00:00:00.000Z"] };
    expect(InviteSchema.safeParse(stored).success).toBe(true);
  });
  it("send-error categories render friendly text", () => {
    expect(sendErrorText("provider_rejected")).toMatch(/rejected/);
    expect(sendErrorText("network_error")).toMatch(/reach/);
    expect(sendErrorText(undefined)).toMatch(/failed/);
  });
});
