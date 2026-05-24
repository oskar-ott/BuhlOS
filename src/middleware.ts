import { NextResponse, type NextRequest } from "next/server";
import { decodeSessionCookie, SESSION_COOKIE } from "@/lib/auth/session";
import { canAccessSurface, type Surface } from "@/lib/auth/permissions";
import { landingFor } from "@/lib/auth/landing";

/**
 * Phase A + B + C + D1 route gating.
 *
 * Only the new surfaces are gated here. Legacy URLs (/login, /admin/*, /phil,
 * /my-day, /my-gear, /lh, /client, ...) are owned by vercel.json rewrites and
 * never reach Next.js middleware in production.
 *
 * Gates:
 *   /command-centre        → admin roles only       (Phase A)
 *   /hours/*               → admin roles only       (Phase B — admin queue)
 *   /gear/*                → admin roles only       (Phase C — admin register)
 *   /v2/phil               → field roles or LH      (Phase A)
 *   /phil/my-day, /phil/hours, /phil/gear, /phil/jobs → field roles or LH
 *                                                       (Phase B + C + D1)
 *   /v2/login              → always public
 *   /                      → not gated; src/app/page.tsx decides at render time
 */

const PROTECTED: ReadonlyArray<{ prefix: string; surface: Surface }> = [
  { prefix: "/command-centre", surface: "admin" },
  { prefix: "/hours", surface: "admin" },
  { prefix: "/gear", surface: "admin" },
  { prefix: "/v2/phil", surface: "phil" },
  { prefix: "/phil/my-day", surface: "phil" },
  { prefix: "/phil/hours", surface: "phil" },
  { prefix: "/phil/gear", surface: "phil" },
  { prefix: "/phil/jobs", surface: "phil" },
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // /v2/login is always reachable.
  if (pathname === "/v2/login" || pathname.startsWith("/v2/login/")) {
    return NextResponse.next();
  }

  const gate = PROTECTED.find((g) => pathname === g.prefix || pathname.startsWith(`${g.prefix}/`));
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
  // /phil/* is gated only on the sub-paths Next.js actually owns (/phil/my-day,
  // /phil/hours, /phil/gear, /phil/jobs) — vercel.json continues to rewrite
  // /phil, /phil/app and /phil/login to the legacy phil.html and login.html.
  matcher: [
    "/command-centre/:path*",
    "/hours/:path*",
    "/gear/:path*",
    "/v2/phil/:path*",
    "/phil/my-day/:path*",
    "/phil/hours/:path*",
    "/phil/gear/:path*",
    "/phil/jobs/:path*",
  ],
};
