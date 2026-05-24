import type { ReactNode } from "react";

/**
 * Layout segment for the new Phil surface at /phil/* (Phase B).
 *
 * Phase B mounts /phil/my-day and /phil/hours here. Legacy /phil and
 * /phil/app continue to be served by vercel.json rewrites to phil.html;
 * Next.js only owns the sub-paths that aren't claimed.
 *
 * Per docs/rebuild-audit/19-phase-b-hours-implementation-brief.md the new
 * Phil home becomes /phil/my-day. Route cutover (so that /phil also serves
 * the new shell) happens at the start of Phase C.
 */
export default function PhilSurfaceLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
