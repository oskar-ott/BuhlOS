import { redirect } from "next/navigation";
import type { Route } from "next";
import { getCurrentUser } from "@/lib/auth/current-user";
import { landingFor } from "@/lib/auth/landing";

/**
 * Root entry — `/` is owned by Next.js since the legacy-interface cutover
 * (the old vercel.json rewrite of `/` → /login.html is gone).
 *
 * Behaviour: if the user has a valid session, send them to their landing.
 * If not, send them to /v2/login.
 *
 * The `as Route` cast is intentional: landingFor() may return /client, which
 * is the kept client-portal static page (vercel.json rewrite, not a Next.js
 * route) and therefore not known to typedRoutes. The cast goes away when the
 * modern client portal lands (issue #271 / Epic 16).
 */
export default async function RootPage({
  searchParams,
}: {
  searchParams: Promise<{ synced?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user?.role) redirect("/v2/login");
  // Back from a role-change sync (src/lib/auth/role-sync.ts): carry the marker
  // to the landing page so it doesn't send the browser straight back.
  const { synced } = await searchParams;
  redirect(`${landingFor(user.role)}${synced === "1" ? "?synced=1" : ""}` as Route);
}
