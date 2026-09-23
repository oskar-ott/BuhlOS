import type { Metadata } from "next";
import { isEmailConfigured } from "../../../api/_lib/email.js";
import { PinResetRequestScreen } from "@/components/auth/PinResetScreens";
import { OFFICE_PHONE } from "@/domains/auth/office-contact";

export const metadata: Metadata = {
  title: "Reset your PIN · BuhlOS",
  description: "Send yourself a link to set a new BuhlOS PIN.",
};

export const dynamic = "force-dynamic";

/**
 * /reset — "Forgotten your PIN?" (owner pull 2026-09-14).
 *
 * PUBLIC route: whoever lands here is locked out, so there is no session to
 * read. The form only asks for an email; the server decides (silently) whether
 * an account matches and mails a one-time link — see api/pin-reset.js.
 *
 * Email wiring is resolved HERE, server-side, so a deployment without a mail
 * provider shows the office phone instead of a button that could never deliver
 * (P7 — no dead ends).
 */
export default function PinResetRequestPage() {
  return (
    <PinResetRequestScreen emailConfigured={isEmailConfigured()} officePhone={OFFICE_PHONE} />
  );
}
