import type { Metadata } from "next";
import { headers } from "next/headers";
import { SignupResolveResponseSchema } from "@/domains/employees/signup";
import type { SignupResolveResponse } from "@/domains/employees/signup";
import { SignupFlow } from "@/components/onboarding/SignupFlow";

export const metadata: Metadata = {
  title: "Join the crew · BuhlOS",
  description: "Sign yourself up — your details, your PIN, and the office approves you.",
};

export const dynamic = "force-dynamic";

/**
 * /onboarding/[code] — the crew sign-up link (build-first slice).
 *
 * PUBLIC route (no session — the worker has no account yet), same pattern as
 * /phil/invite/[token]: the code is resolved server-side before render so
 * there's no flicker between valid and dead states. Unlike an invite, this
 * link is deliberately shareable — a submission only creates a PENDING
 * request; the admin approval gate on /employees is the security boundary.
 */
export default async function SignupPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const resolved = await resolveCode(code);
  return <SignupFlow code={code} state={resolved.state} link={resolved.link} />;
}

async function resolveCode(code: string): Promise<SignupResolveResponse> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(`${base}/api/signup?action=resolve&code=${encodeURIComponent(code)}`, {
      cache: "no-store",
    });
    if (!res.ok) return { state: "invalid", link: null };
    const parsed = SignupResolveResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { state: "invalid", link: null };
    return parsed.data;
  } catch {
    // API/Blob unreachable (e.g. local next dev) — fail safe to an honest
    // "not valid" state rather than crashing the public page.
    return { state: "invalid", link: null };
  }
}
