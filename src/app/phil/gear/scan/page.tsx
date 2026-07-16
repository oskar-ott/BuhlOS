import { notFound, redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { isFlagEnabled } from "../../../../../api/_lib/feature-flags.js";
import { PhilShell } from "@/components/phil/PhilShell";
import { PhilPageIntro } from "@/components/phil/ui/PhilPageIntro";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { PhilBackLink } from "@/components/phil/ui/PhilBackLink";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { isFieldRole, isLeadingHandRole } from "@/lib/auth/roles";
import { ScanInfoResponseSchema } from "@/domains/gear/schema";
import type { ScanInfoResponse } from "@/domains/gear/types";
import { assetScanPath, isLiveScanKind, parseScanQuery } from "@/domains/gear/scan-url";
import { GearScanClient } from "@/components/phil/GearScanClient";

export const dynamic = "force-dynamic";

/**
 * /phil/gear/scan?asset=<id> — #303 scan-to-claim landing page.
 *
 * This is where a printed QR label lands: the phone's native camera opens the
 * URL, the worker signs in if needed (the `?next=` round-trip), and this page
 * shows the scanned asset with the ONE right action for its state:
 *
 *   in-storage      → Claim (this is the new field write path)
 *   held-by-me      → Return / Got it / Damaged / Missing (the existing actions)
 *   held-by-other   → honest "held by <name>" + Request transfer (reuse #306)
 *   retired         → "no longer in service"
 *   unknown/damaged → "couldn't find that sticker" + manual-entry guidance
 *   client/admin    → read-only summary (they don't hold gear)
 *   logged-out      → redirect to /v2/login?next=… (resumes here after sign-in)
 *
 * The URL is SACRED — see docs/route-ownership.md §4 + src/domains/gear/scan-url.ts.
 * Reserved siblings (?location= / ?box=) are #275; this page recognises them
 * and shows an honest "not built yet" rather than crashing.
 */
export default async function GearScanPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const target = parseScanQuery(sp);

  // The URL the login flow returns to — the full scan URL, so sign-in resumes
  // exactly here. Rebuild it from the recognised target (never trust raw echo).
  const selfPath = target ? assetScanPath(target.id) : "/phil/gear/scan";

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(selfPath)}`);
  }
  if (!canAccessSurface(session.role, "phil")) {
    // Admins/office reach the register, not Phil. Send them to sign-in rather
    // than render a Phil shell for a non-field role (matches /phil/gear).
    redirect("/v2/login");
  }
  // #760: gear kill-switch — the whole surface 404s when the owner turns it off.
  if (!(await isFlagEnabled("gear", session))) {
    notFound();
  }

  const viewerId = session.userId ?? "";
  const canClaim = isFieldRole(session.role) || isLeadingHandRole(session.role);

  // Recognised-but-not-a-live-kind: #275's reserved location/box siblings.
  if (target && !isLiveScanKind(target.kind)) {
    return (
      <ScanShell viewerId={viewerId}>
        <PhilNotice tone="info" title="Not scannable yet" role="status">
          {target.kind === "location"
            ? "Van and warehouse check-in labels are coming. For now this only reads tool stickers."
            : "Shelf and bin labels are coming. For now this only reads tool stickers."}
        </PhilNotice>
      </ScanShell>
    );
  }

  // No recognised param at all — a non-BuhlOS QR, or a damaged/truncated sticker.
  if (!target) {
    return (
      <ScanShell viewerId={viewerId}>
        <PhilNotice tone="warning" title="Couldn’t read that sticker" role="alert">
          That QR doesn’t point to a tool in the register. If the sticker is
          scuffed, open <span className="font-medium">My gear</span> and ask the
          office to check the tool by its code.
        </PhilNotice>
      </ScanShell>
    );
  }

  const info = await loadScanInfo(raw, target.id);

  if (info === "not-found") {
    return (
      <ScanShell viewerId={viewerId}>
        <PhilNotice tone="warning" title="Not in the register" role="alert">
          No tool matches that sticker (id{" "}
          <span className="font-mono text-xs">{target.id}</span>). It may have been
          retired, or the code was mis-read. Ask the office if you’re unsure.
        </PhilNotice>
      </ScanShell>
    );
  }
  if (info === "error") {
    return (
      <ScanShell viewerId={viewerId}>
        <PhilNotice tone="danger" title="Couldn’t load that tool" role="alert">
          Something went wrong reading the register. Check your signal and try the
          sticker again.
        </PhilNotice>
      </ScanShell>
    );
  }

  return (
    <ScanShell viewerId={viewerId}>
      <GearScanClient asset={info.asset} canClaim={canClaim} viewerId={viewerId} />
    </ScanShell>
  );
}

function ScanShell({ children, viewerId }: { children: React.ReactNode; viewerId: string }) {
  return (
    <PhilShell title="Scanned tool" userId={viewerId}>
      <div className="space-y-4">
        <PhilBackLink href="/phil/gear">My gear</PhilBackLink>
        <PhilPageIntro
          title="Scanned tool"
          description="You scanned a tool sticker. Here’s what it is and what you can do with it."
        />
        {children}
      </div>
    </PhilShell>
  );
}

/** Load the summary-only scan-info for an asset. Returns a sentinel for the
 *  not-found / error paths so the page can render an honest state. */
async function loadScanInfo(
  cookieValue: string | undefined,
  assetId: string,
): Promise<ScanInfoResponse | "not-found" | "error"> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(`${base}/api/assets?action=scan-info`, {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        ...(cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : {}),
      },
      body: JSON.stringify({ assetId }),
    });
    if (res.status === 404) return "not-found";
    if (!res.ok) return "error";
    const parsed = ScanInfoResponseSchema.safeParse(await res.json());
    if (!parsed.success) return "error";
    return parsed.data;
  } catch {
    return "error";
  }
}
