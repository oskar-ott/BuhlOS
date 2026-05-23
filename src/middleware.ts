import { NextResponse, type NextRequest } from "next/server";
import { decodeSessionCookie, SESSION_COOKIE } from "@/lib/auth/session";
import { canAccessSurface, type Surface } from "@/lib/auth/permissions";
import { landingFor } from "@/lib/auth/landing";

/**
 * Phase A route gating.
 *
 * Only the new surfaces are gated here. Legacy URLs (/login, /admin/*, /phil,
 * /my-day, /lh, /client, ...) are owned by vercel.json rewrites and never
 * reach Next.js middleware in production.
 *
 * Gates:
 *   /command-centre     → admin roles only
 *   /v2/phil            → field roles or leading hands
 *   /v2/login           → always public
 *   /                   → not gated; src/app/page.tsx decides at render time
 */

const PROTECTED: ReadonlyArray<{ prefix: string; surface: Surface }> = [
  { prefix: "/command-centre", surface: "admin" },
  { prefix: "/v2/phil", surface: "phil" },
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // /v2/login is always reachable.
  if (pathname === "/v2/login" || pathname.startsWith("/v2/login/")) {
    return NextResponse.next();
  }

  const gate = PROTECTED.find(
    (g) => pathname === g.prefix || pathname.startsWith(`${g.prefix}/`)
  );
  if (!gate) return NextResponse.next();

  const cookie = req.cookies.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(cookie);

  if (!session?.role) {
    const url = req.nextUrl.clone();
    url.pathname = "/v2/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (!canAccessSurface(session.role, gate.surface)) {
    const url = req.nextUrl.clone();
    url.pathname = landingFor(session.role);
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Match only the new surfaces. Legacy paths and static assets are excluded.
  matcher: ["/command-centre/:path*", "/v2/phil/:path*"],
};
