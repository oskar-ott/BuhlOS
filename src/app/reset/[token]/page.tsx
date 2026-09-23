import type { Metadata } from "next";
import { headers } from "next/headers";
import {
  PinResetResolveResponseSchema,
  type PinResetState,
} from "@/domains/auth/pin-reset";
import { PinResetLanding } from "@/components/auth/PinResetScreens";
import { OFFICE_PHONE } from "@/domains/auth/office-contact";

export const metadata: Metadata = {
  title: "Set a new PIN · BuhlOS",
  description: "Set a new BuhlOS PIN from your reset link.",
};

export const dynamic = "force-dynamic";

/**
 * /reset/[token] — set a new PIN from an emailed one-time link.
 *
 * PUBLIC route (the whole point is that they can't sign in). The token is
 * resolved server-side before render so there's no valid→error flicker, and a
 * dead link never renders a form that would only fail — the invite landing's
 * precedent (/phil/invite/[token]).
 *
 * The server only ever receives the safe projection from /api/pin-reset: a
 * state, and on a VALID token a first name for the greeting. Never the hash,
 * never another account's data.
 */
export default async function PinResetPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const resolved = await resolveToken(token);
  return (
    <PinResetLanding
      token={token}
      state={resolved.state}
      firstName={resolved.firstName}
      isPassword={resolved.isPassword}
      officePhone={OFFICE_PHONE}
    />
  );
}

async function resolveToken(token: string): Promise<{
  state: PinResetState;
  firstName?: string | null;
  isPassword?: boolean;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(
      `${base}/api/pin-reset?action=resolve&token=${encodeURIComponent(token)}`,
      { cache: "no-store" }
    );
    if (!res.ok) return { state: "invalid" };
    const parsed = PinResetResolveResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { state: "invalid" };
    return {
      state: parsed.data.state,
      firstName: parsed.data.firstName ?? null,
      isPassword: parsed.data.isPassword ?? false,
    };
  } catch {
    // API/Blob unreachable — fail safe to an honest dead end rather than
    // crashing a public page (the invite page's rationale).
    return { state: "invalid" };
  }
}
