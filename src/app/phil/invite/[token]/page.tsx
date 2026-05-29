import type { Metadata } from "next";
import { headers } from "next/headers";
import { ResolveInviteResponseSchema } from "@/domains/employees/schema";
import type { ResolvedInvite, InviteResolveState } from "@/domains/employees/types";
import { PhilInviteLanding } from "@/components/phil/PhilInviteLanding";

export const metadata: Metadata = {
  title: "Set up Phil",
  description: "Set up Phil — confirm your details and create a PIN.",
};

export const dynamic = "force-dynamic";

/**
 * /phil/invite/[token] — the first screen a Phil worker ever sees (bible P1).
 *
 * PUBLIC route (no session — the worker has no account yet). The token is
 * resolved server-side before render, so there's no flicker between valid and
 * error states (bible P1 acceptance). On valid, the client flow takes over for
 * confirm → PIN → intro → accept; on any error, an honest state is shown.
 *
 * The server only ever receives the safe projection from /api/invites — never
 * the token hash or other employees' data.
 */
export default async function PhilInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const { state, invite } = await resolveToken(token);
  return <PhilInviteLanding token={token} state={state} invite={invite} />;
}

async function resolveToken(
  token: string
): Promise<{ state: InviteResolveState; invite: ResolvedInvite | null }> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(
      `${base}/api/invites?action=resolve&token=${encodeURIComponent(token)}`,
      { cache: "no-store" }
    );
    if (!res.ok) return { state: "invalid", invite: null };
    const parsed = ResolveInviteResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { state: "invalid", invite: null };
    return { state: parsed.data.state, invite: parsed.data.invite ?? null };
  } catch {
    // API/Blob unreachable (e.g. local next dev) — fail safe to an honest
    // "not valid" state rather than crashing the public page.
    return { state: "invalid", invite: null };
  }
}
