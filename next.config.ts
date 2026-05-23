import type { NextConfig } from "next";

/**
 * Phase A — additive Next.js app alongside the legacy public/*.html surface.
 *
 * Critical invariants this config must preserve:
 *   • vercel.json owns the legacy URL routing (/, /login, /admin/*, /phil, etc.)
 *     and runs BEFORE Next.js. Routes Next.js mounts on must NOT collide.
 *   • The new app's canonical URLs are /command-centre, /v2/login, /v2/phil —
 *     none of which appear in vercel.json rewrites.
 *   • Image domain whitelisting: legacy Blob assets are served from
 *     *.public.blob.vercel-storage.com.
 *
 * See: docs/rebuild-audit/08-next-claude-code-prompt.md
 *      docs/architecture/01-target-rebuild-structure.md
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.public.blob.vercel-storage.com",
      },
    ],
  },
  // We do NOT add Next.js rewrites in Phase A. vercel.json continues to own
  // legacy routes. New surfaces mount on their own paths and serve directly.
};

export default nextConfig;
